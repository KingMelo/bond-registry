// API and static server for the registry demo.
// The same code runs as two Railway services: APP=holder (public holder portal)
// and APP=issuer (issuer console, behind a password). Both share one Postgres.

import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BONDS, ASSIGNMENTS, PASSKEYS, EVENTS } from "./seed.js";

const APP = process.env.APP === "issuer" ? "issuer" : "holder";
const PORT = Number(process.env.PORT) || 3000;
const PEPPER = process.env.PASSKEY_PEPPER || "";
const MAX_ATTEMPTS = 5;

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
    `);
    const { rows } = await c.query("select version from meta where k = 'v'");
    if (rows.length === 0) await seed(c, 1);
  } finally {
    await c.query("select pg_advisory_unlock(424242)").catch(() => {});
    c.release();
  }
}

async function seed(c, version) {
  await c.query("truncate bonds, assignments, credentials, events, meta");
  for (const b of BONDS) await c.query("insert into bonds (id, data) values ($1, $2)", [b.id, b]);
  for (const a of ASSIGNMENTS)
    await c.query("insert into assignments (id, bond, data) values ($1, $2, $3)", [a.id, a.bond, a]);
  for (const [id, key] of Object.entries(PASSKEYS)) await setPasskey(c, id, key);
  for (const e of EVENTS)
    await c.query("insert into events (eid, bond, assignment, data) values ($1, $2, $3, $4)",
      [crypto.randomUUID(), e.bond, e.id, e]);
  await c.query("insert into meta (k, version) values ('v', $1)", [version]);
}

/* ---------------- passkeys ---------------- */

const normKey = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashKey = (key, salt) => crypto.scryptSync(normKey(key) + PEPPER, salt, 32).toString("hex");

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

const app = express();
app.use(express.json({ limit: "1mb" }));
app.disable("x-powered-by");

if (APP === "issuer") {
  // Every issuer page and API call needs the password.
  app.use((req, res, next) => {
    const want = process.env.ISSUER_PASSWORD;
    if (!want) return res.status(503).send("ISSUER_PASSWORD is not set on this service.");
    const [, b64] = (req.headers.authorization || "").split(" ");
    const pass = Buffer.from(b64 || "", "base64").toString().split(":").slice(1).join(":");
    const a = crypto.createHash("sha256").update(pass).digest();
    const b = crypto.createHash("sha256").update(want).digest();
    if (crypto.timingSafeEqual(a, b)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Issuer console"').status(401).send("Password required.");
  });
}

const version = async (c) => Number((await c.query("select version from meta where k = 'v'")).rows[0].version);
const bump = (c) => c.query("update meta set version = version + 1 where k = 'v' returning version")
  .then((r) => Number(r.rows[0].version));

app.get("/api/state", async (req, res, next) => {
  try {
    const v = await version(pool);
    if (req.query.since && Number(req.query.since) === v) return res.json({ version: v, unchanged: true });
    const [bonds, regs, creds, events] = await Promise.all([
      pool.query("select data from bonds order by id"),
      pool.query("select data from assignments order by created_at, id"),
      pool.query("select id, locked from credentials"),
      pool.query("select eid, data from events order by seq desc"),
    ]);
    const cred = new Map(creds.rows.map((r) => [r.id, r]));
    const reg = regs.rows.map(({ data }) => {
      const out = { ...data, hasPasskey: cred.has(data.id), credLocked: cred.get(data.id)?.locked || false };
      if (APP === "holder") for (const k of HOLDER_HIDDEN) delete out[k];
      return out;
    });
    res.json({
      version: v,
      bonds: bonds.rows.map((r) => r.data),
      reg,
      events: events.rows.map((r) => ({ ...r.data, eid: r.eid })),
    });
  } catch (e) { next(e); }
});

class Reject extends Error { constructor(status, message) { super(message); this.status = status; } }

app.post("/api/commit", async (req, res, next) => {
  const { base, bonds = [], reg = [], events = [] } = req.body || {};
  if (APP === "holder" && bonds.length) return res.status(403).json({ error: "The holder portal cannot change bonds." });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const v = Number((await c.query("select version from meta where k = 'v' for update")).rows[0].version);
    if (v !== Number(base)) throw new Reject(409, "The register changed since you loaded it.");

    for (const b of bonds)
      await c.query("insert into bonds (id, data) values ($1, $2) on conflict (id) do update set data = $2", [b.id, b]);

    for (const raw of reg) {
      const a = { ...raw };
      for (const k of SECRET_KEYS) delete a[k];
      if (APP === "holder") {
        for (const k of HOLDER_HIDDEN) if (!(k in raw) || raw[k] === undefined) delete a[k];
        const before = (await c.query("select data from assignments where id = $1", [a.id])).rows[0]?.data;
        if (before && TERMINAL.includes(before.status))
          throw new Reject(422, a.id + " is " + before.status + " and cannot be changed.");
        if (!relayerAllows(before, a))
          throw new Reject(403, "The holder portal can't move " + a.id + " from " + (before?.status || "nothing") + " to " + a.status + ".");
      }
      // Merge, so fields one app doesn't see are never wiped by the other.
      await c.query(
        `insert into assignments (id, bond, data) values ($1, $2, $3)
         on conflict (id) do update set data = assignments.data || excluded.data`,
        [a.id, a.bond, a]);
    }

    for (const e of events) {
      const { eid, ...data } = e;
      await c.query(
        "insert into events (eid, bond, assignment, data) values ($1, $2, $3, $4) on conflict (eid) do nothing",
        [eid, data.bond, data.id, data]);
    }

    // Units rule, per bond: prior + live + unassigned + redeemed = total.
    const check = await c.query(`
      select b.id,
        (b.data->>'total')::numeric as total,
        (b.data->>'unassigned')::numeric + (b.data->>'redeemed')::numeric
          + coalesce((select sum((p->>'units')::numeric) from jsonb_array_elements(b.data->'prior') p
                      where coalesce((p->>'reversed')::boolean, false) = false), 0)
          + coalesce((select sum((a.data->>'units')::numeric) from assignments a
                      where a.bond = b.id and a.data->>'status' not in ('Redeemed','Superseded','Cancelled')), 0) as counted
      from bonds b`);
    const bad = check.rows.find((r) => Number(r.total) !== Number(r.counted));
    if (bad) throw new Reject(422, bad.id + " would no longer add up to its total. Nothing was saved.");

    const nv = await bump(c);
    await c.query("commit");
    res.json({ version: nv });
  } catch (e) {
    await c.query("rollback").catch(() => {});
    if (e instanceof Reject) return res.status(e.status).json({ error: e.message });
    next(e);
  } finally { c.release(); }
});

if (APP === "holder") {
  // Light per-IP rate limit on sign-in, on top of the per-credential lockout.
  const hits = new Map();
  const limited = (ip) => {
    const now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
    if (now - h.t > 60_000) { h.n = 0; h.t = now; }
    h.n++; hits.set(ip, h);
    return h.n > 20;
  };

  app.post("/api/holder/signin", async (req, res, next) => {
    if (limited(req.ip)) return res.status(429).json({ ok: false, code: "rate", error: "Too many attempts. Wait a minute and try again." });
    const { id, passkey } = req.body || {};
    const c = await pool.connect();
    try {
      await c.query("begin");
      const cred = (await c.query("select * from credentials where id = $1 for update", [id])).rows[0];
      if (!cred) { await c.query("rollback"); return res.json({ ok: false, code: "nokey" }); }
      if (cred.locked) { await c.query("rollback"); return res.json({ ok: false, code: "locked" }); }
      const a = Buffer.from(hashKey(passkey, cred.salt), "hex"), b = Buffer.from(cred.hash, "hex");
      if (crypto.timingSafeEqual(a, b)) {
        if (cred.attempts > 0) await c.query("update credentials set attempts = 0 where id = $1", [id]);
        await c.query("commit");
        return res.json({ ok: true });
      }
      const attempts = cred.attempts + 1, locked = attempts >= MAX_ATTEMPTS;
      await c.query("update credentials set attempts = $2, locked = $3, updated_at = now() where id = $1", [id, attempts, locked]);
      if (locked) await bump(c); // the issuer's queue needs to see the lockout
      await c.query("commit");
      res.json({ ok: false, code: locked ? "locked" : "mismatch", left: MAX_ATTEMPTS - attempts });
    } catch (e) { await c.query("rollback").catch(() => {}); next(e); } finally { c.release(); }
  });
}

if (APP === "issuer") {
  // The passkey is shown to the issuer once, for the passkey document; only its hash is kept.
  app.post("/api/issuer/passkey", async (req, res, next) => {
    try {
      const { id, passkey } = req.body || {};
      if (!id || normKey(passkey).length < 16) return res.status(400).json({ error: "A 16-character passkey is required." });
      await setPasskey(pool, id, passkey);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post("/api/issuer/clear-lockout", async (req, res, next) => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("update credentials set attempts = 0, locked = false, updated_at = now() where id = $1", [req.body?.id]);
      const v = await bump(c);
      await c.query("commit");
      res.json({ version: v });
    } catch (e) { await c.query("rollback").catch(() => {}); next(e); } finally { c.release(); }
  });

  app.post("/api/issuer/reset", async (req, res, next) => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const v = (await version(c)) + 1;
      await seed(c, v);
      await c.query("commit");
      res.json({ version: v });
    } catch (e) { await c.query("rollback").catch(() => {}); next(e); } finally { c.release(); }
  });
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
