// API and static server for the registry.
// The same code runs as three Railway services against one Postgres:
//   APP=holder    the public interest registry, shared by every approved issuer
//   APP=issuer    the issuer console: issuer accounts, each seeing only its own bonds
//   APP=platform  the platform console: staff review issuers and bonds; no holder data

import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ISSUERS, BONDS, ASSIGNMENTS, PASSKEYS, EVENTS } from "./seed.js";
import * as chain from "./chain.js";
import * as holderKeys from "./holder-keys.js";

const APP = ["issuer", "platform"].includes(process.env.APP) ? process.env.APP : "holder";
const PORT = Number(process.env.PORT) || 3000;
const PEPPER = process.env.PASSKEY_PEPPER || "";
const MAX_ATTEMPTS = 5;
const SESSION_DAYS = 7;
// Password reset: a link by email, good for one hour and one use. Mail goes out through Resend.
const RESET_MINUTES = 60;
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_URL = process.env.RESEND_API_URL || "https://api.resend.com/emails";
const MAIL_FROM = process.env.MAIL_FROM || "Bond Registry <onboarding@resend.dev>";
// Links are built from configuration, never from the request's Host header.
const PUBLIC_URL = (process.env.PUBLIC_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "http://localhost:" + PORT))
  .replace(/\/+$/, "");
const INVITE_DAYS = 7;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : false,
});

const TERMINAL = ["Redeemed", "Superseded", "Cancelled", "Rejected"];
// An assignment the holder doesn't reject within this many days of its mailing takes effect.
const RESPONSE_DAYS = Number(process.env.RESPONSE_DAYS || 30);
// Never stored in the record itself: credential state lives in its own table.
const SECRET_KEYS = ["passkey", "credLocked", "hasPasskey", "attempts", "chain", "deviceKey", "accessCode",
  // Kept by the server only: the holder's device key and when the mailing went out.
  "holder", "deliveredAt"];
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
      ${chain.SCHEMA}
      create table if not exists bonds (id text primary key, data jsonb not null);
      create table if not exists assignments (
        id text primary key, bond text not null, data jsonb not null,
        created_at timestamptz not null default clock_timestamp());
      create table if not exists credentials (
        id text primary key, salt text not null, hash text not null,
        attempts int not null default 0, locked boolean not null default false,
        updated_at timestamptz not null default now());
      -- A new assignee's access code, made when the assignor's device signs the assign-out and
      -- sealed so only the issuer can open it, once, to mail it. Emptied once opened.
      create table if not exists sealed_codes (
        id text primary key, sealed text not null, created_at timestamptz not null default now(),
        revealed_at timestamptz, revealed_by text);
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
      -- The Safe an issuer acts through on-chain, once it has one (then its calls need owner signatures).
      alter table issuers add column if not exists safe_address text;
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
      create table if not exists password_resets (
        token_hash text primary key, user_id text not null references users(id) on delete cascade,
        app text not null, created_at timestamptz not null default now(), expires_at timestamptz not null,
        used_at timestamptz);
      create table if not exists sessions (
        token_hash text primary key, user_id text not null references users(id) on delete cascade,
        created_at timestamptz not null default now(), expires_at timestamptz not null);
      alter table bonds add column if not exists issuer_id text;
      -- Each bond waits for platform review; bonds from before reviews existed count as approved.
      alter table bonds add column if not exists review text not null default 'approved';
      alter table bonds add column if not exists review_note text;
      alter table bonds add column if not exists reviewed_by text;
      alter table bonds add column if not exists reviewed_at timestamptz;
      alter table issuers add column if not exists reviewed_by text;
      -- The platform owner's own issuers skip both reviews.
      alter table issuers add column if not exists trusted boolean not null default false;
      alter table users add column if not exists platform_role text;
      alter table invites add column if not exists kind text not null default 'issuer';
      alter table invites alter column issuer_id drop not null;
      update users set platform_role = 'owner' where is_admin and platform_role is null;
      -- Each bond and record carries its own revision, so a stale save is caught per record.
      alter table bonds add column if not exists rev bigint not null default 0;
      alter table assignments add column if not exists rev bigint not null default 0;
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
    // Amounts are whole cents. A register from when one unit was $1 is converted once, and every
    // bond and record gets a new revision so a browser tab still holding dollar figures can't save them.
    if (!(await c.query("select 1 from meta where k = 'units'")).rows.length) {
      await c.query(`
        update bonds set rev = rev + 1, data = data || jsonb_build_object(
          'total', (data->>'total')::numeric * 100,
          'face', coalesce((data->>'face')::numeric, (data->>'total')::numeric) * 100,
          'unassigned', (data->>'unassigned')::numeric * 100,
          'redeemed', coalesce((data->>'redeemed')::numeric, 0) * 100,
          'prior', (select coalesce(jsonb_agg(p || jsonb_build_object('units', (p->>'units')::numeric * 100)), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(data->'prior', '[]'::jsonb)) p))`);
      await c.query(`
        update assignments set rev = rev + 1, data = data || jsonb_build_object(
          'units', (data->>'units')::numeric * 100,
          'issuedUnits', coalesce((data->>'issuedUnits')::numeric, (data->>'units')::numeric) * 100)`);
      await c.query("insert into meta (k, version) values ('units', 100)");
      await c.query("update meta set version = version + 1 where k = 'v'");
      console.log("Converted amounts to cents");
    }
    // Prior instruments recorded before entries carried a holder and mailing number are cleared
    // once, at the owner's request; their amounts go back to unassigned. The events that recorded
    // them stay in the append-only log as history.
    if (!(await c.query("select 1 from meta where k = 'prior_v2'")).rows.length) {
      const cleared = await c.query(`
        update bonds set rev = rev + 1, data = data || jsonb_build_object(
          'unassigned', (data->>'unassigned')::numeric + coalesce((select sum((p->>'units')::numeric)
            from jsonb_array_elements(data->'prior') p where coalesce((p->>'reversed')::boolean, false) = false), 0),
          'prior', '[]'::jsonb)
        where jsonb_array_length(coalesce(data->'prior', '[]'::jsonb)) > 0`);
      await c.query("insert into meta (k, version) values ('prior_v2', 1)");
      if (cleared.rowCount) {
        await c.query("update meta set version = version + 1 where k = 'v'");
        console.log(`Cleared prior instruments on ${cleared.rowCount} bonds`);
      }
    }
    const n = (await c.query(`select (select count(*) from issuers)::int as issuers, (select count(*) from bonds)::int as bonds,
      (select count(*) from assignments)::int as records, (select count(*) from users)::int as users`)).rows[0];
    console.log(`Register: ${n.issuers} issuers, ${n.bonds} bonds, ${n.records} records, ${n.users} users`);
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

