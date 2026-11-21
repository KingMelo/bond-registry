// End-to-end: holders act only with their own passkey.
// The servers run against a local Postgres; this script plays the holder's phone, making P-256
// passkeys and WebAuthn responses exactly as a browser would. Every signed act is kept, and the
// suite checks each kept signature again at the end.
//
// Needs Postgres on 127.0.0.1:54329. Run from the repo root: node e2e/holder-keys-e2e.mjs
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pg = require("pg");
// A fake phone: passkeys that answer like a browser's WebAuthn.
import { newDevice, created, signs, holderPasskeySignIn } from "./fake-device.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DB = "postgres://postgres@127.0.0.1:54329/hke";
const I = "http://127.0.0.1:4992", P = "http://127.0.0.1:4993", H = "http://127.0.0.1:4994";
const RP_ID = "holder.test";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const H32 = () => "0x" + crypto.randomBytes(32).toString("hex");
const b64u = (b) => Buffer.from(b).toString("base64url");

// ---------- servers
const records = await import(ROOT + "/server/records.js");
const holderKeys = await import(ROOT + "/server/holder-keys.js");
execSync(`psql -h 127.0.0.1 -p 54329 -U postgres -q -c "drop database if exists hke" -c "create database hke"`, { stdio: "ignore" });
const procs = [];
process.on("exit", () => procs.forEach((c) => c.kill())); // stop the servers even when a step throws
const start = (app, port, extra = {}) => new Promise((res, rej) => {
  const c = spawn("node", ["server/index.js"], { cwd: ROOT, env: { ...process.env, APP: app, PORT: String(port), DATABASE_URL: DB, SEED_SAMPLE: "0",
    ADMIN_SETUP_CODE: "setup-123", PASSKEY_PEPPER: "x",
    HOLDER_RP_ID: RP_ID, HOLDER_ORIGIN: "https://holder.test", RESPONSE_CHECK_MS: "1500", ...extra } });
  procs.push(c); let out = "";
  c.stdout.on("data", (d) => { out += d; process.env.VERBOSE && process.stdout.write("[" + app + "] " + d); if (out.includes("listening")) res(c); });
  c.stderr.on("data", (d) => process.stdout.write("[" + app + " err] " + d));
  setTimeout(() => rej(new Error(app + " didn't start")), 20000);
});
await start("platform", 4993);
await start("issuer", 4992);
await start("holder", 4994);

const jar = {};
async function call(base, method, path, body) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: base, Cookie: jar[base] || "" }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) jar[base] = sc.split(";")[0];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(path + " " + r.status + " " + (j.error || "")); e.status = r.status; throw e; }
  return j;
}
const tryCall = async (...a) => { try { await call(...a); return null; } catch (e) { return e; } };
await call(P, "POST", "/api/auth/setup", { setupCode: "setup-123", name: "Owner", email: "o@x.test", password: "owner-pass-123" });
await call(I, "POST", "/api/auth/login", { email: "o@x.test", password: "owner-pass-123" });
await call(P, "POST", "/api/auth/login", { email: "o@x.test", password: "owner-pass-123" });
const iss = await call(I, "POST", "/api/issuers", { legalName: "Penson Trust", issuerCode: "PENS" });
const issuerId = iss.issuer?.id || (await call(I, "GET", "/api/auth/me")).issuers[0].id;

const st = () => call(I, "GET", "/api/state?issuer=" + issuerId);
const hst = () => call(H, "GET", "/api/state");
let n = 0; const ev = (bond, id, name, ref = "—") => ({ eid: "e" + (++n) + "-" + Date.now(), bond, id, t: "now", ev: name, actor: "X", ref });
const icommit = async ({ bonds = [], reg = [], events = [] }) => call(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds, reg, events });
const rec = async (id) => (await st()).reg.find((a) => a.id === id);
const hrec = async (id) => (await hst()).reg.find((a) => a.id === id);
const bondNow = async () => (await st()).bonds.find((b) => b.id === "PENS-0001-BD");
// The passkey signatures kept for a record (or signed by it).
async function sigs(where, id) {
  const db = new pg.Client({ connectionString: DB }); await db.connect();
  const r = (await db.query(`select * from holder_signatures where ${where} = $1 order by seq`, [id])).rows; await db.end();
  return r;
}

/** Signs in with the mailed code; registers the device if the record has none yet. */
async function signIn(id, code, dev) {
  const r = await call(H, "POST", "/api/holder/signin", { id, passkey: code });
  if (!r.ok) throw new Error("sign-in failed: " + r.code);
  if (r.enroll && dev) {
    const c = created(dev, r.enroll);
    const p = await call(H, "POST", "/api/holder/key/prepare", { token: r.token, ...c });
    r.since = (await call(H, "POST", "/api/holder/key", { token: r.token, ...c, assertion: signs(dev, p.challenge) })).since;
  }
  return r;
}
/** A holder save: ask what to sign, sign it on the device, then save. */
async function hsave(token, dev, body, o = {}) {
  const full = { base: (await hst()).version, bonds: [], events: [], ...body, token };
  const { sign } = await call(H, "POST", "/api/holder/prepare", full);
  const assertions = sign.map((x) => signs(o.signWith || dev, x.challenge, o));
  return call(H, "POST", "/api/commit", { ...full, assertions });
}

