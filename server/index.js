// API and static server for the registry.
// The same code runs as two Railway services against one Postgres:
//   APP=holder  the public interest registry, shared by every approved issuer
//   APP=issuer  the issuer console: issuer accounts, each seeing only its own bonds

import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ISSUERS, BONDS, ASSIGNMENTS, PASSKEYS, EVENTS } from "./seed.js";

const APP = process.env.APP === "issuer" ? "issuer" : "holder";
const PORT = Number(process.env.PORT) || 3000;
const PEPPER = process.env.PASSKEY_PEPPER || "";
const MAX_ATTEMPTS = 5;
const SESSION_DAYS = 7;
const INVITE_DAYS = 7;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : false,
});

const TERMINAL = ["Redeemed", "Superseded", "Cancelled"];
// Never stored in the record itself: credential state lives in its own table.
const SECRET_KEYS = ["passkey", "credLocked", "hasPasskey", "attempts"];
// Contact details and mail numbers stay out of the public holder portal.
const HOLDER_HIDDEN = ["address", "instrumentMail", "passkeyMail", "requestedContact"];
// Issuer codes that would be confusing or are kept for the platform.
const RESERVED_CODES = ["ADMIN", "TEST", "DEMO", "NULL", "ROOT", "SYSTEM"];
// Issuers whose records the public registry shows. A suspended issuer's history stays verifiable.
const PUBLIC_STATUSES = ["approved", "suspended"];

/* ---------------- schema and seed ---------------- */

async function migrate() {
  const c = await pool.connect();
  try {
    // Both services start together; one migrates while the other waits.
    await c.query("select pg_advisory_lock(424242)");
    await c.query(`
      create table if not exists meta (k text primary key, version bigint not null);
      create table if not exists bonds (id text primary key, data jsonb not null);
      create table if not exists assignments (
        id text primary key, bond text not null, data jsonb not null,
        created_at timestamptz not null default clock_timestamp());
      create table if not exists credentials (
        id text primary key, salt text not null, hash text not null,
        attempts int not null default 0, locked boolean not null default false,
        updated_at timestamptz not null default now());
      create table if not exists events (
        seq bigserial primary key, eid text unique not null, bond text, assignment text,
        data jsonb not null, created_at timestamptz not null default now());
      create or replace function events_append_only() returns trigger language plpgsql as
        $$ begin raise exception 'events are append-only'; end $$;
      drop trigger if exists events_no_change on events;
      create trigger events_no_change before update or delete on events
        for each row execute function events_append_only();

      create table if not exists issuers (
        id text primary key, code text unique not null, legal_name text not null,
        status text not null default 'pending', created_at timestamptz not null default now(),
        reviewed_at timestamptz);
      create table if not exists users (
        id text primary key, email text unique not null, name text not null,
        pw_salt text not null, pw_hash text not null, is_admin boolean not null default false,
        created_at timestamptz not null default now());
      create table if not exists memberships (
        user_id text not null references users(id) on delete cascade,
        issuer_id text not null references issuers(id) on delete cascade,
        role text not null, created_at timestamptz not null default now(),
        primary key (user_id, issuer_id));
      create table if not exists invites (
        code_hash text primary key, issuer_id text not null references issuers(id) on delete cascade,
        created_by text not null, created_at timestamptz not null default now(),
        expires_at timestamptz not null, used_by text);
      create table if not exists sessions (
        token_hash text primary key, user_id text not null references users(id) on delete cascade,
        created_at timestamptz not null default now(), expires_at timestamptz not null);
      alter table bonds add column if not exists issuer_id text;
    `);
    const { rows } = await c.query("select version from meta where k = 'v'");
    if (rows.length === 0) await seed(c, 1);
    // A register from before issuer accounts belongs to the sample issuer.
    const orphans = await c.query("select count(*)::int as n from bonds where issuer_id is null");
    if (orphans.rows[0].n > 0) {
      await insertIssuers(c);
      await c.query("update bonds set issuer_id = $1 where issuer_id is null", [ISSUERS[0].id]);
      console.log(`Assigned ${orphans.rows[0].n} existing bonds to issuer ${ISSUERS[0].code}`);
    }
  } finally {
    await c.query("select pg_advisory_unlock(424242)").catch(() => {});
    c.release();
  }
}

