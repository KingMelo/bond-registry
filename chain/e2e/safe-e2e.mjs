// End-to-end: issuer writes and platform writes wait for Safe owner signatures, then go on-chain
// through the Safe. Signs exactly the payload the Trezor would get from the API.
//
// Needs a local chain (cd chain && npx hardhat node), Postgres on 127.0.0.1:54329, and the contract
// compiled (npx hardhat compile). Run from the repo root: node chain/e2e/safe-e2e.mjs
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { newDevice, holderSignIn, holderSave, RP_ID, ORIGIN } from "./fake-device.mjs";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { ethers } = require("ethers");

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, ""), DB = "postgres://postgres@127.0.0.1:54329/sfe";
const I = "http://127.0.0.1:4982", P = "http://127.0.0.1:4983", H = "http://127.0.0.1:4984";
const RPC = "http://127.0.0.1:8545";
const KEYS = { relayer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  owner: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",      // hardhat #5: the issuer's Trezor stand-in
  platOwner: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",  // hardhat #6
  stranger: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" }; // hardhat #7
const H32 = () => "0x" + crypto.randomBytes(32).toString("hex");
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

const provider = new ethers.JsonRpcProvider(RPC);
const deployer = new ethers.NonceManager(new ethers.Wallet(KEYS.relayer, provider));
const fx = (n) => JSON.parse(fs.readFileSync(ROOT + "/chain/test/fixtures/safe-1.4.1/" + n + ".json", "utf8"));
const dep = async (art, ...args) => { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };

// Safe's contracts, and two 1-of-1 Safes: one for the issuer, one for the platform.
const singleton = await dep(fx("SafeL2")), factory = await dep(fx("SafeProxyFactory")), fallback = await dep(fx("CompatibilityFallbackHandler"));
async function makeSafe(ownerKey, salt) {
  const owner = new ethers.Wallet(ownerKey).address;
  const init = new ethers.Interface(fx("SafeL2").abi).encodeFunctionData("setup", [[owner], 1, ethers.ZeroAddress, "0x", await fallback.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const tx = await factory.createProxyWithNonce(await singleton.getAddress(), init, salt);
  const r = await tx.wait();
  return r.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "ProxyCreation").args.proxy;
}
const ISSUER_SAFE = await makeSafe(KEYS.owner, 1), PLATFORM_SAFE = await makeSafe(KEYS.platOwner, 2);
const relayerAddr = new ethers.Wallet(KEYS.relayer).address;
const regArt = JSON.parse(fs.readFileSync(ROOT + "/chain/artifacts/contracts/BondInterestRegistry.sol/BondInterestRegistry.json", "utf8"));
const regC = await dep(regArt, relayerAddr, PLATFORM_SAFE, relayerAddr, relayerAddr, ethers.ZeroAddress);  // platform role on the Safe from the start
const CONTRACT = await regC.getAddress();
console.log("registry", CONTRACT, "issuer Safe", ISSUER_SAFE, "platform Safe", PLATFORM_SAFE);

execSync(`psql -h 127.0.0.1 -p 54329 -U postgres -q -c "drop database if exists sfe" -c "create database sfe"`);
const procs = [];
process.on("exit", () => procs.forEach((c) => c.kill())); // stop the servers even when a step throws
const start = (app, port, extra = {}) => new Promise((res, rej) => {
  const c = spawn("node", ["server/index.js"], { cwd: ROOT, env: { ...process.env, APP: app, PORT: String(port), DATABASE_URL: DB, SEED_SAMPLE: "0",
    ADMIN_SETUP_CODE: "setup-123", PASSKEY_PEPPER: "x", CHAIN_CONTRACT: CONTRACT, CHAIN_EXPLORER: "http://explorer.test", CHAIN_RPC_URL: RPC,
    CHAIN_PLATFORM_SAFE: PLATFORM_SAFE, CHAIN_ID: "31337", HOLDER_RP_ID: RP_ID, HOLDER_ORIGIN: ORIGIN, ...extra } });
  procs.push(c); let out = "";
  c.stdout.on("data", (d) => { out += d; process.env.VERBOSE && process.stdout.write("[" + app + "] " + d); if (out.includes("listening")) res(c); });
  c.stderr.on("data", (d) => process.stdout.write("[" + app + " err] " + d));
  setTimeout(() => rej(new Error(app + " didn't start")), 20000);
});
await start("platform", 4983);
await start("issuer", 4982, { CHAIN_WORKER: "1", CHAIN_SIGNER_KEY: KEYS.relayer });
await start("holder", 4984);

const jar = {};
async function call(base, method, path, body) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: base, Cookie: jar[base] || "" }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) jar[base] = sc.split(";")[0];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(path + " " + r.status + " " + (j.error || "")); e.status = r.status; e.body = j; throw e; }
  return j;
}
const login = async (base) => { jar[base] = ""; await call(base, "POST", "/api/auth/login", { email: "o@x.test", password: "owner-pass-123" }); };
await call(P, "POST", "/api/auth/setup", { setupCode: "setup-123", name: "Owner", email: "o@x.test", password: "owner-pass-123" });
await login(I);
const iss = await call(I, "POST", "/api/issuers", { legalName: "Penson Trust", issuerCode: "PENS" });
const issuerId = iss.issuer?.id || (await call(I, "GET", "/api/auth/me")).issuers[0].id;
const pg = require("pg"); const db = new pg.Client({ connectionString: DB }); await db.connect();
await db.query("update issuers set safe_address = $1 where code = 'PENS'", [ISSUER_SAFE]);