// 1. Bond and an issued assignment, mailed with its access code.
const TOTAL = 10_000_000_000;
await icommit({ bonds: [{ id: "PENS-0001-BD", title: "Series A", face: TOTAL, total: TOTAL, unassigned: TOTAL, redeemed: 0, prior: [],
  registered: "Nov 8, 2026", instrumentHash: H32(), ucc1: { number: "DE-1", office: "Delaware", date: "Nov 7, 2026", hash: H32(), file: "u.pdf" } }] });
const base = { origin: "Issuer", parent: null, assignor: "Penson Trust", party: "Company A", contact: "D", position: "", address: "addr",
  status: "Issued", created: "Nov 9, 2026", accepted: null, filingRef: null, deliveryRef: null, instrumentMail: null, passkeyMail: null };
async function issue(id, units, code) {
  const b = await bondNow();
  await call(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id, passkey: code });
  await icommit({ bonds: [{ ...b, unassigned: b.unassigned - units }], reg: [{ ...base, id, bond: "PENS-0001-BD", units, issuedUnits: units, docHash: H32() }],
    events: [ev("PENS-0001-BD", id, "AssignmentIssued")] });
  const r = await rec(id);
  if (id.endsWith("A00001")) {
    const bad = await tryCall(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], events: [],
      reg: [{ ...r, instrumentMail: "9407 " + id.slice(-5), passkeyMail: "9407 " + id.slice(-5) }] });
    ok(bad?.status === 400, "the issuer's mailing needs the date sent and the certified mail receipt (" + bad?.status + ")");
  }
  await icommit({ reg: [{ ...r, instrumentMail: "9407 " + id.slice(-5), passkeyMail: "9407 " + id.slice(-5), mailedOn: new Date().toISOString().slice(0, 10), mailingDoc: H32() }] });
}
const CODE1 = "7KQM-R4XW-9TPH-C2NV";
await issue("PENS-0001-BD-A00001", 1_000_000, CODE1);

// 2. Nobody acts for the holder without signing in, and signing in alone isn't enough.
let a1 = await hrec("PENS-0001-BD-A00001");
let e = await tryCall(H, "POST", "/api/commit", { reg: [{ ...a1, status: "Accepted" }], events: [] });
ok(e?.status === 401, "a save with no session is refused (" + e?.status + ")");
const phone = newDevice();
const s1 = await call(H, "POST", "/api/holder/signin", { id: a1.id, passkey: CODE1 });
ok(s1.ok && s1.token && s1.enroll && !s1.device, "the mailed code opens a session and asks the device for a key");
e = await tryCall(H, "POST", "/api/commit", { token: s1.token, reg: [{ ...a1, status: "Accepted" }], events: [] });
ok(e?.status === 409, "before the device is set up, no holder action is accepted (" + e?.status + ")");
// A key that wasn't made on this site is refused.
{
  const c = created(phone, s1.enroll);
  const bad = { ...c, clientDataJSON: b64u(JSON.stringify({ type: "webauthn.create", challenge: s1.enroll.challenge, origin: "https://evil.test" })) };
  e = await tryCall(H, "POST", "/api/holder/key/prepare", { token: s1.token, ...bad });
  ok(e?.status === 422, "a passkey made for another site is refused (" + e?.status + ")");
  const p = await call(H, "POST", "/api/holder/key/prepare", { token: s1.token, ...c });
  e = await tryCall(H, "POST", "/api/holder/key", { token: s1.token, ...c, assertion: signs(newDevice(), p.challenge) });
  ok(e?.status === 422, "registering a key needs that key's own signature (" + e?.status + ")");
  await call(H, "POST", "/api/holder/key", { token: s1.token, ...c, assertion: signs(phone, p.challenge) });
}
a1 = await hrec(a1.id);
ok(!!a1.deviceKey?.fingerprint, "the record shows its device key " + a1.deviceKey?.fingerprint);
e = await tryCall(H, "POST", "/api/holder/key/prepare", { token: s1.token, ...created(newDevice(), s1.enroll) });
ok(e?.status === 409, "a second device can't quietly replace the key (" + e?.status + ")");

// 3. Signed actions: a forged or missing signature is refused; the holder's own goes through.
e = await tryCall(H, "POST", "/api/commit", { token: s1.token, reg: [{ ...a1, status: "Accepted" }], events: [] });
ok(e?.status === 400, "an action without the device's signature is refused (" + e?.status + ")");
e = await hsave(s1.token, phone, { reg: [{ ...a1, status: "Accepted" }] }, { signWith: newDevice() }).then(() => null, (x) => x);
ok(e?.status === 422, "a signature from another device is refused (" + e?.status + ")");
e = await hsave(s1.token, phone, { reg: [{ ...a1, status: "Accepted" }] }, { flags: 0x01 }).then(() => null, (x) => x);
ok(e?.status === 422, "a signature without the fingerprint/face/PIN check is refused (" + e?.status + ")");
await hsave(s1.token, phone, { reg: [{ ...a1, status: "Accepted", accepted: "now", effective: "holder" }], events: [ev(a1.bond, a1.id, "Acknowledged")] });
ok((await hrec(a1.id)).status === "Accepted", "the holder's signed acknowledgement is saved");