async function insertIssuers(c) {
  for (const i of ISSUERS)
    await c.query(
      `insert into issuers (id, code, legal_name, status, reviewed_at) values ($1, $2, $3, $4, now())
       on conflict (id) do nothing`, [i.id, i.code, i.legalName, i.status]);
}

async function seed(c, version) {
  await insertIssuers(c);
  for (const b of BONDS)
    await c.query("insert into bonds (id, data, issuer_id) values ($1, $2, $3)", [b.id, b, b.issuerId]);
  for (const a of ASSIGNMENTS)
    await c.query("insert into assignments (id, bond, data) values ($1, $2, $3)", [a.id, a.bond, a]);
  for (const [id, key] of Object.entries(PASSKEYS)) await setPasskey(c, id, key);
  for (const e of EVENTS)
    await c.query("insert into events (eid, bond, assignment, data) values ($1, $2, $3, $4)",
      [crypto.randomUUID(), e.bond, e.id, e]);
  await c.query("insert into meta (k, version) values ('v', $1)", [version]);
}

/* ---------------- passkeys and passwords ---------------- */

const normKey = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashKey = (key, salt) => crypto.scryptSync(normKey(key) + PEPPER, salt, 32).toString("hex");
const scrypt = promisify(crypto.scrypt);
const hashPassword = async (pw, salt) => (await scrypt(String(pw), salt, 64)).toString("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sameHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const newId = (prefix) => prefix + "_" + crypto.randomBytes(9).toString("base64url");

async function setPasskey(c, id, key) {
  const salt = crypto.randomBytes(16).toString("hex");
  await c.query(
    `insert into credentials (id, salt, hash) values ($1, $2, $3)
     on conflict (id) do update set salt = $2, hash = $3, attempts = 0, locked = false, updated_at = now()`,
    [id, salt, hashKey(key, salt)]);
}

/* ---------------- relayer scope ----------------
   The holder portal stands in for the relayer: it may only make the
   holder-initiated transitions in the spec. Everything else is the issuer's. */

const RELAYER_MOVES = {
  Issued: ["Accepted"],
  AwaitingCredential: ["CredentialRequested", "Cancelled"],
  Accepted: ["Locked", "PendingRedemption", "Superseded"],
  Locked: ["Superseded"],
};

function relayerAllows(before, after) {
  if (!before) return after.origin === "AssignOut" && after.status === "AwaitingCredential";
  if (before.status === after.status) return true;
  return (RELAYER_MOVES[before.status] || []).includes(after.status);
}

/* ---------------- app ---------------- */

class Reject extends Error { constructor(status, message) { super(message); this.status = status; } }

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.disable("x-powered-by");

const version = async (c) => Number((await c.query("select version from meta where k = 'v'")).rows[0].version);
const bump = (c) => c.query("update meta set version = version + 1 where k = 'v' returning version")
  .then((r) => Number(r.rows[0].version));

// Per-IP limit for anything that checks a secret.
const hits = new Map();
const limited = (key, max = 20) => {
  const now = Date.now(), h = hits.get(key) || { n: 0, t: now };
  if (now - h.t > 60_000) { h.n = 0; h.t = now; }
  h.n++; hits.set(key, h);
  return h.n > max;
};

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof Reject) return res.status(e.status).json({ error: e.message });
    next(e);
  }
};

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally { c.release(); }
}

/* Reads the register for a set of bonds. The holder portal hides contact details. */
async function readState(bondFilter, params) {
  const [bonds, regs, creds, events] = await Promise.all([
    pool.query(`select data, issuer_id from bonds b where ${bondFilter} order by id`, params),
    pool.query(`select a.data from assignments a join bonds b on b.id = a.bond where ${bondFilter} order by a.created_at, a.id`, params),
    pool.query(`select k.id, k.locked from credentials k join assignments a on a.id = k.id join bonds b on b.id = a.bond where ${bondFilter}`, params),
    pool.query(`select e.eid, e.data from events e join bonds b on b.id = e.bond where ${bondFilter} order by e.seq desc`, params),
  ]);
  const cred = new Map(creds.rows.map((r) => [r.id, r]));
  return {
    bonds: bonds.rows.map((r) => ({ ...r.data, issuerId: r.issuer_id })),
    reg: regs.rows.map(({ data }) => {
      const out = { ...data, hasPasskey: cred.has(data.id), credLocked: cred.get(data.id)?.locked || false };
      if (APP === "holder") for (const k of HOLDER_HIDDEN) delete out[k];
      return out;
    }),
    events: events.rows.map((r) => ({ ...r.data, eid: r.eid })),
  };
}

