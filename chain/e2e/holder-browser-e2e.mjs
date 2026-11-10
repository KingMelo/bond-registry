// Browser end-to-end: a holder signs in on the portal, sets up a device key with a (virtual)
// passkey authenticator, and confirms an assignment. The chain must show the key and the
// holder's own signed acknowledgement.
//
// Needs a local chain (cd chain && npx hardhat node), Postgres on 127.0.0.1:54329, the contract
// compiled, and the apps built (npm run build). Run from the repo root:
//   node chain/e2e/holder-browser-e2e.mjs [screenshot-dir]
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { ethers } = require("ethers");
const { chromium } = require("playwright");

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const SHOTS = process.argv[2] || null;
const DB = "postgres://postgres@127.0.0.1:54329/hbe";
const I = "http://localhost:5002", P = "http://localhost:5003", H = "http://localhost:5004";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const H32 = () => "0x" + crypto.randomBytes(32).toString("hex");

const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const art = JSON.parse(fs.readFileSync(ROOT + "/chain/artifacts/contracts/BondInterestRegistry.sol/BondInterestRegistry.json", "utf8"));
const me = new ethers.Wallet(KEY).address;
const regC = await new ethers.ContractFactory(art.abi, art.bytecode, new ethers.NonceManager(new ethers.Wallet(KEY, provider))).deploy(me, me, me, me, ethers.ZeroAddress);
await regC.waitForDeployment();
const CONTRACT = await regC.getAddress();

execSync(`psql -h 127.0.0.1 -p 54329 -U postgres -q -c "drop database if exists hbe" -c "create database hbe"`, { stdio: "ignore" });
const procs = [];
process.on("exit", () => procs.forEach((c) => c.kill())); // stop the servers even when a step throws
const start = (app, port, extra = {}) => new Promise((res, rej) => {
  const c = spawn("node", ["server/index.js"], { cwd: ROOT, env: { ...process.env, APP: app, PORT: String(port), DATABASE_URL: DB, SEED_SAMPLE: "0",
    ADMIN_SETUP_CODE: "setup-123", PASSKEY_PEPPER: "x", CHAIN_CONTRACT: CONTRACT, CHAIN_ID: "31337", CHAIN_RPC_URL: "http://127.0.0.1:8545", ...extra } });
  procs.push(c); let out = "";
  c.stdout.on("data", (d) => { out += d; if (out.includes("listening")) res(c); });
  c.stderr.on("data", (d) => process.stdout.write("[" + app + " err] " + d));
  setTimeout(() => rej(new Error(app + " didn't start")), 20000);
});
await start("platform", 5003);
await start("issuer", 5002, { CHAIN_WORKER: "1", CHAIN_SIGNER_KEY: KEY });
await start("holder", 5004);

const jar = {};
async function call(base, method, path, body) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: base, Cookie: jar[base] || "" }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) jar[base] = sc.split(";")[0];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(path + " " + r.status + " " + (j.error || ""));
  return j;
}
await call(P, "POST", "/api/auth/setup", { setupCode: "setup-123", name: "Owner", email: "o@x.test", password: "owner-pass-123" });
await call(I, "POST", "/api/auth/login", { email: "o@x.test", password: "owner-pass-123" });
await call(P, "POST", "/api/auth/login", { email: "o@x.test", password: "owner-pass-123" });
const iss = await call(I, "POST", "/api/issuers", { legalName: "Penson Trust", issuerCode: "PENS" });
const issuerId = iss.issuer?.id || (await call(I, "GET", "/api/auth/me")).issuers[0].id;
const st = () => call(I, "GET", "/api/state?issuer=" + issuerId);
const icommit = async (body) => call(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], reg: [], events: [], ...body });
const TOTAL = 10_000_000_000, A1 = "PENS-0001-BD-A00001", CODE = "7KQM-R4XW-9TPH-C2NV";
await icommit({ bonds: [{ id: "PENS-0001-BD", title: "Series A", face: TOTAL, total: TOTAL, unassigned: TOTAL, redeemed: 0, prior: [],
  registered: "Nov 8, 2026", instrumentHash: H32(), ucc1: { number: "DE-1", office: "Delaware", date: "Nov 7, 2026", hash: H32(), file: "u.pdf" } }] });
await call(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id: A1, passkey: CODE });
await icommit({ bonds: [{ ...(await st()).bonds[0], unassigned: TOTAL - 1_000_000 }], reg: [{ origin: "Issuer", parent: null, assignor: "Penson Trust", party: "Company A", contact: "D", position: "", address: "addr",
  status: "Issued", created: "Nov 9, 2026", accepted: null, filingRef: null, deliveryRef: null, instrumentMail: null, passkeyMail: null,
  id: A1, bond: "PENS-0001-BD", units: 1_000_000, issuedUnits: 1_000_000, docHash: H32() }] });