// SEED_SAMPLE=0 starts an empty register: no sample issuer, bonds or holders.
async function seed(c, version) {
  if (process.env.SEED_SAMPLE === "0") {
    await c.query("insert into meta (k, version) values ('v', $1)", [version]);
    return;
  }
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

// Access codes: 16 characters from an alphabet with no look-alikes, grouped in fours.
function genAccessCode() {
  const set = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  while (out.length < 16) for (const b of crypto.randomBytes(32)) if (b < 248 && out.length < 16) out += set[b % set.length];
  return out.match(/.{4}/g).join("-");
}
// Sealed with AES-256-GCM under a key only the servers have (all three share the pepper and database).
const SEAL_KEY = crypto.createHash("sha256").update("sealed-codes:" + (process.env.ACCESS_CODE_KEY || PEPPER + process.env.DATABASE_URL)).digest();
function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", SEAL_KEY, iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}
function unseal(s) {
  const [iv, tag, body] = String(s).split(".").map((x) => Buffer.from(x, "base64url"));
  const d = crypto.createDecipheriv("aes-256-gcm", SEAL_KEY, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

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
  Issued: ["Accepted", "Rejected"], // acknowledged, or refused with a reason
  AwaitingCredential: ["CredentialRequested", "Cancelled"],
  // Redemption isn't requested through the registry: the fiduciary paperwork tells holders where
  // to get paid, and the issuer records the outcome.
  Accepted: ["Locked", "Superseded"],
  Locked: ["Superseded"],
};

// What a holder may change on their own record: its status (checked by relayerAllows) and the
// notes that go with each move. Everything else on a record is the issuer's.
const HOLDER_FIELDS = ["status", "units", "accepted", "effective", "effectiveOn", "rejectionReason", "rejectedOn",
  "lockKind", "lockReason", "lockedOn", "rotationRequested", "unlockRequested"];
const REQUEST_FIELDS = ["requestedParty", "requestedBy", "requestedContact", "requestedOn", "requestHash"];
const IGNORED = ["rev", "chain", "deviceKey", "hasPasskey", "credLocked", "holder", "deliveredAt", "address", "instrumentMail", "passkeyMail", "requestedContact"];
function changedFields(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => !IGNORED.includes(k) || k === "requestedContact")
    .filter((k) => k in after && JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}

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
    if (e instanceof Reject || (e?.status >= 400 && e?.status < 500 && !e.code)) return res.status(e.status).json({ error: e.message });
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

/* The holder's device key on the current contract, as the apps show it. */
function activeKey(data) {
  const k = data?.holder;
  return k && k.contract === (chain.CONTRACT || "local") && k.x ? k : null;
}
function deviceKeyOf(data) {
  const k = activeKey(data);
  return k ? { fingerprint: holderKeys.fingerprint(k.x), since: k.since, credId: k.credId }
    : data?.holder?.clearedOn && data.holder.contract === (chain.CONTRACT || "local") ? { cleared: data.holder.clearedOn } : null;
}

/* Reads the register for a set of bonds. The holder portal hides contact details. */
async function readState(bondFilter, params) {
  const [bonds, regs, creds, events] = await Promise.all([
    pool.query(`select data, issuer_id, review, review_note, rev from bonds b where ${bondFilter} order by id`, params),
    pool.query(`select a.data, a.rev from assignments a join bonds b on b.id = a.bond where ${bondFilter} order by a.created_at, a.id`, params),
    pool.query(`select k.id, k.locked from credentials k join assignments a on a.id = k.id join bonds b on b.id = a.bond where ${bondFilter}`, params),
    pool.query(`select e.eid, e.data from events e join bonds b on b.id = e.bond where ${bondFilter} order by e.seq desc`, params),
  ]);
  const cred = new Map(creds.rows.map((r) => [r.id, r]));
  const sealedRows = APP === "holder" ? [] : (await pool.query(
    `select s.id, s.revealed_at, s.revealed_by from sealed_codes s join assignments a on a.id = s.id join bonds b on b.id = a.bond where ${bondFilter}`, params)).rows;
  // sealed: nobody has seen it yet · assignor: given to the assignor to deliver · shown: opened by the issuer
  const sealed = new Map(sealedRows.map((r) => [r.id, !r.revealed_at ? "sealed" : r.revealed_by === "assignor" ? "assignor" : "shown"]));
  const onChain = await chain.statusFor(pool, bonds.rows.map((r) => r.data.id), regs.rows.map((r) => r.data.id));
  return {
    bonds: bonds.rows.map((r) => {
      const b = { ...r.data, issuerId: r.issuer_id, review: r.review, reviewNote: r.review_note, rev: Number(r.rev),
        chain: onChain.get(r.data.id) || null };
      // Prior instruments name their holder; the public site gets amounts only.
      if (APP === "holder") b.prior = (b.prior || []).map(({ id, units, reversed }) => ({ id, units, reversed }));
      return b;
    }),
    reg: regs.rows.map(({ data, rev }) => {
      const out = { ...data, rev: Number(rev), hasPasskey: cred.has(data.id), credLocked: cred.get(data.id)?.locked || false,
        chain: onChain.get(data.id) || null, deviceKey: deviceKeyOf(data), ...(APP === "holder" ? {} : { accessCode: sealed.get(data.id) || null }) };
      delete out.holder;
      if (APP === "holder") for (const k of HOLDER_HIDDEN) delete out[k];
      return out;
    }),
    events: events.rows.map((r) => ({ ...r.data, eid: r.eid })),
    chain: chain.publicInfo(),
    responseDays: RESPONSE_DAYS,
  };
}

/* An issued assignment the holder hasn't rejected takes effect once the response period after its
   mailing has passed. Runs on the issuer service; each record is its own transaction, through the
   same save path as any other change, so it reaches the chain the same way. */
async function takeEffectWhenDue() {
  const due = (await pool.query(
    `select id, bond, data, rev from assignments
     where data->>'status' = 'Issued' and data->>'deliveredAt' is not null
       and (data->>'deliveredAt')::timestamptz + make_interval(days => $1) <= now()
     order by created_at limit 50`, [RESPONSE_DAYS])).rows;
  for (const r of due) {
    try {
      await tx(async (c) => {
        await applyCommit(c, {
          bonds: [],
          reg: [{ ...r.data, status: "Accepted", effective: "deemed", effectiveOn: stampNow().split(" ").slice(0, 3).join(" "), rev: Number(r.rev) }],
          events: [{ eid: crypto.randomUUID(), bond: r.bond, id: r.id, t: stampNow(), ev: "TookEffect", actor: "SYSTEM",
            ref: "No rejection within " + RESPONSE_DAYS + " days of mailing" }],
        });
        await bump(c);
      });
      console.log(`${r.id} took effect: no rejection within ${RESPONSE_DAYS} days`);
    } catch (e) {
      if (e.status !== 409) console.error("Taking effect", r.id, e.message); // 409: someone changed it meanwhile; next round
    }
  }
}

/* Saves one commit after the caller's own checks; enforces the units rule for the bonds given. */
/* Saves one commit after the caller's own checks; enforces the units rule for the bonds given.
   A changed bond or record must carry the revision it was loaded at; a new one carries none.
   Returns the new revisions so the app can keep editing without reloading. */
async function applyCommit(c, { bonds, reg, events, issuerId, autoApprove = false, authFor }) {
  const touched = [...new Set([...bonds.map((b) => b.id), ...reg.map((a) => a.bond)])];
  // Lock the bonds involved, so two saves can't each pass the units rule on their own.
  if (touched.length) await c.query("select id from bonds where id = any($1) order by id for update", [touched]);
  const revs = { bonds: {}, reg: {} };
  const stale = (id) => new Reject(409, id + " changed since you loaded it.");
  // What was stored before this save, so the chain gets exactly the changes.
  const oldBonds = new Map((await c.query("select id, data, review from bonds where id = any($1)", [bonds.map((b) => b.id)])).rows.map((r) => [r.id, r]));
  const oldRecs = new Map((await c.query("select id, data from assignments where id = any($1)", [reg.map((a) => a.id)])).rows.map((r) => [r.id, r.data]));
  const savedRecs = [];

  for (const b of bonds) {
    if (b.rev == null) {
      // A new bond waits for platform review. The platform owner's own goes live once its UCC-1 is recorded.
      const r = await c.query(
        "insert into bonds (id, data, issuer_id, review) values ($1, $2, $3, $4) on conflict (id) do nothing returning rev, review",
        [b.id, stripBond(b), issuerId ?? b.issuerId, autoApprove && ucc1Complete(b) ? "approved" : "pending"]);
      if (!r.rowCount) throw stale(b.id);
      revs.bonds[b.id] = Number(r.rows[0].rev);
      if (r.rows[0].review === "approved") await chain.queueAnchor(c, b.id);
    } else {
      const r = await c.query(
        `update bonds set data = $2, rev = rev + 1,
           review = case when $4 and review = 'pending' then 'approved' else review end
         where id = $1 and rev = $3 returning rev, review, data`,
        [b.id, stripBond(b), b.rev, autoApprove && ucc1Complete(b)]);
      if (!r.rowCount) throw stale(b.id);
      revs.bonds[b.id] = Number(r.rows[0].rev);
      const was = oldBonds.get(b.id);
      if (r.rows[0].review === "approved" && was?.review !== "approved") await chain.queueAnchor(c, b.id);
      else if (r.rows[0].review === "approved") await chain.queuePriorChanges(c, b.id, was?.data, r.rows[0].data);
    }
  }
  for (const a of reg) {
    const { rev, ...data } = a;
    if (rev == null) {
      const r = await c.query(
        "insert into assignments (id, bond, data) values ($1, $2, $3) on conflict (id) do nothing returning rev, data", [a.id, a.bond, data]);
      if (!r.rowCount) throw stale(a.id);
      revs.reg[a.id] = Number(r.rows[0].rev);
      savedRecs.push(r.rows[0].data);
    } else {
      // Merge, so fields one app doesn't see are never wiped by the other.
      const r = await c.query(
        "update assignments set data = data || $2, rev = rev + 1 where id = $1 and rev = $3 returning rev, data", [a.id, data, rev]);
      if (!r.rowCount) throw stale(a.id);
      revs.reg[a.id] = Number(r.rows[0].rev);
      savedRecs.push(r.rows[0].data);
    }
  }
  for (const e of events) {
    const { eid, ...data } = e;
    await c.query(
      "insert into events (eid, bond, assignment, data) values ($1, $2, $3, $4) on conflict (eid) do nothing",
      [eid, data.bond, data.id, data]);
  }
  await chain.queueRecordChanges(c, { app: APP, before: oldRecs, after: savedRecs, events, authFor });

  // Units rule, per bond: prior + live + unassigned + redeemed = total.
  if (!touched.length) return revs;
  const check = await c.query(`
    select b.id,
      (b.data->>'total')::numeric as total,
      (b.data->>'unassigned')::numeric + (b.data->>'redeemed')::numeric
        + coalesce((select sum((p->>'units')::numeric) from jsonb_array_elements(b.data->'prior') p
                    where coalesce((p->>'reversed')::boolean, false) = false), 0)
        + coalesce((select sum((a.data->>'units')::numeric) from assignments a
                    where a.bond = b.id and a.data->>'status' not in ('Redeemed','Superseded','Cancelled','Rejected')), 0) as counted
    from bonds b where b.id = any($1)`, [touched]);
  const bad = check.rows.find((r) => Number(r.total) !== Number(r.counted));
  if (bad) throw new Reject(422, bad.id + " would no longer add up to its total. Nothing was saved.");
  return revs;
}

// A bond's UCC-1 is complete once its filing number, office, date and filed copy's hash are all recorded.
const ucc1Complete = (b) => !!(b?.ucc1 && ["number", "office", "date", "hash"].every((k) => String(b.ucc1[k] || "").trim()));

// Field by field: Postgres stores JSON keys in its own order.
const sameUcc1 = (x, y) => ["number", "office", "date", "hash", "file"].every((k) => (x?.[k] || "") === (y?.[k] || ""));

// Ownership and review live in their own columns, set by the server only.
// Prior instruments are append-only: an entry once recorded can only be marked reversed, with a
// reason. A new entry names the instrument, its holder and an amount.
function checkPrior(b, before) {
  const prior = Array.isArray(b.prior) ? b.prior : [];
  const was = new Map(((before && before.prior) || []).map((p) => [p.id, p]));
  for (const p of prior) {
    const o = was.get(p.id);
    if (o) {
      for (const k of ["ref", "holder", "mail", "units", "recordedOn"])
        if ((o[k] ?? null) !== (p[k] ?? null)) throw new Reject(422, "A recorded prior instrument can't be changed; reverse it instead.");
      if (o.reversed && !p.reversed) throw new Reject(422, "A reversed prior instrument stays reversed.");
      if (p.reversed && !o.reversed && !String(p.reversedReason || "").trim()) throw new Reject(400, "Give a reason for the reversal.");
      was.delete(p.id);
    } else {
      if (!String(p.ref || "").trim()) throw new Reject(400, "Enter the prior instrument's identifier.");
      if (!String(p.holder || "").trim()) throw new Reject(400, "Enter who holds " + p.ref + ".");
      if (!Number.isInteger(p.units) || p.units <= 0) throw new Reject(400, "Enter the amount for " + p.ref + ".");
      // An identifier is used once per bond, even after a reversal: the chain keeps the reversed entry.
      const key = String(p.ref).trim().toUpperCase();
      const clash = prior.find((q) => q !== p && String(q.ref || "").trim().toUpperCase() === key);
      if (clash) throw new Reject(422, p.ref + (clash.reversed ? " was recorded before and reversed; use a distinct identifier." : " is already recorded on this bond."));
    }
  }
  if (was.size) throw new Reject(422, "A recorded prior instrument can't be removed; reverse it instead.");
}

const stripBond = (b) => { const { issuerId, review, reviewNote, rev, chain: _c, ...rest } = b; return rest; };

// A new record needs the SHA-256 of its signed instrument: no paper, no record.
function needsDocument(before, a) {
  if (!before && !chain.isHash(a.docHash))
    throw new Reject(400, "Attach the signed assignment instrument for " + a.id + ". Only its SHA-256 hash is kept.");
}

function cleanRecord(raw) {
  const a = { ...raw };
  for (const k of SECRET_KEYS) delete a[k];
  return a;
}


/* ======================= holder portal ======================= */

if (APP === "holder") {
  app.get("/api/state", wrap(async (req, res) => {
    const v = await version(pool);
    if (req.query.since && Number(req.query.since) === v) return res.json({ version: v, unchanged: true });
    const filter = "b.review = 'approved' and b.issuer_id in (select id from issuers where status = any($1))";
    const [state, issuers] = await Promise.all([
      readState(filter, [PUBLIC_STATUSES]),
      pool.query("select id, code, legal_name, status from issuers where status = any($1) order by code", [PUBLIC_STATUSES]),
    ]);
    res.json({ version: v, ...state,
      issuers: issuers.rows.map((i) => ({ id: i.id, code: i.code, legalName: i.legal_name, status: i.status })) });
  }));

  // ---- holder sessions: the mailed access code opens one record for a while.
  const SESSION_SECRET = process.env.HOLDER_SESSION_SECRET || sha256("holder-session:" + PEPPER + process.env.DATABASE_URL);
  const HOLDER_SESSION_MIN = 30;
  const signToken = (id) => {
    const body = Buffer.from(JSON.stringify({ id, exp: Date.now() + HOLDER_SESSION_MIN * 60_000 })).toString("base64url");
    return body + "." + crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  };
  const readToken = (t) => {
    const [body, mac] = String(t || "").split(".");
    if (!body || !mac) return null;
    const want = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
    if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
    const v = JSON.parse(Buffer.from(body, "base64url").toString());
    return v.exp > Date.now() ? v : null;
  };
  const needSession = (t) => {
    const v = readToken(t);
    if (!v) throw new Reject(401, "Your session has ended. Sign in again with your assignment ID and access code.");
    return v;
  };
  // Passkeys belong to this site: its host name and origin.
  const site = (req) => {
    const host = req.get("host") || "";
    return { rpId: process.env.HOLDER_RP_ID || req.hostname, origins: [process.env.HOLDER_ORIGIN || req.protocol + "://" + host] };
  };
  const contractOrLocal = () => chain.CONTRACT || "local";
  const deviceDoc = chain.deviceDoc;
  const keyArgs = (rec, x, y, doc) => [chain.id32(rec.bond), chain.id32(rec.id), x, y, doc];
  const startNonce = (data) => (data?.holder && data.holder.contract === contractOrLocal() ? Number(data.holder.nonce || 0) : 0);
  const challengeOf = chain.holderChallenge;

  /**
   * One holder save. `mode.collect` gathers what the device must sign (nothing is kept: the caller
   * rolls back); otherwise each signed call needs the next assertion in `mode.assertions`.
   */
  async function holderSave(c, body, mode, req) {
    const { bonds = [], reg = [], events = [] } = body || {};
    if (bonds.length) throw new Reject(403, "The holder portal cannot change bonds.");
    const session = readToken(body?.token);
    const clean = [], units = [];
    for (const raw of reg) {
      const a = cleanRecord(raw);
      for (const k of HOLDER_HIDDEN) if (!(k in raw) || raw[k] === undefined) delete a[k];
      const owner = (await c.query(
        "select i.status, b.review from bonds b join issuers i on i.id = b.issuer_id where b.id = $1", [a.bond])).rows[0];
      if (!owner || owner.status !== "approved" || owner.review !== "approved")
        throw new Reject(403, "This bond's issuer is not accepting changes right now.");
      const before = (await c.query("select data from assignments where id = $1", [a.id])).rows[0]?.data;
      if (before && before.bond !== a.bond) throw new Reject(403, "A record can't move to another bond.");
      if (before && TERMINAL.includes(before.status))
        throw new Reject(422, a.id + " is " + before.status + " and cannot be changed.");
      if (!relayerAllows(before, a))
        throw new Reject(403, "The holder portal can't move " + a.id + " from " + (before?.status || "nothing") + " to " + a.status + ".");
      // Who may make this change, and which fields: a new assignee asking for access needs nobody's
      // session; everything else needs the session of the record's holder, or of the assignor for
      // their own assign-outs. Amounts are checked against the save as a whole, below.
      const changed = before ? changedFields(before, a) : [];
      const accessRequest = before?.status === "AwaitingCredential" && a.status === "CredentialRequested";
      if (accessRequest) {
        if (changed.some((k) => !["status", ...REQUEST_FIELDS].includes(k))) throw new Reject(403, "An access request can't change the record.");
      } else {
        if (!session) throw new Reject(401, "Sign in with your assignment ID and access code first.");
        const me = (await c.query("select data->>'parent' as parent, data->>'origin' as origin from assignments where id = $1", [session.id])).rows[0];
        const role = a.id === session.id ? "holder"
          : (before?.origin || a.origin) === "AssignOut" && (before ? before.parent : a.parent) === session.id ? "assignor"
          : before && me?.origin === "AssignOut" && me.parent === a.id ? "parent" : null;
        if (!role) throw new Reject(403, "You're signed in to " + session.id + "; " + a.id + " isn't yours to change.");
        const may = role === "holder" ? HOLDER_FIELDS : ["status", "units"];
        if (before && changed.some((k) => !may.includes(k))) throw new Reject(403, "You can't change " + changed.filter((k) => !may.includes(k)).join(", ") + " on " + a.id + ".");
        // The assignor can only cancel an assign-out; the parent of a new holder only closes when emptied.
        if (role === "assignor" && before && a.status !== before.status && a.status !== "Cancelled") throw new Reject(403, "Only the new holder can do that.");
        if (role === "parent" && a.status !== before.status && !(a.status === "Superseded" && Number(a.units) === 0)) throw new Reject(403, "You can't change " + a.id + ".");
        if (role === "holder" && a.status === "Accepted" && before?.status === "Issued") Object.assign(a, { effective: "holder" });
      }
      units.push({ a, before });
      needsDocument(before, a);
      if (before?.status === "Issued" && a.status === "Rejected") {
        if (!String(a.rejectionReason || "").trim()) throw new Reject(400, "Give a reason for rejecting " + a.id + ".");
        // The amount goes back where it came from: the assignor's record for an assign-out (sent
        // with this save), otherwise the bond's unassigned balance, which only the server changes.
        if (before.origin !== "AssignOut") {
          const r = await c.query(
            `update bonds set data = jsonb_set(data, '{unassigned}', to_jsonb((data->>'unassigned')::numeric + $2)), rev = rev + 1
             where id = $1`, [a.bond, Number(before.units)]);
          if (!r.rowCount) throw new Reject(404, "No such bond.");
        }
      }
      clean.push(chain.normalizeRecord(a));
    }
    // Amounts only move with an assign-out: a new child takes units from its parent; a cancelled or
    // rejected child gives them back. Nothing else in a holder save may change an amount.
    const delta = new Map();
    const add = (id, n) => delta.set(id, (delta.get(id) || 0) + n);
    for (const { a, before } of units) {
      if (!before) {
        if (!(Number.isInteger(a.units) && a.units > 0 && a.issuedUnits === a.units)) throw new Reject(400, "Enter a whole number of cents for the assignment.");
        add(a.parent, -a.units);
      } else if (a.origin === "AssignOut" && ["Cancelled", "Rejected"].includes(a.status) && a.status !== before.status) add(a.parent, Number(before.units));
    }
    for (const { a, before } of units) {
      if (!before) continue;
      const want = Number(before.units) + (delta.get(a.id) || 0);
      if (Number(a.units) !== want && !(TERMINAL.includes(a.status) && Number(a.units) === Number(before.units)))
        throw new Reject(422, a.id + "'s amount doesn't match the transfer being made.");
      delta.delete(a.id);
    }
    for (const [id, d] of delta) if (d) throw new Reject(422, "The save must include " + id + " with its amount adjusted.");

    const bondsOk = new Set(clean.map((a) => a.bond));
    for (const e of events) if (!bondsOk.has(e.bond)) throw new Reject(403, "An event must belong to a record being saved.");

    // Each signed call: the signer's key, its next nonce, and the challenge the contract rebuilds.
    const used = new Map();
    let next = 0;
    const authFor = async (op) => {
      if (!session || op.signer !== session.id) throw new Reject(403, "Only the holder of " + op.signer + " can sign this.");
      const data = (await c.query("select data from assignments where id = $1", [op.signer])).rows[0]?.data;
      const key = activeKey(data);
      if (!key) throw new Reject(409, "Set up your device first: sign in again and confirm with your phone or computer.");
      const nonce = startNonce(data) + (used.get(op.signer) || 0);
      const challenge = challengeOf(op.signer, nonce, op.fn, op.args);
      used.set(op.signer, (used.get(op.signer) || 0) + 1);
      if (mode.collect) { mode.collect.push({ fn: op.fn, ref: op.ref, challenge, credId: key.credId }); return holderKeys.NOAUTH; }
      const assertion = (mode.assertions || [])[next++];
      if (!assertion) throw new Reject(400, "This change needs your device's confirmation.");
      return holderKeys.checkAssertion({ assertion, challenge, x: key.x, y: key.y, ...site(req) });
    };
    const revs = await applyCommit(c, { bonds: [], reg: clean, events, authFor });
    // Each new assign-out gets its assignee's access code now, signed off by the assignor's device,
    // and sealed for the issuer. The assignor never sees it.
    if (!mode.collect)
      for (const { a, before } of units) if (!before && a.origin === "AssignOut") {
        const code = genAccessCode();
        await setPasskey(c, a.id, code);
        await c.query("insert into sealed_codes (id, sealed) values ($1, $2) on conflict (id) do nothing", [a.id, seal(code)]);
      }
    for (const [id, n] of used)
      await c.query("update assignments set data = jsonb_set(data, '{holder,nonce}', to_jsonb($2::int)) where id = $1",
        [id, startNonce((await c.query("select data from assignments where id = $1", [id])).rows[0].data) + n]);
    return revs;
  }

  class Collected extends Error {}

  // What the holder's device must sign for a save, before it's made.
  app.post("/api/holder/prepare", wrap(async (req, res) => {
    const collect = [];
    try { await tx(async (c) => { await holderSave(c, req.body, { collect }, req); throw new Collected(); }); }
    catch (e) { if (!(e instanceof Collected)) throw e; }
    res.json({ sign: collect });
  }));

  app.post("/api/commit", wrap(async (req, res) => {
    const nv = await tx(async (c) => {
      const revs = await holderSave(c, req.body, { assertions: req.body?.assertions || [] }, req);
      return { version: await bump(c), revs };
    });
    res.json(nv);
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
        const data = (await c.query("select data from assignments where id = $1", [id])).rows[0]?.data;
        if (["AwaitingCredential", "CredentialRequested"].includes(data?.status))
          return { ok: false, code: "inactive", error: "This assignment isn't active yet. The issuer activates it after verifying you." };
        const key = activeKey(data);
        return { ok: true, token: signToken(id), rpId: site(req).rpId, device: key ? { credId: key.credId, fingerprint: holderKeys.fingerprint(key.x) } : null,
          // A new passkey for this record: the browser makes it with these.
          enroll: key ? null : { userId: crypto.createHash("sha256").update("holder:" + id).digest("base64url"), name: id,
            displayName: data?.party || id, challenge: crypto.randomBytes(32).toString("base64url"), rpId: site(req).rpId } };
      }
      const attempts = cred.attempts + 1, locked = attempts >= MAX_ATTEMPTS;
      await c.query("update credentials set attempts = $2, locked = $3, updated_at = now() where id = $1", [id, attempts, locked]);
      if (locked) await bump(c); // the issuer's queue needs to see the lockout
      return { ok: false, code: locked ? "locked" : "mismatch", left: MAX_ATTEMPTS - attempts };
    });
    res.json(out);
  }));

  // The signed-in holder's own record details the public portal hides: the certified mail number.
  app.post("/api/holder/mine", wrap(async (req, res) => {
    const session = needSession(req.body?.token);
    const d = (await pool.query("select data from assignments where id = $1", [session.id])).rows[0]?.data;
    if (!d) throw new Reject(404, "No such record.");
    res.json({ id: d.id, instrumentMail: d.instrumentMail || null, passkeyMail: d.passkeyMail || null });
  }));

  // The assignor sees their new assignee's access code once, right after the assign-out is
  // saved, to seal it in with the signed instrument they deliver.
  app.post("/api/holder/assignee-code", wrap(async (req, res) => {
    const session = needSession(req.body?.token);
    const id = String(req.body?.id || "");
    const out = await tx(async (c) => {
      const d = (await c.query("select data from assignments where id = $1", [id])).rows[0]?.data;
      if (!d) throw new Reject(404, "Not saved yet.");
      if (d.origin !== "AssignOut" || d.parent !== session.id) throw new Reject(403, "That isn't one of your assign-outs.");
      const row = (await c.query("select * from sealed_codes where id = $1 for update", [id])).rows[0];
      if (!row) throw new Reject(404, "Not saved yet.");
      if (row.revealed_at) throw new Reject(409, "This access code was already shown. If it's lost, the issuer issues a new one.");
      const code = unseal(row.sealed);
      await c.query("update sealed_codes set sealed = '', revealed_at = now(), revealed_by = 'assignor' where id = $1", [id]);
      return { code };
    });
    res.json(out);
  }));

  // ---- registering the holder's device key: create a passkey, then sign its registration with it.
  async function keyPlan(c, body, req) {
    const session = needSession(body?.token);
    holderKeys.checkCreation({ clientDataJSON: body?.clientDataJSON, ...site(req) });
    let x, y;
    try { ({ x, y } = holderKeys.keyFromSpki(body?.spki)); } catch (e) { throw new Reject(422, e.message); }
    const credId = String(body?.credId || "");
    if (!/^[A-Za-z0-9_-]{16,}$/.test(credId)) throw new Reject(400, "The device didn't give a key ID.");
    const row = (await c.query("select data from assignments where id = $1 for update", [session.id])).rows[0];
    if (!row) throw new Reject(404, "No such record.");
    const rec = row.data;
    if (TERMINAL.includes(rec.status) || ["AwaitingCredential", "CredentialRequested"].includes(rec.status))
      throw new Reject(422, rec.id + " is " + rec.status + "; a device key can't be added now.");
    if (activeKey(rec)) throw new Reject(409, "This record already has a device key. Use that device, or ask the issuer to reset it.");
    const doc = deviceDoc(rec.id, credId), args = keyArgs(rec, x, y, doc), nonce = startNonce(rec);
    return { session, rec, x, y, credId, doc, args, nonce, challenge: challengeOf(rec.id, nonce, "registerHolderKey", args) };
  }

  app.post("/api/holder/key/prepare", wrap(async (req, res) => {
    const plan = await tx((c) => keyPlan(c, req.body, req));
    res.json({ challenge: plan.challenge, credId: plan.credId });
  }));

  app.post("/api/holder/key", wrap(async (req, res) => {
    const out = await tx(async (c) => {
      const p = await keyPlan(c, req.body, req);
      const auth = holderKeys.checkAssertion({ assertion: req.body?.assertion, challenge: p.challenge, x: p.x, y: p.y, ...site(req) });
      const holder = { contract: contractOrLocal(), credId: p.credId, x: p.x, y: p.y, nonce: p.nonce + 1, since: stampNow() };
      await c.query("update assignments set data = data || jsonb_build_object('holder', $2::jsonb), rev = rev + 1 where id = $1",
        [p.rec.id, JSON.stringify(holder)]);
      await chain.queueOps(c, [{ bond: p.rec.bond, ref: p.rec.id, fn: "registerHolderKey", args: [...p.args, auth], role: "relayer" }]);
      await c.query("insert into events (eid, bond, assignment, data) values ($1, $2, $3, $4)",
        [crypto.randomUUID(), p.rec.bond, p.rec.id, { bond: p.rec.bond, id: p.rec.id, t: stampNow(), ev: "DeviceKeyRegistered", actor: "HOLDER",
          ref: "Device key " + holderKeys.fingerprint(p.x) }]);
      await bump(c);
      return { ok: true, fingerprint: holderKeys.fingerprint(p.x), credId: p.credId };
    });
    res.json(out);
  }));
}