/* Saves one commit after the caller's own checks; enforces the units rule for the bonds given. */
async function applyCommit(c, { bonds, reg, events, issuerId }) {
  for (const b of bonds)
    await c.query(
      "insert into bonds (id, data, issuer_id) values ($1, $2, $3) on conflict (id) do update set data = $2",
      [b.id, stripBond(b), issuerId ?? b.issuerId]);
  for (const a of reg)
    // Merge, so fields one app doesn't see are never wiped by the other.
    await c.query(
      `insert into assignments (id, bond, data) values ($1, $2, $3)
       on conflict (id) do update set data = assignments.data || excluded.data`,
      [a.id, a.bond, a]);
  for (const e of events) {
    const { eid, ...data } = e;
    await c.query(
      "insert into events (eid, bond, assignment, data) values ($1, $2, $3, $4) on conflict (eid) do nothing",
      [eid, data.bond, data.id, data]);
  }

  // Units rule, per bond: prior + live + unassigned + redeemed = total.
  const touched = [...new Set([...bonds.map((b) => b.id), ...reg.map((a) => a.bond)])];
  if (!touched.length) return;
  const check = await c.query(`
    select b.id,
      (b.data->>'total')::numeric as total,
      (b.data->>'unassigned')::numeric + (b.data->>'redeemed')::numeric
        + coalesce((select sum((p->>'units')::numeric) from jsonb_array_elements(b.data->'prior') p
                    where coalesce((p->>'reversed')::boolean, false) = false), 0)
        + coalesce((select sum((a.data->>'units')::numeric) from assignments a
                    where a.bond = b.id and a.data->>'status' not in ('Redeemed','Superseded','Cancelled')), 0) as counted
    from bonds b where b.id = any($1)`, [touched]);
  const bad = check.rows.find((r) => Number(r.total) !== Number(r.counted));
  if (bad) throw new Reject(422, bad.id + " would no longer add up to its total. Nothing was saved.");
}

const stripBond = (b) => { const { issuerId, ...rest } = b; return rest; };

function cleanRecord(raw) {
  const a = { ...raw };
  for (const k of SECRET_KEYS) delete a[k];
  return a;
}

async function lockVersion(c, base) {
  const v = Number((await c.query("select version from meta where k = 'v' for update")).rows[0].version);
  if (v !== Number(base)) throw new Reject(409, "The register changed since you loaded it.");
}

/* ======================= holder portal ======================= */