const st = () => call(I, "GET", "/api/state?issuer=" + issuerId);
ok((await st()).issuer.safe === ISSUER_SAFE, "the issuer's state names its Safe");
let eidN = 0; const ev = (bond, id, name, ref = "—") => ({ eid: "e" + (++eidN) + "-" + Date.now(), bond, id, t: "now", ev: name, actor: "X", ref });
const icommit = async ({ bonds = [], reg = [], events = [] }) => call(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds, reg, events });
const hcommit = async ({ reg = [], events = [] }) => call(H, "POST", "/api/commit", { base: (await call(H, "GET", "/api/state")).version, reg, events });
const rec = async (id) => (await st()).reg.find((a) => a.id === id);
const bondNow = async () => (await st()).bonds.find((b) => b.id === "PENS-0001-BD");

const TOTAL = 10_000_000_000;
await icommit({ bonds: [{ id: "PENS-0001-BD", title: "Series A", face: TOTAL, total: TOTAL, unassigned: TOTAL - 942887, redeemed: 0,
  prior: [{ id: "P001", ref: "PN-2024-007", holder: "Old Holder", mail: "9407 1", units: 942887, recordedOn: "Nov 8, 2026", reversed: false }],
  registered: "Nov 8, 2026", instrumentHash: H32(), ucc1: { number: "DE-1", office: "Delaware", date: "Nov 7, 2026", hash: H32(), file: "u.pdf" } }] });
const base = { origin: "Issuer", parent: null, assignor: "Penson Trust", party: "Company A", contact: "D", position: "", address: "addr",
  status: "Issued", created: "now", accepted: null, filingRef: null, deliveryRef: null, instrumentMail: null, passkeyMail: null };
let b = await bondNow();
const ACCESS_CODE = "7KQM-R4XW-9TPH-C2NV";
await call(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id: "PENS-0001-BD-A00001", passkey: ACCESS_CODE });
await icommit({ bonds: [{ ...b, unassigned: b.unassigned - 500000 }], reg: [{ ...base, id: "PENS-0001-BD-A00001", bond: "PENS-0001-BD", units: 500000, issuedUnits: 500000, docHash: H32() }],
  events: [ev("PENS-0001-BD", "PENS-0001-BD-A00001", "AssignmentIssued")] });
await icommit({ reg: [{ ...(await rec("PENS-0001-BD-A00001")), instrumentMail: "RE 1", passkeyMail: "RE 2", deliveryRef: "pending" }] });

// Signs the oldest waiting item exactly as the Trezor would: the API's typed data, minus EIP712Domain.
const TD = (td) => { const { EIP712Domain, ...types } = td.types; return types; };
async function waitFor(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 700)); } return null; }
const issuerQueue = async () => { return call(I, "GET", "/api/issuer/signing?issuer=" + issuerId); };
await login(P);
const platQueue = async () => { return call(P, "GET", "/api/platform/signing"); };