// 4. Assign out $10.40 (signed by the assignor). It's open to the assignee at once.
a1 = await hrec(a1.id);
const child = { id: "PENS-0001-BD-A00001-1", bond: "PENS-0001-BD", parent: a1.id, origin: "AssignOut", assignor: "Company A", party: "Company D",
  contact: "M", position: "", address: "addr", units: 1040, issuedUnits: 1040, status: "Issued", created: "Nov 9, 2026",
  accepted: null, docHash: H32(), filingRef: null, deliveryRef: null };
e = await hsave(s1.token, phone, { reg: [{ ...a1, units: a1.units - 1040 }, { ...child, id: "PENS-0001-BD-A00009" }] }).then(() => null, (x) => x);
ok(e?.status === 400, "an assign-out can't take an issuer-style ID (" + e?.status + ")");
e = await hsave(s1.token, phone, { reg: [{ ...a1, units: a1.units - 1040 }, { ...child, id: "PENS-0001-BD-A00001-1-1" }] }).then(() => null, (x) => x);
ok(e?.status === 400, "nor a second dash: everything under A00001 is A00001-<n> (" + e?.status + ")");
await hsave(s1.token, phone, { reg: [{ ...a1, units: a1.units - 1040 }, child], events: [ev(a1.bond, child.id, "AssignedOut")] });
ok(child.id === "PENS-0001-BD-A00001-1", "an assign-out from A00001 is numbered A00001-1");
ok((await rec(child.id)).accessCode === "unused", "the assign-out made the assignee's transfer code");
ok(!JSON.stringify(await call(H, "GET", "/api/state")).includes("accessCode"), "the public record list never carries it");
const CODE2 = (await call(H, "POST", "/api/holder/assignee-code", { token: s1.token, id: child.id })).code;
ok(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(CODE2), "the assignor gets the new assignee's transfer code: " + CODE2.slice(0, 4) + "-…");
const again = (await call(H, "POST", "/api/holder/assignee-code", { token: s1.token, id: child.id })).code;
const byIssuer = (await call(I, "POST", "/api/issuer/access-code/reveal", { issuer: issuerId, id: child.id })).code;
const byIssuer2 = (await call(I, "POST", "/api/issuer/access-code/reveal", { issuer: issuerId, id: child.id })).code;
ok(again === CODE2 && byIssuer === CODE2 && byIssuer2 === CODE2, "the issuer (and assignor) can review it as many times as needed until it's used");
e = await tryCall(H, "POST", "/api/commit", { reg: [{ ...(await hrec(child.id)), status: "CredentialRequested" }], events: [] });
ok([401, 403].includes(e?.status), "there's no unsigned 'request access' path any more (" + e?.status + ")");
let c2 = await hrec(child.id);

// 5. The new holder signs in on their own phone and rejects it, with a reason: the $10.40 goes back.
const LONG = "The amount on the instrument I received does not match the register, and I never agreed to take this portion. " +
  "I have not signed anything with the assignor about it and I would like the issuer to look into how this assignment was created. " +
  "Please return the amount to the assignor's record.";
const phone2 = newDevice();
const s2 = await signIn(child.id, CODE2, phone2);
{
  const old = await call(H, "POST", "/api/holder/signin", { id: child.id, passkey: CODE2 }).catch((x) => ({ ok: false, code: x.status }));
  ok(!old.ok, "the transfer code the assignor knew no longer opens the record (" + old.code + ")");
  const st = await call(H, "POST", "/api/holder/start", { id: child.id });
  ok(st.mode === "passkey" && !!st.since, "Holder access now asks for the passkey, set up " + st.since);
  const bad = await holderPasskeySignIn(call, H, child.id, phone2, { signWith: newDevice() }).then(() => null, (x) => x);
  ok(bad?.status === 422, "another device can't sign in (" + bad?.status + ")");
  const mine = await holderPasskeySignIn(call, H, child.id, phone2);
  ok(mine.ok && !!mine.token && mine.device?.since === st.since, "the new holder's own passkey does");
}
a1 = await hrec(a1.id); c2 = await hrec(child.id);
e = await tryCall(H, "POST", "/api/commit", { token: s2.token, reg: [{ ...a1, party: "Company D" }], events: [] });
ok(e?.status === 403, "the new holder can't edit their assignor's record (" + e?.status + ")");
e = await hsave(s2.token, phone2, { reg: [{ ...c2, units: c2.units + 500 }, { ...a1, units: a1.units - 500 }] }).then(() => null, (x) => x);
ok(e?.status === 422, "nor move units from it into their own (" + e?.status + ")");
e = await hsave(s1.token, phone, { reg: [{ ...c2, status: "Rejected", rejectionReason: LONG }, { ...a1, units: a1.units + 1040 }] }).then(() => null, (x) => x);
ok(e?.status === 403, "the assignor can't reject on the new holder's behalf (" + e?.status + ")");
e = await hsave(s1.token, phone, { reg: [{ ...a1, units: a1.units + 1 }] }).then(() => null, (x) => x);
ok(e?.status === 422, "a holder can't raise their own amount (" + e?.status + ")");
e = await hsave(s2.token, phone2, { reg: [{ ...c2, status: "Rejected", rejectionReason: "Not the amount we agreed." }, { ...a1, units: a1.units + 1040 }] }).then(() => null, (x) => x);
ok(e?.status === 400 && /255/.test(e.message), "a rejection needs at least 255 characters of reason (" + e?.status + ")");
await hsave(s2.token, phone2, { reg: [{ ...c2, status: "Rejected", rejectionReason: LONG }, { ...a1, units: a1.units + 1040 }],
  events: [ev(c2.bond, c2.id, "AssignmentRejected", "see reason")] });