/* ======================= accounts (issuer and platform consoles) ======================= */

const escHtml = (v) => String(v).replace(/[&<>"']/g, (ch) => "&#" + ch.charCodeAt(0) + ";");
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");
const cleanEmail = (e) => String(e || "").trim().toLowerCase();
function checkPassword(pw) {
  if (String(pw || "").length < 10) throw new Reject(400, "Use a password of at least 10 characters.");
}
const newCode = () => crypto.randomBytes(12).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "")
  .slice(0, 12).padEnd(12, "7").match(/.{4}/g).join("-");
const stampNow = () => {
  const d = new Date();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) + " " +
    String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
};

async function createUser(c, { email, name, password, isAdmin = false, platformRole = null }) {
  if (!validEmail(email)) throw new Reject(400, "Enter a valid email address.");
  if (!String(name || "").trim()) throw new Reject(400, "Enter your name.");
  checkPassword(password);
  const taken = await c.query("select 1 from users where email = $1", [email]);
  if (taken.rows.length) throw new Reject(409, "An account with that email already exists. Sign in instead.");
  const id = newId("usr"), salt = crypto.randomBytes(16).toString("hex");
  await c.query(
    "insert into users (id, email, name, pw_salt, pw_hash, is_admin, platform_role) values ($1, $2, $3, $4, $5, $6, $7)",
    [id, email, String(name).trim(), salt, await hashPassword(password, salt), isAdmin, platformRole]);
  return id;
}

