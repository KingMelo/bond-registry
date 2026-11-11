// End-to-end: moving the live registry from v4 to v5 without losing anything holders signed.
//
// Like Amoy today: one Safe (owned by a stand-in for the Trezor) holds the platform and guardian
// roles and is the issuer's account; a holder has set up a device key and signed actions.
// Then: freeze v4 through the Safe, deploy v5 pointing at it, restart the servers on v5, and
// the sender copies everything. The holder keeps acting with the same device.
//
// Needs a local chain (cd chain && npx hardhat node), Postgres on 127.0.0.1:54329, the contracts
// compiled. Run from the repo root: node chain/e2e/migration-e2e.mjs
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { newDevice, holderSignIn, holderPasskeySignIn, holderSave, RP_ID, ORIGIN } from "./fake-device.mjs";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { ethers } = require("ethers");

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const DB = "postgres://postgres@127.0.0.1:54329/mig";
const I = "http://127.0.0.1:5012", P = "http://127.0.0.1:5013", H = "http://127.0.0.1:5014";
const RPC = "http://127.0.0.1:8545";
const RELAYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat #0
const TREZOR = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";  // hardhat #5, the Safe's owner
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const H32 = () => "0x" + crypto.randomBytes(32).toString("hex");

const provider = new ethers.JsonRpcProvider(RPC);
const deployer = new ethers.NonceManager(new ethers.Wallet(RELAYER, provider));
const fx = (n) => JSON.parse(fs.readFileSync(ROOT + "/chain/test/fixtures/safe-1.4.1/" + n + ".json", "utf8"));
const art = (p) => JSON.parse(fs.readFileSync(ROOT + "/chain/artifacts/contracts/" + p, "utf8"));
const dep = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };

const singleton = await dep(fx("SafeL2")), factory = await dep(fx("SafeProxyFactory")), fallback = await dep(fx("CompatibilityFallbackHandler"));
const owner = new ethers.Wallet(TREZOR).address;
const init = new ethers.Interface(fx("SafeL2").abi).encodeFunctionData("setup", [[owner], 1, ethers.ZeroAddress, "0x", await fallback.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress]);
const rc = await (await factory.createProxyWithNonce(await singleton.getAddress(), init, 7)).wait();
const SAFE = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "ProxyCreation").args.proxy;
const me = new ethers.Wallet(RELAYER).address;
// v4 as deployed: admin, platform and guardian on the Safe; the relayer key relays.
const v4 = await dep(art("legacy/BondInterestRegistryV4.sol/BondInterestRegistryV4.json"), SAFE, SAFE, me, SAFE);
const V4 = await v4.getAddress();
console.log("v4", V4, "Safe", SAFE);

execSync(`psql -h 127.0.0.1 -p 54329 -U postgres -q -c "drop database if exists mig" -c "create database mig"`, { stdio: "ignore" });
let procs = [];
process.on("exit", () => procs.forEach((c) => c.kill()));
const start = (app, port, env) => new Promise((res, rej) => {
  const c = spawn("node", ["server/index.js"], { cwd: ROOT, env: { ...process.env, APP: app, PORT: String(port), DATABASE_URL: DB, SEED_SAMPLE: "0",
    ADMIN_SETUP_CODE: "setup-123", PASSKEY_PEPPER: "x", CHAIN_ID: "31337", CHAIN_RPC_URL: RPC, HOLDER_RP_ID: RP_ID, HOLDER_ORIGIN: ORIGIN,
    HOLDER_SESSION_SECRET: "same-across-restarts", ...env } });
  procs.push(c); let out = "";
  c.stdout.on("data", (d) => { out += d; process.env.VERBOSE && process.stdout.write("[" + app + "] " + d); if (out.includes("listening")) res(c); });
  c.stderr.on("data", (d) => process.stdout.write("[" + app + " err] " + d));
  setTimeout(() => rej(new Error(app + " didn't start")), 20000);
});
async function startAll(env) {
  await start("platform", 5013, env);
  await start("issuer", 5012, { ...env, CHAIN_WORKER: "1", CHAIN_SIGNER_KEY: RELAYER });
  await start("holder", 5014, env);
}
async function stopAll() { for (const c of procs) c.kill(); await new Promise((r) => setTimeout(r, 1500)); procs = []; }
await startAll({ CHAIN_CONTRACT: V4, CHAIN_PLATFORM_SAFE: SAFE });