ok((await hrec(a1.id)).units === 1_000_000, "the rejected $10.40 is back on A00001");
e = await tryCall(I, "POST", "/api/issuer/access-code/reveal", { issuer: issuerId, id: child.id });
ok(e?.status === 404, "once used, the transfer code is gone for the issuer too (" + e?.status + ")");

// 5b. The UCC-3 for an assignment the issuer made is the issuer's: the holder can't record it.
{
  a1 = await hrec(a1.id);
  e = await hsave(s1.token, phone, { reg: [{ ...a1, filingNumber: "UCC3-2026-0417", filingDoc: H32() }] }).then(() => null, (x) => x);
  ok(e?.status === 403, "the holder can't record the UCC-3 for the assignment they were given (" + e?.status + ")");
  const r1 = await rec(a1.id);
  e = await tryCall(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], events: [], reg: [{ ...r1, filingNumber: "UCC3-2026-0417" }] });
  ok(e?.status === 400, "the issuer's UCC-3 needs the filed copy attached (" + e?.status + ")");
  const doc = H32();
  await icommit({ reg: [{ ...(await rec(a1.id)), filingNumber: "UCC3-2026-0417", filingDoc: doc, filingFile: "ucc3.pdf", filedOn: "Nov 10, 2026", filedBy: "Penson Trust" }],
    events: [ev(a1.bond, a1.id, "FilingRecorded", "UCC3-2026-0417")] });
  ok((await rec(a1.id)).filingRef === records.filingRef(a1.id, "UCC3-2026-0417", doc), "the issuer's UCC-3 is recorded (number and filed copy)");
  ok(!(await sigs("assignment", a1.id)).some((r) => r.fn === "recordFiling"), "as the issuer's act: no assignee signature was asked for it");
}

// 6. Locks are the assignee's: they lift their own, and the issuer can't lift or make one. A pledge
// names its lender; once the lender claims it with the code the assignee gives them, only they release it.
const unlocked = (r) => ({ ...r, status: "Accepted", lockKind: null, lockReason: null, lockedOn: null, pledgeTo: null, pledgeContact: null });
a1 = await hrec(a1.id);
e = await tryCall(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], events: [],
  reg: [{ ...(await rec(a1.id)), status: "Locked", lockKind: "sale", lockReason: "x" }] });
ok(e?.status === 403, "the issuer can't lock an assignee's record (" + e?.status + ")");
await hsave(s1.token, phone, { reg: [{ ...a1, status: "Locked", lockKind: "sale", lockReason: "Pending sale", lockedOn: "now" }], events: [ev(a1.bond, a1.id, "Locked")] });
e = await tryCall(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], events: [], reg: [unlocked(await rec(a1.id))] });
ok(e?.status === 403, "the issuer can't unlock it (" + e?.status + ")");
await hsave(s1.token, phone, { reg: [unlocked(await hrec(a1.id))], events: [ev(a1.bond, a1.id, "Unlocked")] });
ok((await hrec(a1.id)).status === "Accepted", "the assignee unlocks it with their own passkey");
a1 = await hrec(a1.id);
e = await hsave(s1.token, phone, { reg: [{ ...a1, status: "Locked", lockKind: "pledge", lockReason: "Pledged", lockedOn: "now" }] }).then(() => null, (x) => x);
ok(e?.status === 400, "a pledge has to name its lender (" + e?.status + ")");
await hsave(s1.token, phone, { reg: [{ ...a1, status: "Locked", lockKind: "pledge", lockReason: "Pledged", lockedOn: "now", pledgeTo: "First Bank, N.A." }],
  events: [ev(a1.bond, a1.id, "Locked", "Pledged to First Bank, N.A.")] });