if (APP !== "holder") {
  const COOKIE = APP === "platform" ? "platform_session" : "registrar_session";

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

  var startSession = async (req, res, c, userId) => {
    const token = crypto.randomBytes(32).toString("base64url");
    await c.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + $3::interval)",
      [sha256(token), userId, SESSION_DAYS + " days"]);
    setCookie(req, res, token, SESSION_DAYS * 86400);
  };

  var currentUser = async (req) => {
    const token = readCookie(req);
    if (!token) return null;
    const r = await pool.query(
      `select u.id, u.email, u.name, u.is_admin, u.platform_role from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
    return r.rows[0] || null;
  };

  var needUser = async (req) => {
    const u = await currentUser(req);
    if (!u) throw new Reject(401, "Please sign in.");
    return u;
  };

  app.post("/api/auth/login", wrap(async (req, res) => {
    if (limited("login:" + req.ip)) throw new Reject(429, "Too many attempts. Wait a minute and try again.");
    const email = cleanEmail(req.body?.email);
    const u = (await pool.query("select * from users where email = $1", [email])).rows[0];
    // Same work and same answer whether or not the account exists.
    const salt = u?.pw_salt || "0".repeat(32);
    const h = await hashPassword(req.body?.password || "", salt);
    if (!u || !sameHex(h, u.pw_hash)) throw new Reject(401, "That email and password don't match.");
    if (APP === "platform" && !u.is_admin) throw new Reject(403, "This account isn't platform staff. Issuers sign in on the issuer console.");
    await tx((c) => startSession(req, res, c, u.id));
    res.json({ ok: true });
  }));

  app.post("/api/auth/logout", wrap(async (req, res) => {
    const token = readCookie(req);
    if (token) await pool.query("delete from sessions where token_hash = $1", [sha256(token)]);
    setCookie(req, res, "", 0);
    res.json({ ok: true });
  }));

  // Forgot password. The answer is the same whether or not the account exists.
  app.post("/api/auth/forgot", wrap(async (req, res) => {
    if (limited("forgot:" + req.ip, 5)) throw new Reject(429, "Too many requests. Wait a minute and try again.");
    if (!RESEND_API_KEY) throw new Reject(503, "Password reset by email isn't set up yet. Contact the platform owner.");
    const email = cleanEmail(req.body?.email);
    if (!validEmail(email)) throw new Reject(400, "Enter a valid email address.");
    const u = (await pool.query("select id, email, name, is_admin from users where email = $1", [email])).rows[0];
    const eligible = u && (APP !== "platform" || u.is_admin);
    // One email a minute per account, so the form can't be used to flood an inbox.
    const recent = eligible && (await pool.query(
      "select 1 from password_resets where user_id = $1 and created_at > now() - interval '1 minute'", [u.id])).rows.length;
    if (eligible && !recent) {
      const token = crypto.randomBytes(32).toString("base64url");
      await tx(async (c) => {
        await c.query("delete from password_resets where user_id = $1 and used_at is null", [u.id]);
        await c.query("insert into password_resets (token_hash, user_id, app, expires_at) values ($1, $2, $3, now() + $4::interval)",
          [sha256(token), u.id, APP, RESET_MINUTES + " minutes"]);
      });
      const link = PUBLIC_URL + "/?reset=" + token;
      const where = APP === "platform" ? "the platform console" : "the issuer console";
      try {
        const r = await fetch(RESEND_URL, {
          method: "POST",
          headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: MAIL_FROM, to: [u.email], subject: "Reset your Bond Registry password",
            text: `Hello ${u.name},\n\nSomeone asked to reset the password for ${u.email} on ${where}. ` +
              `To choose a new one, open this link within ${RESET_MINUTES} minutes:\n\n${link}\n\n` +
              `If it wasn't you, ignore this email; your password stays the same.`,
            html: `<p>Hello ${escHtml(u.name)},</p><p>Someone asked to reset the password for ${escHtml(u.email)} on ${where}. ` +
              `To choose a new one, open this link within ${RESET_MINUTES} minutes:</p>` +
              `<p><a href="${escHtml(link)}">Reset your password</a></p>` +
              `<p>If it wasn't you, ignore this email; your password stays the same.</p>`,
          }),
        });
        if (!r.ok) console.error("Password reset email failed:", r.status, await r.text().catch(() => ""));
      } catch (e) { console.error("Password reset email failed:", e.message); }
    }
    res.json({ ok: true });
  }));

  app.post("/api/auth/reset", wrap(async (req, res) => {
    if (limited("reset:" + req.ip, 10)) throw new Reject(429, "Too many attempts. Wait a minute and try again.");
    const token = String(req.body?.token || "");
    checkPassword(req.body?.password);
    await tx(async (c) => {
      const r = (await c.query(
        "select user_id, app from password_resets where token_hash = $1 and used_at is null and expires_at > now() for update",
        [sha256(token)])).rows[0];
      if (!r || r.app !== APP) throw new Reject(400, "This reset link has expired or was already used. Ask for a new one.");
      const salt = crypto.randomBytes(16).toString("hex");
      await c.query("update users set pw_salt = $2, pw_hash = $3 where id = $1",
        [r.user_id, salt, await hashPassword(req.body.password, salt)]);
      await c.query("update password_resets set used_at = now() where token_hash = $1", [sha256(token)]);
      await c.query("delete from password_resets where user_id = $1 and used_at is null", [r.user_id]);
      // Every session on the old password ends, on both consoles.
      await c.query("delete from sessions where user_id = $1", [r.user_id]);
    });
    res.json({ ok: true });
  }));
}

