// End-to-end: holders act only with their own device key (contract v4).
// The servers run against a local chain; this script plays the holder's phone, making P-256
// passkeys and WebAuthn responses exactly as a browser would.
//
// Needs a local chain (cd chain && npx hardhat node), Postgres on 127.0.0.1:54329, and the contract
// compiled. Run from the repo root: node chain/e2e/holder-keys-e2e.mjs
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { ethers } = require("ethers");
const pg = require("pg");
// A fake phone: passkeys that answer like a browser's WebAuthn.
import { newDevice, created, signs, holderPasskeySignIn } from "./fake-device.mjs";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const DB = "postgres://postgres@127.0.0.1:54329/hke";
const I = "http://127.0.0.1:4992", P = "http://127.0.0.1:4993", H = "http://127.0.0.1:4994";
const RPC = "http://127.0.0.1:8545", RP_ID = "holder.test";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const H32 = () => "0x" + crypto.randomBytes(32).toString("hex");
const b64u = (b) => Buffer.from(b).toString("base64url");

// ---------- chain and servers
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.NonceManager(new ethers.Wallet(KEY, provider));
const art = JSON.parse(fs.readFileSync(ROOT + "/chain/artifacts/contracts/BondInterestRegistry.sol/BondInterestRegistry.json", "utf8"));
const me = new ethers.Wallet(KEY).address;
const regC = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(me, me, me, me, ethers.ZeroAddress);
await regC.waitForDeployment();
const CONTRACT = await regC.getAddress();
console.log("registry v4", CONTRACT);