const LID = a1.id + "~P";
e = await tryCall(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id: LID, passkey: "AAAA-BBBB-CCCC-DDDD" });
ok(e?.status === 403, "the issuer can't set the lender's code (" + e?.status + ")");
e = await tryCall(I, "POST", "/api/issuer/access-code/reveal", { issuer: issuerId, id: LID });
ok(e?.status === 403, "or see it (" + e?.status + ")");
e = await tryCall(H, "POST", "/api/holder/assignee-code", { token: s2.token, id: LID });
ok(!!e, "nor can another assignee (" + e?.status + ")");
const lenderCode = (await call(H, "POST", "/api/holder/assignee-code", { token: s1.token, id: LID })).code;
ok(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(lenderCode), "the assignee gets their lender's one-time code to give them (" + lenderCode.slice(0, 4) + "…)");
// Before the lender claims it, the assignee can withdraw the pledge; the lender's code then stops working.
await hsave(s1.token, phone, { reg: [unlocked(await hrec(a1.id))] });
e = await tryCall(H, "POST", "/api/holder/signin", { id: LID, passkey: lenderCode }).then((r) => r);
ok(!e?.ok, "withdrawn before it was claimed: the lender's code no longer opens anything (" + (e?.code || e?.status) + ")");
await hsave(s1.token, phone, { reg: [{ ...(await hrec(a1.id)), status: "Locked", lockKind: "pledge", lockReason: "Pledged", lockedOn: "now", pledgeTo: "First Bank, N.A." }] });
const bankCode = (await call(H, "POST", "/api/holder/assignee-code", { token: s1.token, id: LID })).code;
ok(bankCode !== lenderCode, "a new pledge gets a new code");
const bank = newDevice();
const sb = await signIn(LID, bankCode, bank);
ok(sb.ok && !!sb.since, "the lender claims the pledge with it and sets up their own passkey");
ok((await hrec(a1.id)).pledgeClaimed === true, "the register shows the pledge as claimed");
e = await tryCall(H, "POST", "/api/holder/assignee-code", { token: s1.token, id: LID });
ok(e?.status === 409, "and the code is gone (" + e?.status + ")");
e = await hsave(s1.token, phone, { reg: [unlocked(await hrec(a1.id))] }).then(() => null, (x) => x);
ok(e?.status === 403, "now the assignee can't unlock it (" + e?.status + ")");
e = await tryCall(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], events: [], reg: [unlocked(await rec(a1.id))] });
ok(e?.status === 403, "nor can the issuer (" + e?.status + ")");
e = await hsave(sb.token, bank, { reg: [{ ...(await hrec(a1.id)), status: "Superseded" }] }).then(() => null, (x) => x);
ok(e?.status === 403, "the lender can do nothing but release it (" + e?.status + ")");
await hsave(sb.token, bank, { reg: [unlocked(await hrec(a1.id))], events: [ev(a1.bond, a1.id, "PledgeReleased")] });
ok((await hrec(a1.id)).status === "Accepted" && !(await hrec(a1.id)).pledgeClaimed, "the lender releases it with their own passkey: back in effect");
ok((await call(H, "POST", "/api/holder/start", { id: LID })).mode === "none", "and the lender's sign-in is done");
{
  const db = new pg.Client({ connectionString: DB }); await db.connect();
  const rows = (await db.query("select s.*, a.data->'lender' as key from holder_signatures s join assignments a on a.id = s.assignment where s.signer = $1 order by s.seq", [LID])).rows; await db.end();
  const good = rows.filter((r) => { try { holderKeys.checkAssertion({ assertion: r.assertion, challenge: r.challenge, x: r.key.x, y: r.key.y, rpId: RP_ID, origins: ["https://holder.test"] }); return true; } catch { return false; } });
  ok(rows.map((r) => r.fn).join(",") === "claimPledge,releasePledge" && good.length === rows.length,
    "the lender's passkey signed the claim and the release, and both verify (" + rows.map((r) => r.fn).join(", ") + ")");
}
a1 = await hrec(a1.id);
e = await hsave(s1.token, phone, { reg: [{ ...a1, status: "PendingRedemption" }], events: [ev(a1.bond, a1.id, "RedemptionRequested")] }).then(() => null, (x) => x);
ok(e?.status === 403, "a holder can't request redemption through the registry (" + e?.status + ")");
// The issuer pays under the paperwork and records the redemption, with the payment confirmation's hash.
{
  const b0 = await bondNow(), r1 = await rec(a1.id);
  await icommit({ bonds: [{ ...b0, redeemed: b0.redeemed + r1.units }], reg: [{ ...r1, status: "Redeemed", redeemedOn: "now" }],
    events: [ev(a1.bond, a1.id, "Redeemed", H32())] });
    ok((await rec(a1.id)).status === "Redeemed", "the issuer's redemption is recorded, with no holder request");
}