/* ======================= issuer console ======================= */

if (APP === "issuer") {
  // The caller's membership in the issuer named by the request; refuses if there is none.
  async function membership(req, issuerId) {
    const u = await needUser(req);
    const r = await pool.query(
      `select m.role, i.id, i.code, i.legal_name, i.status, i.trusted, i.safe_address from memberships m join issuers i on i.id = m.issuer_id
       where m.user_id = $1 and m.issuer_id = $2`, [u.id, issuerId]);
    if (!r.rows[0]) throw new Reject(403, "You don't have access to this issuer.");
    return { user: u, ...r.rows[0] };
  }

  function checkIssuer(body) {
    const code = String(body?.issuerCode || "").trim().toUpperCase();
    const legalName = String(body?.legalName || "").trim();
    if (!/^[A-Z0-9]{3,6}$/.test(code)) throw new Reject(400, "Use 3 to 6 letters or digits for the issuer code.");
    if (RESERVED_CODES.includes(code)) throw new Reject(400, code + " is reserved. Choose another issuer code.");
    if (legalName.length < 2) throw new Reject(400, "Enter the issuer's legal name.");
    return { code, legalName };
  }
  async function codeFree(c, code) {
    if ((await c.query("select 1 from issuers where code = $1", [code])).rows.length)
      throw new Reject(409, "The issuer code " + code + " is taken. Choose another.");
  }
  // The platform owner's issuers are approved on creation and register live bonds; anyone else's wait for review.
  async function createIssuer(c, { code, legalName }, user) {
    const trusted = user.platform_role === "owner";
    const issuerId = newId("iss");
    await c.query(
      `insert into issuers (id, code, legal_name, status, trusted, reviewed_at, reviewed_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [issuerId, code, legalName, trusted ? "approved" : "pending", trusted, trusted ? new Date() : null, trusted ? user.id : null]);
    await c.query("insert into memberships (user_id, issuer_id, role) values ($1, $2, 'owner')", [user.id, issuerId]);
    await bump(c); // the platform's review queue should see a new application
    return { id: issuerId, trusted };
  }

  // A signed-in person starts another issuer without a new account.
  app.post("/api/issuers", wrap(async (req, res) => {
    const u = await needUser(req);
    const issuer = checkIssuer(req.body);
    const out = await tx(async (c) => {
      await codeFree(c, issuer.code);
      return createIssuer(c, issuer, u);
    });
    res.json(out);
  }));

  app.get("/api/auth/me", wrap(async (req, res) => {
    const u = await currentUser(req);
    if (!u) return res.json({ user: null, issuers: [] });
    const iss = await pool.query(
      `select i.id, i.code, i.legal_name, i.status, m.role from memberships m join issuers i on i.id = m.issuer_id
       where m.user_id = $1 order by i.code`, [u.id]);
    res.json({
      user: { id: u.id, email: u.email, name: u.name, platformOwner: u.platform_role === "owner" },
      issuers: iss.rows.map((i) => ({ id: i.id, code: i.code, legalName: i.legal_name, status: i.status, role: i.role })),
    });
  }));

  // A new issuer applies (pending until the platform approves it), or a teammate joins with an invite code.
  app.post("/api/auth/signup", wrap(async (req, res) => {
    if (limited("signup:" + req.ip, 10)) throw new Reject(429, "Too many attempts. Wait a minute and try again.");
    const { name, password, inviteCode } = req.body || {};
    const email = cleanEmail(req.body?.email);
    await tx(async (c) => {
      if (inviteCode) {
        const inv = (await c.query(
          "select * from invites where code_hash = $1 and kind = 'issuer' for update", [sha256(normKey(inviteCode))])).rows[0];
        if (!inv || inv.used_by || new Date(inv.expires_at) < new Date())
          throw new Reject(400, "That invite code isn't valid. Ask your issuer's owner for a new one.");
        const id = await createUser(c, { email, name, password });
        await c.query("insert into memberships (user_id, issuer_id, role) values ($1, $2, 'member')", [id, inv.issuer_id]);
        await c.query("update invites set used_by = $1 where code_hash = $2", [id, inv.code_hash]);
        await startSession(req, res, c, id);
        return;
      }
      const issuer = checkIssuer(req.body);
      await codeFree(c, issuer.code);
      const id = await createUser(c, { email, name, password });
      await createIssuer(c, issuer, { id, platform_role: null });
      await startSession(req, res, c, id);
    });
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
    const code = newCode();
    await pool.query(
      "insert into invites (code_hash, issuer_id, created_by, expires_at, kind) values ($1, $2, $3, now() + $4::interval, 'issuer')",
      [sha256(normKey(code)), m.id, m.user.id, INVITE_DAYS + " days"]);
    res.json({ code, expiresInDays: INVITE_DAYS });
  }));

  /* ---- the register, scoped to one issuer ---- */

  app.get("/api/state", wrap(async (req, res) => {
    const m = await membership(req, req.query.issuer);
    const v = await version(pool);
    if (req.query.since && Number(req.query.since) === v) return res.json({ version: v, unchanged: true });
    const state = await readState("b.issuer_id = $1", [m.id]);
    res.json({ version: v, ...state, issuer: { id: m.id, code: m.code, legalName: m.legal_name, status: m.status, role: m.role, trusted: m.trusted, safe: m.safe_address || null } });
  }));

  app.post("/api/commit", wrap(async (req, res) => {
    const { issuer, base, bonds = [], reg = [], events = [] } = req.body || {};
    const m = await membership(req, issuer);
    if (m.status === "suspended") throw new Reject(403, "This issuer is suspended. Contact the platform.");
    if (m.status !== "approved") throw new Reject(403, "You can register bonds once the platform approves your issuer account.");
    const nv = await tx(async (c) => {
      const review = new Map((await c.query("select id, review from bonds where issuer_id = $1", [m.id])).rows
        .map((r) => [r.id, r.review]));
      for (const b of bonds) {
        if (!String(b.id).startsWith(m.code + "-")) throw new Reject(403, "Bond IDs must start with " + m.code + "-.");
        const owner = (await c.query("select issuer_id, data, review from bonds where id = $1", [b.id])).rows[0];
        if (owner && owner.issuer_id !== m.id) throw new Reject(403, "That bond belongs to another issuer.");
        if (owner?.review === "rejected") throw new Reject(422, b.id + " was not approved by the platform and can't be changed.");
        if (!Number.isInteger(b.total) || b.total <= 0) throw new Reject(400, "A bond needs a whole number of units.");
        // What was anchored stays fixed: the total and the instrument's hash. The UCC-1 and master
        // agreement can be added or corrected until the bond is approved, then they are fixed too.
        if (owner && ["total", "instrumentHash"].some((k) => owner.data[k] !== b[k]))
          throw new Reject(422, b.id + " was registered with a fixed total and instrument hash; they can't change.");
        // An approved bond registered before UCC-1s were recorded may add one, once.
        if (owner?.review === "approved" && ucc1Complete(owner.data) && !sameUcc1(owner.data.ucc1, b.ucc1))
          throw new Reject(422, b.id + " is approved, so its UCC-1 is fixed.");
        if (owner?.review === "approved" && (owner.data.masterHash || null) !== (b.masterHash || null))
          throw new Reject(422, b.id + " is approved, so its master agreement is fixed.");
        if (b.ucc1 && !ucc1Complete(b)) throw new Reject(400, "Enter the UCC-1's filing number, office, date and filed copy.");
        checkPrior(b, owner?.data);
        if (m.trusted && ucc1Complete(b) && (!owner || owner.review === "pending")) review.set(b.id, "approved");
        else if (!owner) review.set(b.id, "pending");
      }
      const clean = [];
      for (const raw of reg) {
        const a = cleanRecord(raw);
        if (!review.has(a.bond)) throw new Reject(403, "That record belongs to another issuer.");
        if (review.get(a.bond) !== "approved") throw new Reject(403, "Assignments open once the platform approves " + a.bond + ".");
        const before = (await c.query("select bond, data from assignments where id = $1", [a.id])).rows[0];
        if (before && before.bond !== a.bond) throw new Reject(403, "A record can't move to another bond.");
        needsDocument(before, a);
        const n = chain.normalizeRecord(a);
        // The response period runs from when the mailing is recorded.
        n.deliveredAt = before?.data?.deliveredAt || (n.deliveryRef ? new Date().toISOString() : null);
        clean.push(n);
      }
      for (const e of events) if (!review.has(e.bond)) throw new Reject(403, "That event belongs to another issuer.");
      const revs = await applyCommit(c, { bonds, reg: clean, events, issuerId: m.id, autoApprove: m.trusted });
      return { version: await bump(c), revs };
    });
    res.json(nv);
  }));

  // The caller must belong to the issuer whose approved bond holds this record.
  async function recordAccess(req) {
    const { issuer, id } = req.body || {};
    const m = await membership(req, issuer);
    if (m.status !== "approved") throw new Reject(403, "Credentials open once the platform approves this issuer.");
    const known = (await pool.query("select bond from assignments where id = $1", [id])).rows[0];
    // A brand-new record is saved just after its passkey, so its bond comes from its ID.
    const bondId = known?.bond || String(id || "").slice(0, String(id || "").lastIndexOf("-A"));
    const b = (await pool.query("select issuer_id, review from bonds where id = $1", [bondId])).rows[0];
    if (!b || b.issuer_id !== m.id) throw new Reject(403, "That record belongs to another issuer.");
    if (b.review !== "approved") throw new Reject(403, "Credentials open once the platform approves " + bondId + ".");
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

  // Opens a new assignee's sealed access code, once, so the issuer can mail it at activation.
  app.post("/api/issuer/access-code/reveal", wrap(async (req, res) => {
    await recordAccess(req);
    const { id } = req.body || {};
    const out = await tx(async (c) => {
      const row = (await c.query("select * from sealed_codes where id = $1 for update", [id])).rows[0];
      if (!row) throw new Reject(404, "No sealed access code for " + id + ".");
      if (row.revealed_at) throw new Reject(409, "This access code was already shown (" + row.revealed_at.toISOString().slice(0, 10) + "). If it's lost, issue a new one.");
      const d = (await c.query("select data from assignments where id = $1", [id])).rows[0]?.data;
      if (d?.status !== "CredentialRequested") throw new Reject(409, "Open the access code when you activate the assignee, after verifying them.");
      const code = unseal(row.sealed);
      await c.query("update sealed_codes set sealed = '', revealed_at = now(), revealed_by = $2 where id = $1", [id, (await currentUser(req))?.email || "issuer"]);
      return { code };
    });
    res.json(out);
  }));

  // Recovery when a holder loses their device: clears the record's device key, on-chain too (signed
  // through the issuer's Safe). The holder registers a new device at their next sign-in, usually
  // with a new access code mailed after the issuer verifies them.
  app.post("/api/issuer/holder-key/clear", wrap(async (req, res) => {
    await recordAccess(req);
    const { id, reason } = req.body || {};
    if (!String(reason || "").trim()) throw new Reject(400, "Say how you verified the holder, for the record.");
    await tx(async (c) => {
      const row = (await c.query("select bond, data from assignments where id = $1 for update", [id])).rows[0];
      if (!row) throw new Reject(404, "No such record.");
      const k = row.data.holder;
      if (!k || k.contract !== (chain.CONTRACT || "local") || !k.x) throw new Reject(409, id + " has no device key to reset.");
      const holder = { ...k, x: null, y: null, credId: null, clearedOn: stampNow() };
      await c.query("update assignments set data = data || jsonb_build_object('holder', $2::jsonb), rev = rev + 1 where id = $1",
        [id, JSON.stringify(holder)]);
      await chain.queueOps(c, [{ bond: row.bond, ref: id, fn: "clearHolderKey",
        args: [chain.id32(row.bond), chain.id32(id), chain.noteDoc(id, "clearHolderKey", stampNow() + " " + String(reason).trim())], role: "issuer" }]);
      await c.query("insert into events (eid, bond, assignment, data) values ($1, $2, $3, $4)",
        [crypto.randomUUID(), row.bond, id, { bond: row.bond, id, t: stampNow(), ev: "DeviceKeyReset", actor: "ISSUER", ref: String(reason).trim() }]);
      await bump(c);
    });
    res.json({ ok: true });
  }));

  // Chain writes waiting on this issuer's Safe, and a signature for one of them.
  app.get("/api/issuer/signing", wrap(async (req, res) => {
    const m = await membership(req, req.query.issuer);
    res.json({ safe: m.safe_address || null, items: await chain.awaitingSignature(pool, m.safe_address),
      recent: await chain.recentForSafe(pool, m.safe_address), contract: chain.CONTRACT });
  }));

  app.post("/api/issuer/sign", wrap(async (req, res) => {
    const m = await membership(req, req.body?.issuer);
    if (!m.safe_address) throw new Reject(409, "This issuer doesn't sign through a Safe.");
    const r = await chain.addSignature(pool, Number(req.body?.seq), m.safe_address, String(req.body?.signature || ""));
    if (!r.ok) throw new Reject(422, r.error);
    res.json(r);
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

/* ======================= platform console ======================= */

if (APP === "platform") {
  const needStaff = async (req) => {
    const u = await needUser(req);
    if (!u.is_admin) throw new Reject(403, "Only platform staff can do this.");
    return u;
  };
  const isOwner = (u) => u.platform_role === "owner";

  app.get("/api/auth/me", wrap(async (req, res) => {
    const needsSetup = (await pool.query("select 1 from users where is_admin limit 1")).rows.length === 0;
    const u = await currentUser(req);
    if (!u || !u.is_admin) return res.json({ user: null, needsSetup });
    res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.platform_role }, needsSetup });
  }));

  // One-time creation of the platform owner, with the setup code set on this service.
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
      const id = await createUser(c, { email, name, password, isAdmin: true, platformRole: "owner" });
      // The owner takes over any issuer nobody belongs to yet, such as the sample register.
      await c.query(
        `insert into memberships (user_id, issuer_id, role)
         select $1, i.id, 'owner' from issuers i where not exists (select 1 from memberships m where m.issuer_id = i.id)`, [id]);
      await c.query(
        "update issuers set trusted = true, status = 'approved' where id in (select issuer_id from memberships where user_id = $1)", [id]);
      await startSession(req, res, c, id);
    });
    res.json({ ok: true });
  }));

  // Platform staff join with a one-time code from the owner.
  app.post("/api/auth/signup", wrap(async (req, res) => {
    if (limited("signup:" + req.ip, 10)) throw new Reject(429, "Too many attempts. Wait a minute and try again.");
    const { name, password, inviteCode } = req.body || {};
    const email = cleanEmail(req.body?.email);
    await tx(async (c) => {
      const inv = (await c.query(
        "select * from invites where code_hash = $1 and kind = 'platform' for update", [sha256(normKey(inviteCode))])).rows[0];
      if (!inv || inv.used_by || new Date(inv.expires_at) < new Date())
        throw new Reject(400, "That invite code isn't valid. Ask the platform owner for a new one.");
      const id = await createUser(c, { email, name, password, isAdmin: true, platformRole: "staff" });
      await c.query("update invites set used_by = $1 where code_hash = $2", [id, inv.code_hash]);
      await startSession(req, res, c, id);
    });
    res.json({ ok: true });
  }));

  app.get("/api/platform/summary", wrap(async (req, res) => {
    await needStaff(req);
    const r = await pool.query(`select
      (select count(*)::int from issuers where status = 'pending') as pending_issuers,
      (select count(*)::int from bonds b join issuers i on i.id = b.issuer_id where b.review = 'pending' and i.status = 'approved') as pending_bonds,
      (select version from meta where k = 'v') as version`);
    res.json({ pendingIssuers: r.rows[0].pending_issuers, pendingBonds: r.rows[0].pending_bonds, version: Number(r.rows[0].version) });
  }));

  app.get("/api/platform/issuers", wrap(async (req, res) => {
    await needStaff(req);
    const r = await pool.query(`
      select i.id, i.code, i.legal_name, i.status, i.trusted, i.created_at, i.reviewed_at,
        (select name from users where id = i.reviewed_by) as reviewer,
        (select count(*)::int from bonds b where b.issuer_id = i.id) as bonds,
        (select count(*)::int from bonds b where b.issuer_id = i.id and b.review = 'approved') as live_bonds,
        (select count(*)::int from memberships m where m.issuer_id = i.id) as members,
        (select u.email from memberships m join users u on u.id = m.user_id
          where m.issuer_id = i.id and m.role = 'owner' order by m.created_at limit 1) as owner_email,
        (select u.name from memberships m join users u on u.id = m.user_id
          where m.issuer_id = i.id and m.role = 'owner' order by m.created_at limit 1) as owner_name
      from issuers i order by (i.status = 'pending') desc, i.created_at desc`);
    res.json({ issuers: r.rows.map((i) => ({ id: i.id, code: i.code, legalName: i.legal_name, status: i.status, trusted: i.trusted,
      createdAt: i.created_at, reviewedAt: i.reviewed_at, reviewer: i.reviewer, bonds: i.bonds, liveBonds: i.live_bonds,
      members: i.members, ownerEmail: i.owner_email, ownerName: i.owner_name })) });
  }));

  app.post("/api/platform/issuers/:id/status", wrap(async (req, res) => {
    const u = await needStaff(req);
    const status = req.body?.status;
    if (!["approved", "suspended"].includes(status)) throw new Reject(400, "Unknown status.");
    const v = await tx(async (c) => {
      const r = await c.query("update issuers set status = $2, reviewed_at = now(), reviewed_by = $3 where id = $1 returning code",
        [req.params.id, status, u.id]);
      if (!r.rowCount) throw new Reject(404, "No such issuer.");
      await chain.queueIssuerStatus(c, req.params.id, r.rows[0].code, status);
      return bump(c);
    });
    res.json({ version: v });
  }));

  // The directory: every bond's totals and documents, with no holder names or contact details.
  app.get("/api/platform/bonds", wrap(async (req, res) => {
    await needStaff(req);
    const r = await pool.query(`
      select b.id, b.data, b.review, b.review_note, b.reviewed_at,
        (select name from users where id = b.reviewed_by) as reviewer,
        i.id as issuer_id, i.code, i.legal_name, i.status as issuer_status,
        coalesce((select sum((a.data->>'units')::numeric) from assignments a
          where a.bond = b.id and a.data->>'status' not in ('Redeemed','Superseded','Cancelled','Rejected')), 0) as assigned,
        (select count(*)::int from assignments a
          where a.bond = b.id and a.data->>'status' not in ('Redeemed','Superseded','Cancelled','Rejected')) as live_records,
        (select count(*)::int from assignments a where a.bond = b.id) as all_records
      from bonds b join issuers i on i.id = b.issuer_id
      order by (b.review = 'pending' and i.status = 'approved') desc, b.id`);
    res.json({ bonds: r.rows.map((x) => {
      const prior = (x.data.prior || []).filter((p) => !p.reversed);
      return {
        id: x.id, title: x.data.title || null, registered: x.data.registered || null,
        issuer: { id: x.issuer_id, code: x.code, legalName: x.legal_name, status: x.issuer_status },
        review: x.review, reviewNote: x.review_note, reviewedAt: x.reviewed_at, reviewer: x.reviewer,
        total: x.data.total, unassigned: x.data.unassigned, redeemed: x.data.redeemed || 0,
        assigned: Number(x.assigned), priorUnits: prior.reduce((t, p) => t + p.units, 0), priorCount: prior.length,
        liveRecords: x.live_records, allRecords: x.all_records,
        instrumentHash: x.data.instrumentHash, instrumentFile: x.data.instrumentFile || null,
        ucc1: x.data.ucc1 || null, ucc1Complete: ucc1Complete(x.data),
        legacyHash: x.data.declarationHash || null, legacyFile: x.data.declarationFile || null,
        masterHash: x.data.masterHash || null, masterFile: x.data.masterFile || null,
      };
    }) });
  }));

  app.post("/api/platform/bonds/:id/review", wrap(async (req, res) => {
    const u = await needStaff(req);
    const decision = req.body?.decision;
    const note = String(req.body?.note || "").trim();
    if (!["approved", "rejected"].includes(decision)) throw new Reject(400, "Approve or reject the bond.");
    if (decision === "rejected" && !note) throw new Reject(400, "Give the issuer a reason for rejecting the bond.");
    const v = await tx(async (c) => {
      const b = (await c.query(
        "select b.review, b.data, i.status from bonds b join issuers i on i.id = b.issuer_id where b.id = $1 for update of b", [req.params.id])).rows[0];
      if (!b) throw new Reject(404, "No such bond.");
      if (b.review !== "pending") throw new Reject(409, "This bond has already been reviewed.");
      if (decision === "approved" && !ucc1Complete(b.data)) throw new Reject(409, "The issuer hasn't recorded this bond's UCC-1 yet.");
      if (b.status !== "approved") throw new Reject(409, "Approve the issuer before its bonds.");
      await c.query("update bonds set review = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() where id = $1",
        [req.params.id, decision, note || null, u.id]);
      if (decision === "approved") await chain.queueAnchor(c, req.params.id);
      const ev = decision === "approved" ? "BondApproved" : "BondRejected";
      await c.query("insert into events (eid, bond, assignment, data) values ($1, $2, '—', $3)",
        [crypto.randomUUID(), req.params.id,
          { bond: req.params.id, id: "—", t: stampNow(), ev, actor: "PLATFORM", ref: note ? "0x" + sha256(note).slice(0, 6) + "…" + sha256(note).slice(-4) : "—" }]);
      return bump(c);
    });
    res.json({ version: v });
  }));

  // The chain mirror: queue counts and anything the contract refused.
  // Chain writes waiting on the platform's Safe (registering and suspending issuers), and a signature.
  app.get("/api/platform/signing", wrap(async (req, res) => {
    await needStaff(req);
    res.json({ safe: chain.PLATFORM_SAFE, items: await chain.awaitingSignature(pool, chain.PLATFORM_SAFE),
      recent: await chain.recentForSafe(pool, chain.PLATFORM_SAFE), contract: chain.CONTRACT });
  }));

  app.post("/api/platform/sign", wrap(async (req, res) => {
    const u = await needStaff(req);
    if (!isOwner(u)) throw new Reject(403, "Only the platform owner can sign for the platform.");
    if (!chain.PLATFORM_SAFE) throw new Reject(409, "The platform doesn't sign through a Safe.");
    const r = await chain.addSignature(pool, Number(req.body?.seq), chain.PLATFORM_SAFE, String(req.body?.signature || ""));
    if (!r.ok) throw new Reject(422, r.error);
    res.json(r);
  }));

  app.get("/api/platform/chain", wrap(async (req, res) => {
    await needStaff(req);
    res.json(await chain.summary(pool));
  }));

  // Freezes this contract so a new version can copy it. Owner only; approved through the platform's Safe.
  app.post("/api/platform/chain/freeze", wrap(async (req, res) => {
    const u = await needStaff(req);
    if (!isOwner(u)) throw new Reject(403, "Only the platform owner can freeze the contract.");
    try { await chain.freezeForMove(pool); } catch (e) { throw new Reject(e.status || 409, e.message); }
    res.json({ ok: true });
  }));

  app.post("/api/platform/chain/retry", wrap(async (req, res) => {
    const u = await needStaff(req);
    if (!isOwner(u)) throw new Reject(403, "Only the platform owner can retry chain writes.");
    if (!(await chain.retry(pool, Number(req.body?.seq)))) throw new Reject(404, "That write isn't waiting on a retry.");
    res.json({ ok: true });
  }));

  app.get("/api/platform/staff", wrap(async (req, res) => {
    await needStaff(req);
    const r = await pool.query("select name, email, platform_role, created_at from users where is_admin order by created_at");
    res.json({ staff: r.rows.map((x) => ({ name: x.name, email: x.email, role: x.platform_role })) });
  }));

  app.post("/api/platform/invite", wrap(async (req, res) => {
    const u = await needStaff(req);
    if (!isOwner(u)) throw new Reject(403, "Only the platform owner can invite staff.");
    const code = newCode();
    await pool.query(
      "insert into invites (code_hash, issuer_id, created_by, expires_at, kind) values ($1, null, $2, now() + $3::interval, 'platform')",
      [sha256(normKey(code)), u.id, INVITE_DAYS + " days"]);
    res.json({ code, expiresInDays: INVITE_DAYS });
  }));
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", APP);
// The holder site's front page: the public landing with the Holder and
// Issuer sign-in buttons. The holder portal itself lives at /holder.
if (APP === "holder") {
  const ISSUER_URL = process.env.ISSUER_URL || "https://registrar-production-1538.up.railway.app";
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  let home = null;
  const sendHome = async (req, res, next) => {
    try {
      if (home === null) {
        const raw = await fs.readFile(path.join(dir, "home.html"), "utf8");
        home = raw.replaceAll("__ISSUER_URL__", esc(ISSUER_URL));
      }
      res.type("html").send(home);
    } catch (e) { next(e); }
  };
  app.get("/", sendHome);
  app.get("/home.html", sendHome);
}
app.use(express.static(dir, { index: false }));
app.get("*", (req, res) => res.sendFile(path.join(dir, "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error. Nothing was saved." });
});

migrate()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => console.log(`${APP} listening on ${PORT}`));
    chain.startWorker(pool);
    if (APP === "issuer") {
      const run = () => takeEffectWhenDue().catch((e) => console.error("Taking effect:", e.message));
      setTimeout(run, 5000);
      setInterval(run, Number(process.env.RESPONSE_CHECK_MS || 10 * 60_000));
    }
  })
  .catch((e) => { console.error("Migration failed", e); process.exit(1); });