if (APP === "holder") {
  app.get("/api/state", wrap(async (req, res) => {
    const v = await version(pool);
    if (req.query.since && Number(req.query.since) === v) return res.json({ version: v, unchanged: true });
    const filter = "b.issuer_id in (select id from issuers where status = any($1))";
    const [state, issuers] = await Promise.all([
      readState(filter, [PUBLIC_STATUSES]),
      pool.query("select id, code, legal_name, status from issuers where status = any($1) order by code", [PUBLIC_STATUSES]),
    ]);
    res.json({ version: v, ...state,
      issuers: issuers.rows.map((i) => ({ id: i.id, code: i.code, legalName: i.legal_name, status: i.status })) });
  }));

  app.post("/api/commit", wrap(async (req, res) => {
    const { base, bonds = [], reg = [], events = [] } = req.body || {};
    if (bonds.length) throw new Reject(403, "The holder portal cannot change bonds.");
    const nv = await tx(async (c) => {
      await lockVersion(c, base);
      const clean = [];
      for (const raw of reg) {
        const a = cleanRecord(raw);
        for (const k of HOLDER_HIDDEN) if (!(k in raw) || raw[k] === undefined) delete a[k];
        const owner = (await c.query(
          "select i.status from bonds b join issuers i on i.id = b.issuer_id where b.id = $1", [a.bond])).rows[0];
        if (!owner || owner.status !== "approved")
          throw new Reject(403, "This bond's issuer is not accepting changes right now.");
        const before = (await c.query("select data from assignments where id = $1", [a.id])).rows[0]?.data;
        if (before && before.bond !== a.bond) throw new Reject(403, "A record can't move to another bond.");
        if (before && TERMINAL.includes(before.status))
          throw new Reject(422, a.id + " is " + before.status + " and cannot be changed.");
        if (!relayerAllows(before, a))
          throw new Reject(403, "The holder portal can't move " + a.id + " from " + (before?.status || "nothing") + " to " + a.status + ".");
        clean.push(a);
      }
      const bondsOk = new Set(clean.map((a) => a.bond));
      for (const e of events) if (!bondsOk.has(e.bond)) throw new Reject(403, "An event must belong to a record being saved.");
      await applyCommit(c, { bonds: [], reg: clean, events });
      return bump(c);
    });
    res.json({ version: nv });
  }));

  app.post("/api/holder/signin", wrap(async (req, res) => {
    if (limited("signin:" + req.ip)) return res.status(429).json({ ok: false, code: "rate", error: "Too many attempts. Wait a minute and try again." });
    const { id, passkey } = req.body || {};
    const out = await tx(async (c) => {
      const cred = (await c.query("select * from credentials where id = $1 for update", [id])).rows[0];
      if (!cred) return { ok: false, code: "nokey" };
      if (cred.locked) return { ok: false, code: "locked" };
      if (sameHex(hashKey(passkey, cred.salt), cred.hash)) {
        if (cred.attempts > 0) await c.query("update credentials set attempts = 0 where id = $1", [id]);
        return { ok: true };
      }
      const attempts = cred.attempts + 1, locked = attempts >= MAX_ATTEMPTS;
      await c.query("update credentials set attempts = $2, locked = $3, updated_at = now() where id = $1", [id, attempts, locked]);
      if (locked) await bump(c); // the issuer's queue needs to see the lockout
      return { ok: false, code: locked ? "locked" : "mismatch", left: MAX_ATTEMPTS - attempts };
    });
    res.json(out);
  }));
}

/* ======================= issuer console ======================= */