// 6b. Replacing an assignment in effect: the issuer proposes; nothing changes unless its assignee consents.
{
  const A2 = "PENS-0001-BD-A00008", A3 = "PENS-0001-BD-A00009", CODE2 = "MNPQ-RSTV-WXYZ-2345";
  await issue(A2, 5_000, CODE2);
  const dev2 = newDevice(), s4 = await signIn(A2, CODE2, dev2);
  await hsave(s4.token, dev2, { reg: [{ ...(await hrec(A2)), status: "Accepted", accepted: "now" }] });
  e = await tryCall(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], events: [], reg: [{ ...(await rec(A2)), status: "Superseded" }] });
  ok(e?.status === 403, "the issuer can't replace an assignment in effect on its own (" + e?.status + ")");
  const proposal = { newId: A3, party: "Estate of Company A", contact: "Executor", address: "1 Probate Way", docHash: H32(), reasonDoc: H32(), proposedOn: "Nov 21, 2026", assignor: "Penson Trust (replacement)" };
  await call(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id: A3, passkey: "HJKL-MNPQ-RSTV-WXYZ" });
  await icommit({ reg: [{ ...(await rec(A2)), replacement: proposal }], events: [ev("PENS-0001-BD", A2, "ReplacementProposed", A3)] });
  const seen = (await hrec(A2)).replacement;
  ok(seen?.newId === A3 && !("address" in seen) && !("contact" in seen), "the assignee sees the proposal; the new assignee's contact details stay with the issuer");
  e = await tryCall(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], events: [], reg: [{ ...(await rec(A2)), replacement: { ...proposal, party: "Someone else" } }] });
  ok(e?.status === 409, "a pending proposal can't be changed, only withdrawn (" + e?.status + ")");
  e = await tryCall(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], events: [], reg: [{ ...(await rec(A2)), replacementAnswer: "consented", status: "Superseded" }] });
  ok(e?.status === 403, "and the issuer can't answer it for the assignee (" + e?.status + ")");
  await hsave(s4.token, dev2, { reg: [{ ...(await hrec(A2)), replacementAnswer: "declined" }] });
  ok((await rec(A2)).status === "Accepted" && (await rec(A2)).replacementAnswer === "declined" && !(await rec(A3)), "the assignee declines: nothing changes");
  await icommit({ reg: [{ ...(await rec(A2)), replacement: { ...proposal, proposedOn: "Nov 22, 2026" } }] });
  const b0 = await bondNow();
  await hsave(s4.token, dev2, { reg: [{ ...(await hrec(A2)), replacementAnswer: "consented", status: "Superseded" }] });
  const old = await rec(A2), nu = await rec(A3), b1 = await bondNow();
  ok(old.status === "Superseded" && nu?.status === "Issued" && nu.units === 5_000 && nu.parent === A2 && nu.origin === "Replacement" && nu.docHash === proposal.docHash,
    "proposed again, the assignee consents: " + A2 + " is replaced by " + A3 + " for the same $50.00, with the proposed paper");
  ok(b1.unassigned === b0.unassigned, "and the bond still adds up");
  const fns = (await sigs("signer", A2)).map((r) => r.fn);
  ok(fns.includes("declineReplacement") && fns.includes("consentReplacement"), "both answers were signed with the assignee's passkey (" + fns.join(", ") + ")");
}

// 7. A passkey can't be reset: the issuer has no way to clear it, so control stays with the assignee.
const CODE3 = "QRST-UVWX-YZ23-4567";
await issue("PENS-0001-BD-A00003", 500_000, CODE3);
const fresh = newDevice();
const s3b = await signIn("PENS-0001-BD-A00003", CODE3, fresh);
ok(!!(await hrec("PENS-0001-BD-A00003")).deviceKey?.fingerprint, "A00003 has its device key");
e = await tryCall(I, "POST", "/api/issuer/holder-key/clear", { issuer: issuerId, id: "PENS-0001-BD-A00003", reason: "Photo ID checked" });
ok(e?.status === 404 || e?.status === 405, "the issuer can't reset an assignee's passkey: there's no such action (" + e?.status + ")");
{
  const again = await call(H, "POST", "/api/holder/signin", { id: "PENS-0001-BD-A00003", passkey: CODE3 }).catch((x) => ({ ok: false, code: x.status }));
  ok(!again.ok && !again.token, "the used transfer code doesn't open it again (" + again.code + ")");
}
let a3 = await hrec("PENS-0001-BD-A00003");
await hsave(s3b.token, fresh, { reg: [{ ...a3, status: "Accepted", accepted: "now", effective: "holder" }], events: [ev(a3.bond, a3.id, "Acknowledged")] });

// 8. No answer within 30 days: the register records only that it was offered and not answered.
// It doesn't say it was accepted or took effect, and not a day sooner.
await issue("PENS-0001-BD-A00004", 1234, "AAAA-BBBB-CCCC-DDDD");
const backdate = async (d) => { const db = new pg.Client({ connectionString: DB }); await db.connect();
  await db.query(`update assignments set data = data || jsonb_build_object('deliveredAt', (now() - make_interval(days => $1))::text) where id = 'PENS-0001-BD-A00004'`, [d]); await db.end(); };