execSync(`psql -h 127.0.0.1 -p 54329 -U postgres -q -c "drop database if exists hke" -c "create database hke"`, { stdio: "ignore" });
const procs = [];
process.on("exit", () => procs.forEach((c) => c.kill())); // stop the servers even when a step throws
const start = (app, port, extra = {}) => new Promise((res, rej) => {
  const c = spawn("node", ["server/index.js"], { cwd: ROOT, env: { ...process.env, APP: app, PORT: String(port), DATABASE_URL: DB, SEED_SAMPLE: "0",
    ADMIN_SETUP_CODE: "setup-123", PASSKEY_PEPPER: "x", CHAIN_CONTRACT: CONTRACT, CHAIN_ID: "31337", CHAIN_RPC_URL: RPC,
    HOLDER_RP_ID: RP_ID, HOLDER_ORIGIN: "https://holder.test", RESPONSE_CHECK_MS: "1500", ...extra } });
  procs.push(c); let out = "";
  c.stdout.on("data", (d) => { out += d; process.env.VERBOSE && process.stdout.write("[" + app + "] " + d); if (out.includes("listening")) res(c); });
  c.stderr.on("data", (d) => process.stdout.write("[" + app + " err] " + d));
  setTimeout(() => rej(new Error(app + " didn't start")), 20000);
});
await start("platform", 4993);
await start("issuer", 4992, { CHAIN_WORKER: "1", CHAIN_SIGNER_KEY: KEY });
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
const id32 = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const S = ["None", "AwaitingCredential", "CredentialRequested", "Issued", "Accepted", "Locked", "PendingRedemption", "Redeemed", "Superseded", "Cancelled", "Rejected"];
const onchain = async (id) => S[Number((await regC.assignments(id32(id))).status)];
async function settle(ms = 90000) {
  const t0 = Date.now(); let s;
  while (Date.now() - t0 < ms) {
    s = await call(P, "GET", "/api/platform/chain");
    if (!(s.counts.queued || s.counts.sent || s.counts.signing)) return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return s;
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
  await icommit({ reg: [{ ...r, instrumentMail: "9407 " + id.slice(-5), passkeyMail: "9407 " + id.slice(-5) }] });
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
const child = { id: "PENS-0001-BD-A00002", bond: "PENS-0001-BD", parent: a1.id, origin: "AssignOut", assignor: "Company A", party: "Company D",
  contact: "M", position: "", address: "addr", units: 1040, issuedUnits: 1040, status: "Issued", created: "Nov 9, 2026",
  accepted: null, docHash: H32(), filingRef: null, deliveryRef: null };
await hsave(s1.token, phone, { reg: [{ ...a1, units: a1.units - 1040 }, child], events: [ev(a1.bond, child.id, "AssignedOut")] });
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

// 5b. The holder records their own UCC-3 with the filed copy; nothing waits on the issuer.
{
  a1 = await hrec(a1.id);
  const doc = H32();
  e = await hsave(s1.token, phone, { reg: [{ ...a1, filingNumber: "UCC3-2026-0417" }] }).then(() => null, (x) => x);
  ok(e?.status === 400, "a UCC-3 needs the filed copy attached (" + e?.status + ")");
  await hsave(s1.token, phone, { reg: [{ ...a1, filingNumber: "UCC3-2026-0417", filingDoc: doc, filingFile: "ucc3.pdf", filedOn: "Nov 10, 2026", filedBy: "Company A" }],
    events: [ev(a1.bond, a1.id, "FilingRecorded", "UCC3-2026-0417")] });
  await settle();
  const want = (await import(ROOT + "/server/chain.js")).filingRef(a1.id, "UCC3-2026-0417", doc);
  ok((await regC.assignments(id32(a1.id))).filingRef === want, "the holder's UCC-3 is on-chain (number and filed copy), signed by their passkey");
  const db = new pg.Client({ connectionString: DB }); await db.connect();
  const ops = (await db.query("select fn, role from chain_ops where ref = $1", [a1.id])).rows; await db.end();
  ok(ops.some((r) => r.fn === "recordFiling" && r.role === "relayer") && !ops.some((r) => r.fn === "setFilingRef"), "and nothing went to the issuer to sign for it");
  a1 = await hrec(a1.id);
  e = await hsave(s1.token, phone, { reg: [{ ...a1, filingNumber: "UCC3-OTHER", filingDoc: H32() }] }).then(() => null, (x) => x);
  ok(e?.status === 409, "it's recorded once (" + e?.status + ")");
}

// 6. Lock, issuer unlocks. Holders don't request redemption through the registry: refused.
a1 = await hrec(a1.id);
await hsave(s1.token, phone, { reg: [{ ...a1, status: "Locked", lockKind: "pledge", lockReason: "Pledged", lockedOn: "now" }], events: [ev(a1.bond, a1.id, "Locked")] });
await icommit({ reg: [{ ...(await rec(a1.id)), status: "Accepted", lockKind: null }], events: [ev(a1.bond, a1.id, "Unlocked", "release")] });
await settle();
a1 = await hrec(a1.id);
e = await hsave(s1.token, phone, { reg: [{ ...a1, status: "PendingRedemption" }], events: [ev(a1.bond, a1.id, "RedemptionRequested")] }).then(() => null, (x) => x);
ok(e?.status === 403, "a holder can't request redemption through the registry (" + e?.status + ")");
// The issuer pays under the paperwork and records the redemption, with the payment confirmation's hash.
{
  const b0 = await bondNow(), r1 = await rec(a1.id);
  await icommit({ bonds: [{ ...b0, redeemed: b0.redeemed + r1.units }], reg: [{ ...r1, status: "Redeemed", redeemedOn: "now" }],
    events: [ev(a1.bond, a1.id, "Redeemed", H32())] });
  await settle();
  ok((await onchain(a1.id)) === "Redeemed", "the issuer's redemption is on-chain, with no holder request");
}

// 7. Lost phone: the issuer resets the key; the holder registers a new phone; the old one is dead.
const CODE3 = "QRST-UVWX-YZ23-4567";
await issue("PENS-0001-BD-A00003", 500_000, CODE3);
const old = newDevice();
const s3 = await signIn("PENS-0001-BD-A00003", CODE3, old);
await settle();
ok((await regC.holderKeys(id32("PENS-0001-BD-A00003"))).x !== 0n, "the device key is on-chain for A00003");
e = await tryCall(I, "POST", "/api/issuer/holder-key/clear", { issuer: issuerId, id: "PENS-0001-BD-A00003", reason: "" });
ok(e?.status === 400, "a reset needs a note on how the holder was verified");
await call(I, "POST", "/api/issuer/holder-key/clear", { issuer: issuerId, id: "PENS-0001-BD-A00003", reason: "Photo ID checked by video call" });
await settle();
ok((await regC.holderKeys(id32("PENS-0001-BD-A00003"))).x === 0n, "the issuer's reset cleared the key on-chain");
let a3 = await hrec("PENS-0001-BD-A00003");
e = await hsave(s3.token, old, { reg: [{ ...a3, status: "Rejected", rejectionReason: LONG }] }).then(() => null, (x) => x);
ok(e?.status === 409, "the old phone can no longer act (" + e?.status + ")");
const fresh = newDevice();
// The reset made a new transfer code, which the issuer reviews and mails; it opens the record once, for the new device.
const CODE3b = (await call(I, "POST", "/api/issuer/access-code/reveal", { issuer: issuerId, id: "PENS-0001-BD-A00003" })).code;
ok(CODE3b && CODE3b !== CODE3, "the reset made a new transfer code for the issuer to mail");
const s3b = await signIn("PENS-0001-BD-A00003", CODE3b, fresh);
a3 = await hrec("PENS-0001-BD-A00003");
await hsave(s3b.token, fresh, { reg: [{ ...a3, status: "Accepted", accepted: "now", effective: "holder" }], events: [ev(a3.bond, a3.id, "Acknowledged")] });

// 8. No answer within 30 days: it takes effect without anyone's signature, and not a day sooner.
await issue("PENS-0001-BD-A00004", 1234, "AAAA-BBBB-CCCC-DDDD");
await settle();
{
  const db = new pg.Client({ connectionString: DB }); await db.connect();
  await db.query(`update assignments set data = data || jsonb_build_object('deliveredAt', (now() - interval '31 days')::text) where id = 'PENS-0001-BD-A00004'`);
  await db.end();
}
// The chain keeps its own date (the mailing date it was given), so the server's backdating alone
// isn't enough: the sender's first try is refused until the chain's 30 days pass too.
await provider.send("evm_increaseTime", [31 * 86400]); await provider.send("evm_mine", []);
let deemed = null;
for (let i = 0; i < 30 && !deemed; i++) { await new Promise((r) => setTimeout(r, 1000)); const x = await rec("PENS-0001-BD-A00004"); if (x.status === "Accepted") deemed = x; }
ok(deemed?.effective === "deemed", "after 30 days without a rejection it took effect");

// 8a. Every other register change is logged on-chain too: the issuer corrects A00004's contact and address.
{
  const r4 = await rec("PENS-0001-BD-A00004");
  await icommit({ reg: [{ ...r4, contact: "J. Doe, Treasurer", address: "Company A\n2 New St\nDover, DE 19901" }] });
  await settle();
  const C = await import(ROOT + "/server/chain.js");
  const want = C.changeDoc(r4.id, "details", C.RECORD_DETAILS, await rec(r4.id));
  const logs = await regC.queryFilter(regC.filters.RegisterChanged(id32("PENS-0001-BD"), id32(r4.id)));
  ok(logs.length === 1 && logs[0].args.kind === ethers.id("details") && logs[0].args.docHash === want,
    "the corrected contact and address are logged on-chain as a hash of the new values, written automatically");
}

// 8b. It repeats: the holder of A00003 (in effect, on their new phone) assigns out in turn.
{
  const a3 = await hrec("PENS-0001-BD-A00003");
  const g = { id: "PENS-0001-BD-A00005", bond: "PENS-0001-BD", parent: a3.id, origin: "AssignOut", assignor: "Company A", party: "Company E",
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
  e = await hsave(s1.token, phone, { reg: [{ ...gr, instrumentMail: "9407 1111", mailedOn: "2026-11-09" }] }).then(() => null, (x) => x);
  ok(e?.status === 403, "only its assignor records the mailing (" + e?.status + ")");
  e = await hsave(s3b.token, fresh, { reg: [{ ...gr, instrumentMail: "9407 1111", mailedOn: "2999-01-01" }] }).then(() => null, (x) => x);
  ok(e?.status === 400, "not with a future date (" + e?.status + ")");
  await hsave(s3b.token, fresh, { reg: [{ ...gr, instrumentMail: "9407 2222 3333", mailedOn: "2026-11-09" }],
    events: [ev(g.bond, g.id, "DeliveryRecorded", "mailed 2026-11-09")] });
  await settle();
  const C = await import(ROOT + "/server/chain.js");
  const onc = await regC.assignments(id32(g.id));
  ok(onc.deliveryRef === C.deliveryRef(g.id, "9407 2222 3333", undefined) && (await regC.mailedAt(id32(g.id))) === BigInt(Date.parse("2026-11-09") / 1000),
    "the assignor's mailing is on-chain, and its date starts the assignee's 30 days");
  const db = new pg.Client({ connectionString: DB }); await db.connect();
  const fns = (await db.query("select fn, role from chain_ops where ref = $1", [g.id])).rows; await db.end();
  ok(fns.some((r) => r.fn === "recordMailing" && r.role === "relayer") && !fns.some((r) => r.fn === "setDeliveryRef"), "nothing went to the issuer's Safe for it");
  gr = await hrec(g.id);
  e = await hsave(s3b.token, fresh, { reg: [{ ...gr, instrumentMail: "9407 9999", mailedOn: "2026-11-09" }] }).then(() => null, (x) => x);
  ok(e?.status === 409, "it's recorded once (" + e?.status + ")");
  // A page that hasn't caught up (no deliveryRef, no mail number) isn't a second mailing.
  gr = await hrec(g.id);
  await hsave(s3b.token, fresh, { reg: [{ ...gr, deliveryRef: null, mailedOn: undefined }] });
  ok((await hrec(g.id)).deliveryRef === onc.deliveryRef, "a page that hasn't caught up doesn't undo or repeat the mailing");
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
  await settle();
  const C = await import(ROOT + "/server/chain.js");
  const rc = await regC.receipts(id32(a3.id));
  ok(rc.ref === C.receiptRef(a3.id, "9407-00003", "2026-11-10", doc) && rc.receivedAt === BigInt(Date.parse("2026-11-10") / 1000),
    "the assignee's delivery receipt is on-chain (tracking number, date, receipt), signed with their passkey");
  const mine3 = await hrec(a3.id);
  ok(mine3.receiptMatches === true && !("receiptMail" in mine3), "its tracking number matches the issuer's mailing, and stays out of the public register");
  a3 = await hrec(a3.id);
  e = await hsave(s3b.token, fresh, { reg: [{ ...a3, receiptMail: "1", receivedOn: "2026-11-11", receiptDoc: H32() }] }).then(() => null, (x) => x);
  ok(e?.status === 409, "it's recorded once (" + e?.status + ")");
  e = await hsave(s1.token, phone, { reg: [{ ...a3, receiptMail: "1", receivedOn: "2026-11-10", receiptDoc: H32() }] }).then(() => null, (x) => x);
  ok(e && e.status >= 400, "nobody else can record it (" + e?.status + ")");
}

// 9. Everything confirmed, and the chain matches the register.
const sum = await settle(120000);
console.log("queue:", JSON.stringify(sum.counts), sum.failed.length ? JSON.stringify(sum.failed) : "");
ok(!sum.counts.failed && !sum.counts.queued && !sum.counts.sent, "every write confirmed (" + sum.counts.confirmed + ")");
for (const a of (await st()).reg) ok((await onchain(a.id)) === a.status, `${a.id}: chain ${await onchain(a.id)} · register ${a.status}`);
const nonce = (await regC.holderKeys(id32("PENS-0001-BD-A00001"))).nonce;
ok(nonce === 5n, "A00001's key signed 5 times on-chain: register key, acknowledge, assign out, UCC-3, lock (" + nonce + ")");

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
for (const c of procs) c.kill();
process.exit(fails ? 1 : 0);