await icommit({ reg: [{ ...(await st()).reg[0], instrumentMail: "9407 1000 0000 0000 0000 01", passkeyMail: "9407 1000 0000 0000 0000 01" }] });
await icommit({ reg: [{ ...(await st()).reg[0], filingNumber: "UCC3-2026-0417", filedBy: "Penson Trust", filingRef: "pending" }] });

// ---- the browser, with a virtual passkey device (platform authenticator, face/fingerprint passes)
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
  protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
const shot = async (name) => SHOTS && page.screenshot({ path: SHOTS + "/" + name + ".png", fullPage: true });

await page.goto(H + "/holder");
await page.getByLabel("Assignment ID").fill(A1);
await page.getByLabel("Access code").fill(CODE);
await shot("1-sign-in");
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("heading", { name: "Set up this device" }).waitFor({ timeout: 15000 });
await shot("2-device-setup");
ok(true, "the mailed code opens the record and asks to set up the device");
await page.getByRole("button", { name: "Set up device key" }).click();
await page.getByRole("heading", { name: "Your access code" }).waitFor({ timeout: 20000 });
const personal = (await page.getByText(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/).first().textContent()).trim();
ok(personal !== CODE, "after device setup the holder gets their own access code, shown once");
await shot("3a-personal-code");
await page.getByRole("button", { name: "I've written it down" }).click();
await page.getByRole("heading", { name: "Review this assignment" }).waitFor({ timeout: 20000 });
const creds = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
ok(creds.length === 1 && creds[0].rpId === "localhost", "the device made one passkey for this site");
const rec1 = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === A1);
ok(!!rec1.deviceKey?.fingerprint, "the register shows the device key " + rec1.deviceKey?.fingerprint);
await shot("3-review");

await page.getByRole("button", { name: /Confirm/ }).click();
let saved = null;
for (let i = 0; i < 30 && !saved; i++) { await page.waitForTimeout(500); const r = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === A1); if (r.status === "Accepted") saved = r; }
ok(saved?.effective === "holder", "the holder's confirmation, signed on the device, is saved");
const signCount = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials[0].signCount;
ok(signCount >= 2, "the device signed the key registration and the confirmation (" + signCount + " signatures)");
await page.getByText("Signed with your device key").waitFor({ timeout: 10000 }).catch(() => {});
ok(await page.getByText("UCC3-2026-0417 · filed by Penson Trust").count() > 0, "the holder sees the UCC-3 filing number");
ok(await page.getByText(/9407 1000 0000 0000 0000 01/).count() > 0, "the signed-in holder sees their certified mail number");
const publicState = await call(H, "GET", "/api/state");
ok(!JSON.stringify(publicState).includes("9407 1000"), "the public record list never carries the mail number");
await shot("4-in-effect");