await backdate(29);
await new Promise((r) => setTimeout(r, 4000));
ok(!(await rec("PENS-0001-BD-A00004")).noResponseAsOf, "29 days after the mailing, nothing is recorded");
await backdate(31);
let lapsed = null;
for (let i = 0; i < 30 && !lapsed; i++) { await new Promise((r) => setTimeout(r, 1000)); const x = await rec("PENS-0001-BD-A00004"); if (x.noResponseAsOf) lapsed = x; }
ok(!!lapsed && lapsed.status === "Issued" && !lapsed.effective && !lapsed.accepted,
  "after 30 days with no authenticated response, the register records only that; it stays an offer, not accepted (" + lapsed?.status + ")");
{
  const evs = (await st()).events.filter((e) => e.id === "PENS-0001-BD-A00004" && e.actor === "SYSTEM").map((e) => e.ev + ": " + e.ref);
  ok(evs.length === 1 && /^NoAuthenticatedResponse: Offered; mailed .*; no authenticated response within 30 days$/.test(evs[0]), "its event says exactly that (" + evs[0] + ")");
}
await new Promise((r) => setTimeout(r, 3000));
ok((await st()).events.filter((e) => e.id === "PENS-0001-BD-A00004" && e.ev === "NoAuthenticatedResponse").length === 1, "and it's recorded once");

// 8a. The issuer corrects A00004's contact and address; no assignee signature is involved.
{
  const r4 = await rec("PENS-0001-BD-A00004");
  await icommit({ reg: [{ ...r4, contact: "J. Doe, Treasurer", address: "Company A\n2 New St\nDover, DE 19901" }] });
  ok((await rec(r4.id)).contact === "J. Doe, Treasurer", "the issuer's correction is saved");
}

// 8b. It repeats: the holder of A00003 (in effect, on their new phone) assigns out in turn.
{
  const a3 = await hrec("PENS-0001-BD-A00003");
  const g = { id: "PENS-0001-BD-A00003-1", bond: "PENS-0001-BD", parent: a3.id, origin: "AssignOut", assignor: "Company A", party: "Company E",
    contact: "N", position: "", address: "addr", units: 2500, issuedUnits: 2500, status: "Issued", created: "Nov 10, 2026",
    accepted: null, docHash: H32(), filingRef: null, deliveryRef: null };
  await hsave(s3b.token, fresh, { reg: [{ ...a3, units: a3.units - 2500 }, g], events: [ev(a3.bond, g.id, "AssignedOut")] });
  ok((await rec(g.id)).accessCode === "unused", "the next assignee's transfer code is made the same way");
  const other = await tryCall(H, "POST", "/api/holder/assignee-code", { token: s1.token, id: g.id });
  ok(other?.status === 403, "another holder can't see it (" + other?.status + ")");
  const gc = (await call(H, "POST", "/api/holder/assignee-code", { token: s3b.token, id: g.id })).code;
  ok(gc && gc !== CODE2, "its assignor gets it, a different code");

  // The assignor mails it and records the mailing: the mail number and date, signed with their passkey.
  let gr = await hrec(g.id);
  e = await hsave(s1.token, phone, { reg: [{ ...gr, instrumentMail: "9407 1111", mailedOn: "2026-11-09", mailingDoc: H32() }] }).then(() => null, (x) => x);
  ok(e?.status === 403, "only its assignor records the mailing (" + e?.status + ")");
  e = await hsave(s3b.token, fresh, { reg: [{ ...gr, instrumentMail: "9407 1111", mailedOn: "2999-01-01", mailingDoc: H32() }] }).then(() => null, (x) => x);
  ok(e?.status === 400, "not with a future date (" + e?.status + ")");
  e = await hsave(s3b.token, fresh, { reg: [{ ...gr, instrumentMail: "9407 1111", mailedOn: "2026-11-09" }] }).then(() => null, (x) => x);
  ok(e?.status === 400, "and not without the certified mail receipt (" + e?.status + ")");
  const mdoc = H32();
  await hsave(s3b.token, fresh, { reg: [{ ...gr, instrumentMail: "9407 2222 3333", mailedOn: "2026-11-09", mailingDoc: mdoc, mailingFile: "ps3800.pdf" }],
    events: [ev(g.bond, g.id, "DeliveryRecorded", "mailed 2026-11-09")] });
    const onc = await rec(g.id);
  ok(onc.deliveryRef === records.deliveryRef(g.id, "9407 2222 3333", undefined, mdoc) && onc.mailedOn === "2026-11-09" && Date.parse(onc.deliveredAt) === Date.parse("2026-11-09"),
    "the assignor's mailing is recorded, and its date starts the assignee's 30 days");
  ok((await sigs("assignment", g.id)).some((r) => r.fn === "recordMailing" && r.signer === a3.id), "signed with the assignor's own passkey");
  gr = await hrec(g.id);
  e = await hsave(s3b.token, fresh, { reg: [{ ...gr, instrumentMail: "9407 9999", mailedOn: "2026-11-09", mailingDoc: H32() }] }).then(() => null, (x) => x);
  ok(e?.status === 409, "it's recorded once (" + e?.status + ")");
  // A page that hasn't caught up (no deliveryRef, no mail number) isn't a second mailing.
  gr = await hrec(g.id);
  await hsave(s3b.token, fresh, { reg: [{ ...gr, deliveryRef: null, mailedOn: undefined }] });
  ok((await hrec(g.id)).deliveryRef === onc.deliveryRef, "a page that hasn't caught up doesn't undo or repeat the mailing");

  // The assignor records the UCC-3 for the assign-out they made, signed with their passkey; once.
  gr = await hrec(g.id);
  const gdoc = H32();
  e = await hsave(s3b.token, fresh, { reg: [{ ...gr, filingNumber: "UCC3-2026-0555" }] }).then(() => null, (x) => x);
  ok(e?.status === 400, "an assign-out's UCC-3 needs the filed copy attached (" + e?.status + ")");
  await hsave(s3b.token, fresh, { reg: [{ ...gr, filingNumber: "UCC3-2026-0555", filingDoc: gdoc, filingFile: "ucc3.pdf", filedOn: "Nov 11, 2026", filedBy: "Company A" }],
    events: [ev(g.bond, g.id, "FilingRecorded", "UCC3-2026-0555")] });
    ok((await rec(g.id)).filingRef === records.filingRef(g.id, "UCC3-2026-0555", gdoc)
    && (await sigs("assignment", g.id)).some((r) => r.fn === "recordFiling" && r.signer === a3.id), "the assignor's UCC-3 for their assign-out is recorded, signed with their passkey");
  gr = await hrec(g.id);
  e = await hsave(s3b.token, fresh, { reg: [{ ...gr, filingNumber: "UCC3-OTHER", filingDoc: H32() }] }).then(() => null, (x) => x);
  ok(e?.status === 409, "it's recorded once (" + e?.status + ")");
}