if (APP === "issuer") {
  const COOKIE = "registrar_session";

  // Cross-site POSTs are refused outright, on top of the SameSite cookie.
  app.use("/api", (req, res, next) => {
    if (req.method === "GET") return next();
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: "Cross-site request refused." }); }
      catch { return res.status(403).json({ error: "Cross-site request refused." }); }
    }
    next();
  });

  const readCookie = (req) => {
    const m = (req.headers.cookie || "").split(/;\s*/).find((p) => p.startsWith(COOKIE + "="));
    return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : null;
  };
  const setCookie = (req, res, token, maxAge) => {
    const secure = req.secure ? "; Secure" : "";
    res.set("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
  };

  async function startSession(req, res, c, userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    await c.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + $3::interval)",
      [sha256(token), userId, SESSION_DAYS + " days"]);
    setCookie(req, res, token, SESSION_DAYS * 86400);
  }

  async function currentUser(req) {
    const token = readCookie(req);
    if (!token) return null;
    const r = await pool.query(
      `select u.id, u.email, u.name, u.is_admin from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
    return r.rows[0] || null;
  }

  const needUser = async (req) => {
    const u = await currentUser(req);
    if (!u) throw new Reject(401, "Please sign in.");
    return u;
  };

  // The caller's membership in the issuer named by the request; refuses if there is none.
  async function membership(req, issuerId) {
    const u = await needUser(req);
    const r = await pool.query(
      `select m.role, i.id, i.code, i.legal_name, i.status from memberships m join issuers i on i.id = m.issuer_id
       where m.user_id = $1 and m.issuer_id = $2`, [u.id, issuerId]);
    if (!r.rows[0]) throw new Reject(403, "You don't have access to this issuer.");
    return { user: u, ...r.rows[0] };
  }

  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");
  const cleanEmail = (e) => String(e || "").trim().toLowerCase();
  function checkPassword(pw) {
    if (String(pw || "").length < 10) throw new Reject(400, "Use a password of at least 10 characters.");
  }

  async function createUser(c, { email, name, password, isAdmin = false }) {
    if (!validEmail(email)) throw new Reject(400, "Enter a valid email address.");
    if (!String(name || "").trim()) throw new Reject(400, "Enter your name.");
    checkPassword(password);
    const taken = await c.query("select 1 from users where email = $1", [email]);
    if (taken.rows.length) throw new Reject(409, "An account with that email already exists. Sign in instead.");
    const id = newId("usr"), salt = crypto.randomBytes(16).toString("hex");
    await c.query("insert into users (id, email, name, pw_salt, pw_hash, is_admin) values ($1, $2, $3, $4, $5, $6)",
      [id, email, String(name).trim(), salt, await hashPassword(password, salt), isAdmin]);
    return id;
  }

  /* ---- accounts ---- */

  app.get("/api/auth/me", wrap(async (req, res) => {
    const needsSetup = (await pool.query("select 1 from users where is_admin limit 1")).rows.length === 0;
    const u = await currentUser(req);
    if (!u) return res.json({ user: null, issuers: [], needsSetup });
    const iss = await pool.query(
      `select i.id, i.code, i.legal_name, i.status, m.role from memberships m join issuers i on i.id = m.issuer_id
       where m.user_id = $1 order by i.code`, [u.id]);
    res.json({
      user: { id: u.id, email: u.email, name: u.name, isAdmin: u.is_admin },
      issuers: iss.rows.map((i) => ({ id: i.id, code: i.code, legalName: i.legal_name, status: i.status, role: i.role })),
      needsSetup,
    });
  }));

  // One-time creation of the platform owner, with the setup code set on the service.
  app.post("/api/auth/setup", wrap(async (req, res) => {
    if (limited("setup:" + req.ip, 10)) throw new Reject(429, "Too many attempts. Wait a minute and try again.");
    const want = process.env.ADMIN_SETUP_CODE || "";
    const { setupCode, name, password } = req.body || {};
    const email = cleanEmail(req.body?.email);
    if (!want) throw new Reject(503, "ADMIN_SETUP_CODE is not set on this service.");
    if (!sameHex(sha256(String(setupCode || "")), sha256(want))) throw new Reject(403, "That setup code is not right.");
    await tx(async (c) => {
      await c.query("select pg_advisory_xact_lock(424243)");
      if ((await c.query("select 1 from users where is_admin limit 1")).rows.length)
        throw new Reject(409, "The platform owner account already exists. Sign in instead.");
      const id = await createUser(c, { email, name, password, isAdmin: true });
      // The owner takes over any issuer nobody belongs to yet, such as the sample register.
      await c.query(
        `insert into memberships (user_id, issuer_id, role)
         select $1, i.id, 'owner' from issuers i where not exists (select 1 from memberships m where m.issuer_id = i.id)`, [id]);
      await startSession(req, res, c, id);
    });
    res.json({ ok: true });
  }));

  // New issuer account (pending until the platform owner approves it), or joining one with an invite code.
  app.post("/api/auth/signup", wrap(async (req, res) => {
    if (limited("signup:" + req.ip, 10)) throw new Reject(429, "Too many attempts. Wait a minute and try again.");
    const { name, password, inviteCode } = req.body || {};
    const email = cleanEmail(req.body?.email);
    await tx(async (c) => {
      if (inviteCode) {
        const inv = (await c.query(
          "select * from invites where code_hash = $1 for update", [sha256(normKey(inviteCode))])).rows[0];
        if (!inv || inv.used_by || new Date(inv.expires_at) < new Date())
          throw new Reject(400, "That invite code isn't valid. Ask your issuer's owner for a new one.");
        const id = await createUser(c, { email, name, password });
        await c.query("insert into memberships (user_id, issuer_id, role) values ($1, $2, 'member')", [id, inv.issuer_id]);
        await c.query("update invites set used_by = $1 where code_hash = $2", [id, inv.code_hash]);
        await startSession(req, res, c, id);
        return;
      }
      const code = String(req.body?.issuerCode || "").trim().toUpperCase();
      const legalName = String(req.body?.legalName || "").trim();
      if (!/^[A-Z0-9]{3,6}$/.test(code)) throw new Reject(400, "Use 3 to 6 letters or digits for the issuer code.");
      if (RESERVED_CODES.includes(code)) throw new Reject(400, code + " is reserved. Choose another issuer code.");
      if (legalName.length < 2) throw new Reject(400, "Enter the issuer's legal name.");
      if ((await c.query("select 1 from issuers where code = $1", [code])).rows.length)
        throw new Reject(409, "The issuer code " + code + " is taken. Choose another.");
      const id = await createUser(c, { email, name, password });
      const issuerId = newId("iss");
      await c.query("insert into issuers (id, code, legal_name) values ($1, $2, $3)", [issuerId, code, legalName]);
      await c.query("insert into memberships (user_id, issuer_id, role) values ($1, $2, 'owner')", [id, issuerId]);
      await startSession(req, res, c, id);
    });
    res.json({ ok: true });
  }));

  app.post("/api/auth/login", wrap(async (req, res) => {
    if (limited("login:" + req.ip)) throw new Reject(429, "Too many attempts. Wait a minute and try again.");
    const email = cleanEmail(req.body?.email);
    const u = (await pool.query("select * from users where email = $1", [email])).rows[0];
    // Same work and same answer whether or not the account exists.
    const salt = u?.pw_salt || "0".repeat(32);
    const h = await hashPassword(req.body?.password || "", salt);
    if (!u || !sameHex(h, u.pw_hash)) throw new Reject(401, "That email and password don't match.");
    await tx((c) => startSession(req, res, c, u.id));
    res.json({ ok: true });
  }));

  app.post("/api/auth/logout", wrap(async (req, res) => {
    const token = readCookie(req);
    if (token) await pool.query("delete from sessions where token_hash = $1", [sha256(token)]);
    setCookie(req, res, "", 0);
    res.json({ ok: true });
  }));

  /* ---- team ---- */

  app.get("/api/team", wrap(async (req, res) => {
    const m = await membership(req, req.query.issuer);
    const r = await pool.query(
      `select u.name, u.email, m.role, m.created_at from memberships m join users u on u.id = m.user_id
       where m.issuer_id = $1 order by m.created_at`, [m.id]);
    res.json({ members: r.rows.map((x) => ({ name: x.name, email: x.email, role: x.role })) });
  }));

  // The code is shown once; only its hash is kept.
  app.post("/api/team/invite", wrap(async (req, res) => {
    const m = await membership(req, req.body?.issuer);
    if (m.role !== "owner") throw new Reject(403, "Only the issuer's owner can invite teammates.");
    const raw = crypto.randomBytes(12).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12).padEnd(12, "7");
    const code = raw.match(/.{4}/g).join("-");
    await pool.query(
      "insert into invites (code_hash, issuer_id, created_by, expires_at) values ($1, $2, $3, now() + $4::interval)",
      [sha256(normKey(code)), m.id, m.user.id, INVITE_DAYS + " days"]);
    res.json({ code, expiresInDays: INVITE_DAYS });
  }));

  /* ---- platform owner ---- */

  const needAdmin = async (req) => {
    const u = await needUser(req);
    if (!u.is_admin) throw new Reject(403, "Only the platform owner can do this.");
    return u;
  };

  app.get("/api/admin/issuers", wrap(async (req, res) => {
    await needAdmin(req);
    const r = await pool.query(`
      select i.id, i.code, i.legal_name, i.status, i.created_at,
        (select count(*)::int from bonds b where b.issuer_id = i.id) as bonds,
        (select count(*)::int from memberships m where m.issuer_id = i.id) as members,
        (select u.email from memberships m join users u on u.id = m.user_id
          where m.issuer_id = i.id and m.role = 'owner' order by m.created_at limit 1) as owner_email,
        (select u.name from memberships m join users u on u.id = m.user_id
          where m.issuer_id = i.id and m.role = 'owner' order by m.created_at limit 1) as owner_name
      from issuers i order by (i.status = 'pending') desc, i.created_at desc`);
    res.json({ issuers: r.rows.map((i) => ({ id: i.id, code: i.code, legalName: i.legal_name, status: i.status,
      createdAt: i.created_at, bonds: i.bonds, members: i.members, ownerEmail: i.owner_email, ownerName: i.owner_name })) });
  }));

  app.post("/api/admin/issuers/:id/status", wrap(async (req, res) => {
    await needAdmin(req);
    const status = req.body?.status;
    if (!["approved", "suspended", "pending"].includes(status)) throw new Reject(400, "Unknown status.");
    const v = await tx(async (c) => {
      const r = await c.query("update issuers set status = $2, reviewed_at = now() where id = $1", [req.params.id, status]);
      if (!r.rowCount) throw new Reject(404, "No such issuer.");
      return bump(c);
    });
    res.json({ version: v });
  }));

  /* ---- the register, scoped to one issuer ---- */

  app.get("/api/state", wrap(async (req, res) => {
    const m = await membership(req, req.query.issuer);
    const v = await version(pool);
    if (req.query.since && Number(req.query.since) === v) return res.json({ version: v, unchanged: true });
    const state = await readState("b.issuer_id = $1", [m.id]);
    res.json({ version: v, ...state, issuer: { id: m.id, code: m.code, legalName: m.legal_name, status: m.status, role: m.role } });
  }));

  app.post("/api/commit", wrap(async (req, res) => {
    const { issuer, base, bonds = [], reg = [], events = [] } = req.body || {};
    const m = await membership(req, issuer);
    if (m.status === "suspended") throw new Reject(403, "This issuer is suspended. Contact the platform owner.");
    if (m.status !== "approved" && reg.length)
      throw new Reject(403, "Assignments open once the platform owner approves this issuer.");
    const nv = await tx(async (c) => {
      await lockVersion(c, base);
      const mine = new Set((await c.query("select id from bonds where issuer_id = $1", [m.id])).rows.map((r) => r.id));
      for (const b of bonds) {
        if (!String(b.id).startsWith(m.code + "-")) throw new Reject(403, "Bond IDs must start with " + m.code + "-.");
        const owner = (await c.query("select issuer_id, data from bonds where id = $1", [b.id])).rows[0];
        if (owner && owner.issuer_id !== m.id) throw new Reject(403, "That bond belongs to another issuer.");
        if (!Number.isInteger(b.total) || b.total <= 0) throw new Reject(400, "A bond needs a whole number of units.");
        // What was anchored stays fixed: the total and the documents' hashes.
        if (owner && ["total", "instrumentHash", "declarationHash"].some((k) => owner.data[k] !== b[k]))
          throw new Reject(422, b.id + " was registered with a fixed total and document hashes; they can't change.");
        mine.add(b.id);
      }
      const clean = [];
      for (const raw of reg) {
        const a = cleanRecord(raw);
        if (!mine.has(a.bond)) throw new Reject(403, "That record belongs to another issuer.");
        const before = (await c.query("select bond from assignments where id = $1", [a.id])).rows[0];
        if (before && before.bond !== a.bond) throw new Reject(403, "A record can't move to another bond.");
        clean.push(a);
      }
      for (const e of events) if (!mine.has(e.bond)) throw new Reject(403, "That event belongs to another issuer.");
      await applyCommit(c, { bonds, reg: clean, events, issuerId: m.id });
      return bump(c);
    });
    res.json({ version: nv });
  }));

  // The caller must belong to the issuer whose bond holds this record.
  async function recordAccess(req) {
    const { issuer, id } = req.body || {};
    const m = await membership(req, issuer);
    if (m.status !== "approved") throw new Reject(403, "Credentials open once the platform owner approves this issuer.");
    const r = await pool.query(
      "select 1 from assignments a join bonds b on b.id = a.bond where a.id = $1 and b.issuer_id = $2", [id, m.id]);
    // A brand-new record is saved just after its passkey; its bond prefix proves it is this issuer's.
    if (!r.rows.length && !String(id || "").startsWith(m.code + "-")) throw new Reject(403, "That record belongs to another issuer.");
    return m;
  }

  // The passkey is shown to the issuer once, for the passkey document; only its hash is kept.
  app.post("/api/issuer/passkey", wrap(async (req, res) => {
    await recordAccess(req);
    const { id, passkey } = req.body || {};
    if (!id || normKey(passkey).length < 16) throw new Reject(400, "A 16-character passkey is required.");
    await setPasskey(pool, id, passkey);
    res.json({ ok: true });
  }));

  app.post("/api/issuer/clear-lockout", wrap(async (req, res) => {
    await recordAccess(req);
    const v = await tx(async (c) => {
      await c.query("update credentials set attempts = 0, locked = false, updated_at = now() where id = $1", [req.body?.id]);
      return bump(c);
    });
    res.json({ version: v });
  }));
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", APP);
app.use(express.static(dir, { index: "index.html" }));
app.get("*", (req, res) => res.sendFile(path.join(dir, "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error. Nothing was saved." });
});

migrate()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log(`${APP} listening on ${PORT}`)))
  .catch((e) => { console.error("Migration failed", e); process.exit(1); });