// ---- assign out $10.40 from the screen: no code to type, the device signs it
await page.getByRole("button", { name: "Assign out" }).click();
ok(!(await page.getByText(/Demo code|6-digit/).count()), "the assign-out screen asks for no typed code");
await page.getByLabel("Amount to assign").fill("10.40");
await page.getByLabel("Legal name").fill("Company D, LLC");
await page.getByLabel("Attention of").fill("M. Doe");
await page.getByLabel("Mailing address").fill("Company D, LLC\n1 Main St\nDover, DE 19901");
await page.locator('input[type="file"]').first().setInputFiles({ name: "assignment-to-company-d.pdf", mimeType: "application/pdf", buffer: Buffer.from("signed assignment") });
await shot("5-assign-out");
await page.getByRole("button", { name: "Create the assignment" }).click();
let child = null;
for (let i = 0; i < 30 && !child; i++) { await page.waitForTimeout(500); child = (await call(H, "GET", "/api/state")).reg.find((a) => a.parent === A1 && a.origin === "AssignOut"); }
ok(child?.units === 1040 && child.status === "Issued", "the $10.40 assign-out is saved, open to its assignee (" + (child?.id || "none") + ")");
const codeBox = page.getByText(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
await codeBox.waitFor({ timeout: 20000 }).catch(() => {});
ok(await codeBox.count() === 1, "the assignor's screen shows the new assignee's access code, once");
await shot("6-assignee-code");
const TRANSFER = (await codeBox.first().textContent()).trim();
// Back on the record, the list offers it again; it was already shown, so it says so.
await page.getByRole("button", { name: "Back to my record" }).click().catch(() => {});
const again = page.getByRole("button", { name: /transfer code/ });
if (await again.count()) { await again.first().click(); await page.waitForTimeout(800); }
ok(await page.getByText(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/).count() > 0, "the assignor can show the transfer code again from their record, until it's used");
const signs2 = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials[0].signCount;
ok(signs2 > signCount, "the device signed the assign-out (" + signs2 + " signatures)");

// ---- on-chain
const t0 = Date.now(); let s;
while (Date.now() - t0 < 90000) { s = await call(P, "GET", "/api/platform/chain"); if (!(s.counts.queued || s.counts.sent)) break; await new Promise((r) => setTimeout(r, 1000)); }
const id32 = (x) => ethers.keccak256(ethers.toUtf8Bytes(x));
const k = await regC.holderKeys(id32(A1));
ok(k.x !== 0n && k.nonce === 3n, "the chain holds the device key and counted 3 signatures from it (" + k.nonce + ")");
ok(Number((await regC.assignments(id32(A1))).status) === 4, "the chain shows A00001 in effect, by the holder's own signature");
ok(!s.counts.failed, "no write failed (" + JSON.stringify(s.counts) + ")");

// ---- a second browser with no passkey can sign in, but not act
const other = await browser.newContext({ viewport: { width: 430, height: 900 } });
const p2 = await other.newPage();
const cdp2 = await other.newCDPSession(p2);
await cdp2.send("WebAuthn.enable");
await cdp2.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await p2.goto(H + "/holder");
await p2.getByLabel("Assignment ID").fill(A1);
await p2.getByLabel("Access code").fill(CODE);
await p2.getByRole("button", { name: "Continue" }).click();
await p2.waitForTimeout(1500);
ok(!(await p2.getByRole("heading", { name: "Set up this device" }).count()), "the mailed transfer code no longer opens the record");
const before = await call(H, "GET", "/api/state");
// Try to lock it from the other browser: its device has no key for this record, so it can't sign.
const lockBtn = p2.getByRole("button", { name: /^Lock/ }).first();
if (await lockBtn.count()) { await lockBtn.click(); await p2.waitForTimeout(500); const go = p2.getByRole("button", { name: /^Lock/ }).last(); if (await go.count()) await go.click(); }
await p2.waitForTimeout(3000);
const after = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === A1);
ok(after.status === "Accepted", "without the device key, nothing changes (" + after.status + ")");

// ---- the new assignee, on their own device: transfer code -> passkey -> their own code -> reject with a reason
{
  const ctx3 = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
  const p3 = await ctx3.newPage();
  const cdp3 = await ctx3.newCDPSession(p3);
  await cdp3.send("WebAuthn.enable");
  await cdp3.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await p3.goto(H + "/holder");
  ok(!(await p3.getByRole("button", { name: "Request access" }).count()), "there's no Request access tab");
  await p3.getByLabel("Assignment ID").fill(child.id);
  await p3.getByLabel("Access code").fill(TRANSFER);
  await p3.getByRole("button", { name: "Continue" }).click();
  await p3.getByRole("heading", { name: "Set up this device" }).waitFor({ timeout: 15000 });
  ok(true, "the assignee opens the assign-out with the transfer code and is asked for a passkey");
  await p3.getByRole("button", { name: "Set up device key" }).click();
  await p3.getByRole("heading", { name: "Your access code" }).waitFor({ timeout: 20000 });
  await p3.getByRole("button", { name: "I've written it down" }).click();
  await p3.getByRole("heading", { name: "Review this assignment" }).waitFor({ timeout: 20000 });
  await p3.getByRole("button", { name: "Reject this assignment" }).click();
  const why = p3.getByLabel(/Reason for rejecting/);
  await why.fill("Not the amount we agreed.");
  ok(await p3.getByRole("button", { name: /^Reject: confirm with your passkey/ }).isDisabled(), "a short reason can't be submitted");
  await why.fill("The amount on the instrument I received does not match what the register shows, and I did not agree to take this portion " +
    "from the assignor. I have not signed anything about it and would like the issuer to review how this assignment was created. Please return it.");
  await shot("7-assignee-reject");
  await p3.getByRole("button", { name: /^Reject: confirm with your passkey/ }).click();
  let rj = null;
  for (let i = 0; i < 30 && !rj; i++) { await p3.waitForTimeout(500); const r = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === child.id); if (r.status === "Rejected") rj = r; }
  ok(!!rj && rj.rejectionReason.length >= 255, "the assignee's rejection, signed with their passkey, is saved with its reason");
  ok((await call(H, "GET", "/api/state")).reg.find((a) => a.id === A1).units === 1_000_000, "the $10.40 is back on the assignor's record");
  await ctx3.close();
}

await browser.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
for (const c of procs) c.kill();
process.exit(fails ? 1 : 0);