const jar = {};
async function call(base, method, path, body) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: base, Cookie: jar[base] || "" }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) jar[base] = sc.split(";")[0];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(path + " " + r.status + " " + (j.error || "")); e.status = r.status; throw e; }
  return j;
}
const login = async () => { for (const b of [I, P]) { jar[b] = ""; await call(b, "POST", "/api/auth/login", { email: "o@x.test", password: "owner-pass-123" }); } };
await call(P, "POST", "/api/auth/setup", { setupCode: "setup-123", name: "Owner", email: "o@x.test", password: "owner-pass-123" });
await login();
const iss = await call(I, "POST", "/api/issuers", { legalName: "King-Joseph: Penson II", issuerCode: "KJPII" });
const issuerId = iss.issuer?.id || (await call(I, "GET", "/api/auth/me")).issuers[0].id;
const pg = require("pg"); const db = new pg.Client({ connectionString: DB }); await db.connect();
await db.query("update issuers set safe_address = $1 where code = 'KJPII'", [SAFE]);

const st = () => call(I, "GET", "/api/state?issuer=" + issuerId);
const icommit = async (body) => call(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], reg: [], events: [], ...body });
const rec = async (id) => (await st()).reg.find((a) => a.id === id);
const hrec = async (id) => (await call(H, "GET", "/api/state")).reg.find((a) => a.id === id);
let n = 0; const ev = (bond, id, name, ref = "—") => ({ eid: "e" + (++n) + "-" + Date.now(), bond, id, t: "now", ev: name, actor: "X", ref });

// The Trezor stand-in approves whatever waits on the Safe, until the queue is empty.
const TD = (td) => { const { EIP712Domain, ...types } = td.types; return types; };
async function approveAll(ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const iq = await call(I, "GET", "/api/issuer/signing?issuer=" + issuerId).catch(() => ({ items: [] }));
    const pq = await call(P, "GET", "/api/platform/signing").catch(() => ({ items: [] }));
    const it = (iq.items || [])[0] || (pq.items || [])[0];
    if (it && !it.signedBy.length) {
      const sig = await new ethers.Wallet(TREZOR).signTypedData(it.typedData.domain, TD(it.typedData), it.typedData.message);
      await (iq.items?.[0] === it ? call(I, "POST", "/api/issuer/sign", { issuer: issuerId, seq: it.seq, signature: sig }) : call(P, "POST", "/api/platform/sign", { seq: it.seq, signature: sig }));
    }
    const open = (await db.query("select count(*)::int c from chain_ops where status in ('queued','sent','signing')")).rows[0].c;
    if (!open) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

// ---- life on v4
const TOTAL = 10_000_000_000, A1 = "KJPII-0001-BD-A00001", C1 = "KJPII-0001-BD-A00002", CODE = "7KQM-R4XW-9TPH-C2NV";
await icommit({ bonds: [{ id: "KJPII-0001-BD", title: "Series A", face: TOTAL, total: TOTAL, unassigned: TOTAL - 99_908_282, redeemed: 0,
  prior: [{ id: "P001", ref: "PN-2024-007", holder: "Old Holder", mail: "9407 1", units: 99_908_282, recordedOn: "Nov 8, 2026", reversed: false }],
  registered: "Nov 8, 2026", instrumentHash: H32(), ucc1: { number: "DE-1", office: "Delaware", date: "Nov 7, 2026", hash: H32(), file: "u.pdf" } }] });
await call(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id: A1, passkey: CODE });
let b = (await st()).bonds[0];
await icommit({ bonds: [{ ...b, unassigned: b.unassigned - 1_000_000 }], reg: [{ origin: "Issuer", parent: null, assignor: "King-Joseph: Penson II",
  party: "Company A", contact: "D", position: "", address: "addr", status: "Issued", created: "Nov 10, 2026", accepted: null, filingRef: null,
  deliveryRef: null, instrumentMail: null, passkeyMail: null, id: A1, bond: "KJPII-0001-BD", units: 1_000_000, issuedUnits: 1_000_000, docHash: H32() }] });
await icommit({ reg: [{ ...(await rec(A1)), instrumentMail: "9407 1000 0000 0000 0000 01", passkeyMail: "9407 1000 0000 0000 0000 01" }] });
ok(await approveAll(), "v4: the Trezor approved registration, anchoring, the prior instrument, the issue and the mailing");
const phone = newDevice();
const s1 = await holderSignIn(call, H, A1, CODE, phone);
let a1 = await hrec(A1);
await holderSave(call, H, s1.token, phone, { reg: [{ ...a1, status: "Accepted", accepted: "now" }], events: [ev(a1.bond, A1, "Acknowledged")] });
a1 = await hrec(A1);
await holderSave(call, H, s1.token, phone, { reg: [{ ...a1, units: a1.units - 1040 }, { id: C1, bond: "KJPII-0001-BD", parent: A1, origin: "AssignOut",
  assignor: "Company A", party: "Company D", contact: "M", position: "", address: "addr", units: 1040, issuedUnits: 1040, status: "Issued",
  created: "Nov 10, 2026", accepted: null, docHash: H32(), filingRef: null, deliveryRef: null }], events: [ev(a1.bond, C1, "AssignedOut")] });