// 1. Registering the issuer is a platform call: it waits on the platform's Safe.
let pq = await waitFor(async () => { const q = await platQueue(); return q.items.length ? q : null; });
ok(pq && pq.safe === PLATFORM_SAFE && pq.items[0].fn === "registerIssuer", "registering the issuer waits for the platform Safe (" + pq?.items[0]?.fn + ")");
let iq0 = await issuerQueue();
ok(iq0.items.length === 0, "nothing reaches the issuer's Safe before the issuer is registered");
{
  const it = pq.items[0], td = it.typedData;
  const safeC = new ethers.Contract(PLATFORM_SAFE, (await import(ROOT + "/server/safe.js")).SAFE_ABI, provider);
  const onchain = await safeC.getTransactionHash(td.message.to, td.message.value, td.message.data, td.message.operation, td.message.safeTxGas, td.message.baseGas, td.message.gasPrice, td.message.gasToken, td.message.refundReceiver, td.message.nonce);
  ok(onchain === td.safeTxHash, "the hash shown to the signer is the one the Safe computes on-chain");
  ok(ethers.keccak256(ethers.concat(["0x1901", td.domainSeparatorHash, td.messageHash])) === td.safeTxHash, "domain and message hashes (for devices that sign hashes) combine to it");
  // A stranger's signature is refused.
  const bad = await new ethers.Wallet(KEYS.stranger).signTypedData(td.domain, TD(td), td.message);
  let e1 = null; try { await call(P, "POST", "/api/platform/sign", { seq: it.seq, signature: bad }); } catch (e) { e1 = e; }
  ok(e1?.status === 422 && /isn't an owner/.test(e1.message), "a non-owner's signature is refused: " + e1?.message);
  // The issuer's owner can't sign for the platform's Safe either.
  const wrong = await new ethers.Wallet(KEYS.owner).signTypedData(td.domain, TD(td), td.message);
  let e2 = null; try { await call(P, "POST", "/api/platform/sign", { seq: it.seq, signature: wrong }); } catch (e) { e2 = e; }
  ok(e2?.status === 422, "the issuer's key can't approve a platform action");
  const sig = await new ethers.Wallet(KEYS.platOwner).signTypedData(td.domain, TD(td), td.message);
  const r = await call(P, "POST", "/api/platform/sign", { seq: it.seq, signature: sig });
  ok(r.ok && r.signatures === 1 && r.threshold === 1, "the platform owner's signature is accepted");
}
const iss32 = ethers.keccak256(ethers.toUtf8Bytes("PENS"));
ok(!!(await waitFor(async () => (await regC.issuers(iss32)).account === ISSUER_SAFE)), "the issuer is registered on-chain with its Safe as its account");

// 2. Every issuer action now waits on the issuer's Safe; sign them one at a time until the queue empties.
const signedFns = [];
for (let n = 0; n < 12; n++) {
  const q = await waitFor(async () => {
    const x = await issuerQueue(); if (x.items.length) return x;
    const s = (await db.query("select count(*)::int c from chain_ops where contract = $1 and status in ('queued','sent','signing')", [CONTRACT])).rows[0].c;
    return s === 0 ? { done: true } : null;
  }, 40000);
  if (!q || q.done) break;
  const it = q.items[0], td = it.typedData;
  if (n === 0) {
    ok(q.items.every((x, i) => i === 0 || x.nonce >= it.nonce), "waiting items are in Safe-nonce order");
    let e3 = null; try { await call(I, "POST", "/api/issuer/sign", { issuer: issuerId, seq: it.seq, signature: await new ethers.Wallet(KEYS.platOwner).signTypedData(td.domain, TD(td), td.message) }); } catch (e) { e3 = e; }
    ok(e3?.status === 422, "the platform's key can't approve an issuer action");
  }
  const sig = await new ethers.Wallet(KEYS.owner).signTypedData(td.domain, TD(td), td.message);
  await call(I, "POST", "/api/issuer/sign", { issuer: issuerId, seq: it.seq, signature: sig });
  signedFns.push(it.fn);
  await waitFor(async () => (await db.query("select status from chain_ops where seq = $1", [it.seq])).rows[0].status === "confirmed", 30000);
}
console.log("signed through the issuer's Safe:", signedFns.join(", "));
ok(signedFns.includes("anchorBond") && signedFns.includes("issueAssignment") && signedFns.includes("setDeliveryRef"), "anchor, issue and the mailing each went through the Safe");

// 3. The holder accepts with their own device: no Safe signature, and the relayer only pays gas.
const phone = newDevice();
const s1 = await holderSignIn(call, H, "PENS-0001-BD-A00001", ACCESS_CODE, phone);
const a1 = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === "PENS-0001-BD-A00001");
await holderSave(call, H, s1.token, phone, { reg: [{ ...a1, status: "Accepted", accepted: "now" }], events: [ev("PENS-0001-BD", a1.id, "Accepted")] });
const id32 = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
ok(!!(await waitFor(async () => Number((await regC.assignments(id32("PENS-0001-BD-A00001"))).status) === 4, 30000)),
  "a holder's acceptance, signed on their device, goes through without any Safe signature");

const ops = (await db.query("select fn, status, safe, tx from chain_ops where contract = $1 order by seq", [CONTRACT])).rows;
console.log(ops.map((o) => `${o.fn}:${o.status}${o.safe ? " via " + o.safe.slice(0, 8) : ""}`).join("\n"));
ok(ops.every((o) => o.status === "confirmed"), "every write confirmed");
ok(ops.filter((o) => ["registerIssuer"].includes(o.fn)).every((o) => o.safe === PLATFORM_SAFE)
  && ops.filter((o) => !["registerIssuer", "accept", "registerHolderKey"].includes(o.fn)).every((o) => o.safe === ISSUER_SAFE), "each write went through the right Safe");
const t = await regC.bondTotals(id32("PENS-0001-BD"));
ok(Number(t[0]) === TOTAL && Number(t[1]) === 942887 && Number(t[3]) === TOTAL - 942887 - 500000, "bond totals on-chain match the register");
const sNonce = await new ethers.Contract(ISSUER_SAFE, ["function nonce() view returns (uint256)"], provider).nonce();
ok(Number(sNonce) === signedFns.length, "the issuer's Safe executed exactly the " + signedFns.length + " approved transactions");

await db.end();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
for (const c of procs) c.kill();
process.exit(fails ? 1 : 0);