// 8c. The assignee records their own delivery receipt (the issuer mailed A00003): once, with their passkey.
{
  let a3 = await hrec("PENS-0001-BD-A00003");
  e = await hsave(s3b.token, fresh, { reg: [{ ...a3, receiptMail: "9407 A00003", receivedOn: "2026-11-10" }] }).then(() => null, (x) => x);
  ok(e?.status === 400, "a receipt needs the receipt attached (" + e?.status + ")");
  const doc = H32();
  e = await hsave(s3b.token, fresh, { reg: [{ ...a3, receivedOn: "2026-11-10", receiptDoc: doc }] }).then(() => null, (x) => x);
  ok(e?.status === 400, "and the tracking number on it (" + e?.status + ")");
  await hsave(s3b.token, fresh, { reg: [{ ...a3, receiptMail: "9407-00003", receivedOn: "2026-11-10", receiptDoc: doc, receiptFile: "green-card.pdf" }],
    events: [ev(a3.bond, a3.id, "ReceiptRecorded", "received 2026-11-10")] });
    const rc = await rec(a3.id);
  ok(rc.receiptRef === records.receiptRef(a3.id, "9407-00003", "2026-11-10", doc) && rc.receivedOn === "2026-11-10"
    && (await sigs("assignment", a3.id)).some((r) => r.fn === "recordReceipt" && r.signer === a3.id),
    "the assignee's delivery receipt is recorded (tracking number, date, receipt), signed with their passkey");
  const mine3 = await hrec(a3.id);
  ok(mine3.receiptMatches === true && !("receiptMail" in mine3), "its tracking number matches the issuer's mailing, and stays out of the public register");
  a3 = await hrec(a3.id);
  e = await hsave(s3b.token, fresh, { reg: [{ ...a3, receiptMail: "1", receivedOn: "2026-11-11", receiptDoc: H32() }] }).then(() => null, (x) => x);
  ok(e?.status === 409, "it's recorded once (" + e?.status + ")");
  e = await hsave(s1.token, phone, { reg: [{ ...a3, receiptMail: "1", receivedOn: "2026-11-10", receiptDoc: H32() }] }).then(() => null, (x) => x);
  ok(e && e.status >= 400, "nobody else can record it (" + e?.status + ")");
}

// 9. Every kept signature checks out again against its record's public key, and the counts are right.
{
  const db = new pg.Client({ connectionString: DB }); await db.connect();
  const rows = (await db.query("select s.*, a.data->'holder' as key from holder_signatures s join assignments a on a.id = s.signer order by s.seq")).rows; await db.end();
  let good = 0;
  for (const r of rows) {
    try {
      holderKeys.checkAssertion({ assertion: r.assertion, challenge: r.challenge, x: r.key.x, y: r.key.y, rpId: RP_ID, origins: ["https://holder.test"] });
      if (holderKeys.challengeFor({ signerId: r.signer, nonce: r.nonce, fn: r.fn, args: r.args }) === r.challenge) good++;
    } catch { /* counted as bad */ }
  }
  ok(rows.length > 0 && good === rows.length, "all " + rows.length + " kept signatures verify again, each over exactly what it records (" + good + ")");
  const mine = rows.filter((r) => r.signer === "PENS-0001-BD-A00001").map((r) => r.fn);
  ok(mine.join(",") === "registerHolderKey,accept,assignOut,lock,unlock,lock,unlock,lock", "A00001's passkey signed each of its acts: register key, accept, assign out, and each lock and unlock (" + mine.join(", ") + ")");
  const nonces = rows.filter((r) => r.signer === "PENS-0001-BD-A00001").map((r) => r.nonce);
  ok(nonces.join(",") === "0,1,2,3,4,5,6,7", "each at the next count, so none can be replayed (" + nonces.join(",") + ")");
}

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
for (const c of procs) c.kill();
process.exit(fails ? 1 : 0);