ok(await approveAll(), "v4: the holder's device key, acknowledgement and $10.40 assign-out went through");
const id32 = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const v4Key = await v4.holderKeys(id32(A1));
ok(v4Key.nonce === 3n, "v4 holds the holder's key, signed 3 times");

// ---- freeze v4 (through the Safe), deploy v5 pointing at it
let e = null;
await db.query("insert into chain_ops (bond, ref, fn, args, role, contract) values (null, 'x', 'noop', '[]', 'relayer', $1)", [V4]);
try { await call(P, "POST", "/api/platform/chain/freeze", {}); } catch (x) { e = x; }
ok(e?.status === 409, "freezing is refused while a write is still open (" + e?.status + ")");
await db.query("delete from chain_ops where fn = 'noop'");
await call(P, "POST", "/api/platform/chain/freeze", {});
ok(await approveAll(), "the Trezor approved the freeze");
ok(await v4.paused(), "v4 is paused on-chain");
deployer.reset(); // the servers sent with the same key meanwhile
const v5 = await dep(art("BondInterestRegistry.sol/BondInterestRegistry.json"), me, me, me, me, V4);
const V5 = await v5.getAddress();
console.log("v5", V5);
await stopAll();
await startAll({ CHAIN_CONTRACT: V5, CHAIN_PREDECESSOR: V4 });
await login();
ok(await approveAll(), "v5: the sender copied everything from v4 and finished the import");
ok(!(await v5.migrating()), "v5 is open for business");

// ---- v5 holds exactly what v4 did
for (const r of [A1, C1]) {
  const [x, y] = [(await v4.assignments(id32(r))).toArray().map(String), (await v5.assignments(id32(r))).toArray().map(String)];
  // v4's assign-out was waiting for the issuer (1); from v5 it's open to its assignee (3). The rest is identical.
  if (r === C1) { ok(x[5] === "1" && y[5] === "3", C1 + " arrives open to its assignee"); x[5] = y[5]; }
  ok(JSON.stringify(x) === JSON.stringify(y), r + " copied exactly");
}
const k5 = await v5.holderKeys(id32(A1));
ok(k5.x === v4Key.x && k5.nonce === 3n, "the holder's device key and its counter came across");
ok((await v5.issuers(id32("KJPII"))).account === SAFE, "the issuer still acts through the Safe on v5");
const t4 = await v4.bondTotals(id32("KJPII-0001-BD")), t5 = await v5.bondTotals(id32("KJPII-0001-BD"));
ok(t4.toArray().map(String).join() === t5.toArray().map(String).join(), "bond totals match: " + t5.toArray().slice(0, 5).join(" / "));

// ---- life goes on: same device, same Safe
const sAgain = await holderPasskeySignIn(call, H, A1, phone); // the passkey set up on v4
ok(!!sAgain.token && !sAgain.enroll, "the holder signs in on v5 and isn't asked to set up the device again");
const c1 = await hrec(C1); a1 = await hrec(A1);
await holderSave(call, H, sAgain.token, phone, { reg: [{ ...c1, status: "Cancelled" }, { ...a1, units: a1.units + 1040 }], events: [ev(a1.bond, C1, "AssignOutCancelled")] });
await icommit({ reg: [{ ...(await rec(A1)), filingNumber: "UCC3-2026-0417", filingDoc: H32(), filingFile: "ucc3.pdf", filedOn: "Nov 10, 2026", filedBy: "King-Joseph: Penson II" }],
  events: [ev("KJPII-0001-BD", A1, "FilingRecorded", "UCC3-2026-0417")] });
ok(await approveAll(), "after the move: the holder cancelled with the same device, and the issuer's UCC-3 went through the Safe");
ok(Number((await v5.assignments(id32(C1))).status) === 9 && (await v5.holderKeys(id32(A1))).nonce === 4n, "v5 recorded the holder's cancel (counter now 4)");
ok((await v5.assignments(id32(A1))).filingRef === (await rec(A1)).filingRef, "the issuer's UCC-3 reference is on v5");
const failed = (await db.query("select fn, ref, error from chain_ops where status = 'failed'")).rows;
ok(!failed.length, "no write failed" + (failed.length ? ": " + JSON.stringify(failed) : ""));
const st5 = await st();
const S = ["None", "AwaitingCredential", "CredentialRequested", "Issued", "Accepted", "Locked", "PendingRedemption", "Redeemed", "Superseded", "Cancelled", "Rejected"];
for (const a of st5.reg) ok(S[Number((await v5.assignments(id32(a.id))).status)] === a.status, a.id + ": chain and register agree (" + a.status + ")");

await db.end();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
