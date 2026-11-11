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
const pg = require("pg");
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
    ADMIN_SETUP_CODE: "setup-123", PASSKEY_PEPPER: "x", CHAIN_CONTRACT: CONTRACT, CHAIN_ID: "31337", CHAIN_RPC_URL: "http://127.0.0.1:8545", CHAIN_PUBLIC_RPC: "http://127.0.0.1:8545", CHAIN_FROM_BLOCK: "0", ...extra } });
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
await icommit({ reg: [{ ...(await st()).reg[0], instrumentMail: "9407 1000 0000 0000 0000 01", passkeyMail: "9407 1000 0000 0000 0000 01", mailedOn: new Date().toISOString().slice(0, 10), mailingDoc: H32() }] });

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
await page.getByRole("button", { name: "Continue" }).click();
await page.getByLabel("Transfer code").fill(CODE);
await shot("1-sign-in");
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("heading", { name: "Set up this device" }).waitFor({ timeout: 15000 });
await shot("2-device-setup");
ok(true, "the mailed code opens the record and asks to set up the device");
await page.getByRole("button", { name: "Set up device key" }).click();
await page.getByRole("heading", { name: "Review this assignment" }).waitFor({ timeout: 20000 });
ok(!(await page.getByRole("heading", { name: "Your access code" }).count()), "no personal code: the passkey is the key");
const creds = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
ok(creds.length === 1 && creds[0].rpId === "localhost", "the device made one passkey for this site");
const rec1 = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === A1);
ok(!!rec1.deviceKey?.fingerprint, "the register shows the device key " + rec1.deviceKey?.fingerprint);
await shot("3-review");

await page.getByRole("button", { name: /^Accept: confirm with your passkey/ }).click();
let saved = null;
for (let i = 0; i < 30 && !saved; i++) { await page.waitForTimeout(500); const r = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === A1); if (r.status === "Accepted") saved = r; }
ok(saved?.effective === "holder", "the holder's confirmation, signed on the device, is saved");
// The preloader: the page shows the write on its way, then that it landed, without a reload.
{
  const seen = { busy: false, done: false };
  for (let i = 0; i < 60 && !seen.done; i++) {
    if (await page.getByText(/to the blockchain…/).count()) { seen.busy = true; if (SHOTS) await page.screenshot({ path: SHOTS + "/3b-writing.png" }); }
    if (await page.getByText("Recorded on-chain ✓").count()) seen.done = true;
    else await page.waitForTimeout(250);
  }
  ok(seen.done, "the page says when the confirmation is recorded on-chain, without a reload" + (seen.busy ? " (after showing it being written)" : ""));
  if (SHOTS) await page.screenshot({ path: SHOTS + "/3c-recorded.png" });
}
const signCount = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials[0].signCount;
ok(signCount >= 2, "the device signed the key registration and the confirmation (" + signCount + " signatures)");
await page.getByText("Signed with your device key").waitFor({ timeout: 10000 }).catch(() => {});
// The UCC-3 for the assignment the issuer gave is the issuer's: no form for it on the holder's record.
ok(!(await page.getByText("Record your UCC-3", { exact: true }).count()), "the holder isn't asked for the UCC-3 of the assignment they were given");
const ucc3Doc = H32();
await icommit({ reg: [{ ...(await st()).reg.find((a) => a.id === A1), filingNumber: "UCC3-2026-0417", filingDoc: ucc3Doc, filingFile: "ucc3-ack.pdf", filedOn: "Nov 11, 2026", filedBy: "Penson Trust" }] });
let filed = null;
for (let i = 0; i < 30 && !filed; i++) { await page.waitForTimeout(500); const r = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === A1); if (r.filingRef && /^0x/.test(r.filingRef)) filed = r; }
await page.getByText("UCC3-2026-0417 · filed by Penson Trust").first().waitFor({ timeout: 15000 }).catch(() => {});
ok(await page.getByText("UCC3-2026-0417 · filed by Penson Trust").count() > 0, "the holder sees the issuer's UCC-3 filing number");
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
ok(child?.id === A1 + "-1", "the assign-out from A00001 is numbered A00001-1 (" + child?.id + ")");
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
// The assignor records the certified mailing from their list: click Edit, fill it in, confirm.
const childCard = page.locator("div.mb-2", { has: page.getByText(child.id + " · ", { exact: false }) }).first();
await childCard.getByRole("button", { name: "Edit" }).click();
await childCard.getByLabel("Certified mail number").fill("9407 1000 0000 0000 0000 77");
ok(await childCard.getByLabel("Date sent").count() === 1, "the sender's delivery receipt asks for the date sent");
await childCard.locator('input[type="file"]').setInputFiles({ name: "ps3800.pdf", mimeType: "application/pdf", buffer: Buffer.from("certified mail receipt") });
await page.getByRole("button", { name: "Confirm with your passkey", exact: true }).click();
let mailed = null;
for (let i = 0; i < 30 && !mailed; i++) { await page.waitForTimeout(500); const r = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === child.id); if (r?.deliveryRef) mailed = r; }
ok(!!mailed && !!mailed.mailedOn, "the assignor's certified mailing is recorded, with its date (" + mailed?.mailedOn + ")");
// The assignor records the UCC-3 for the assign-out they made, from their list.
await page.getByRole("button", { name: "Record the UCC-3 for this assignment" }).click();
await page.getByLabel("Filing number").fill("UCC3-2026-0555");
await page.locator("div.mt-3", { has: page.getByText(/^Record your UCC-3 for/) }).locator('input[type="file"]').setInputFiles({ name: "ucc3-child.pdf", mimeType: "application/pdf", buffer: Buffer.from("child ucc-3") });
await page.getByRole("button", { name: /^Record UCC-3: confirm with your passkey/ }).click();
let childUcc = null;
for (let i = 0; i < 30 && !childUcc; i++) { await page.waitForTimeout(500); const r = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === child.id); if (r?.filingRef && /^0x/.test(r.filingRef)) childUcc = r; }
ok(childUcc?.filingNumber === "UCC3-2026-0555" && childUcc.filedBy === "Company A", "the assignor records the UCC-3 for their assign-out, with its reference");
const signs2 = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials[0].signCount;
ok(signs2 > signCount, "the device signed the assign-out (" + signs2 + " signatures)");

// ---- on-chain
const t0 = Date.now(); let s;
while (Date.now() - t0 < 90000) { s = await call(P, "GET", "/api/platform/chain"); if (!(s.counts.queued || s.counts.sent)) break; await new Promise((r) => setTimeout(r, 1000)); }
const id32 = (x) => ethers.keccak256(ethers.toUtf8Bytes(x));
const k = await regC.holderKeys(id32(A1));
ok(k.x !== 0n && k.nonce === 5n, "the chain holds the device key and counted 5 signatures from it: key, accept, assign-out, mailing, the assign-out's UCC-3 (" + k.nonce + ")");
ok(!!filed && (await regC.assignments(id32(A1))).filingRef === filed.filingRef, "the chain holds the issuer's UCC-3 reference");
ok((await regC.assignments(id32(child.id))).filingRef === childUcc?.filingRef, "and the assignor's UCC-3 for the assign-out");
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
await p2.getByRole("button", { name: "Continue" }).click();
await p2.getByRole("button", { name: "Sign in with your passkey" }).waitFor({ timeout: 10000 });
ok(!(await p2.getByLabel("Transfer code").count()), "once the transfer code is used, Holder access asks for the passkey, not a code");
ok(await p2.getByText(/Set up/).count() > 0, "and shows when the key was set up");
await p2.getByRole("button", { name: "Sign in with your passkey" }).click();
await p2.waitForTimeout(3000);
ok(!(await p2.getByRole("heading", { name: "Review this assignment" }).count()) && !(await p2.getByRole("button", { name: "Assign out" }).count()), "a device without the passkey can't get in");
const before = await call(H, "GET", "/api/state");
// Try to lock it from the other browser: its device has no key for this record, so it can't sign.
const lockBtn = p2.getByRole("button", { name: /^Lock/ }).first();
if (await lockBtn.count()) { await lockBtn.click(); await p2.waitForTimeout(500); const go = p2.getByRole("button", { name: /^Lock/ }).last(); if (await go.count()) await go.click(); }
await p2.waitForTimeout(3000);
const after = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === A1);
ok(after.status === "Accepted", "without the device key, nothing changes (" + after.status + ")");

// ---- the new assignee, on their own device: transfer code -> passkey -> reject with a reason
{
  const ctx3 = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
  const p3 = await ctx3.newPage();
  const cdp3 = await ctx3.newCDPSession(p3);
  await cdp3.send("WebAuthn.enable");
  await cdp3.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await p3.goto(H + "/holder");
  ok(!(await p3.getByRole("button", { name: "Request access" }).count()), "there's no Request access tab");
  await p3.getByLabel("Assignment ID").fill(child.id);
  await p3.getByRole("button", { name: "Continue" }).click();
  await p3.getByLabel("Transfer code").fill(TRANSFER);
  await p3.getByRole("button", { name: "Continue" }).click();
  await p3.getByRole("heading", { name: "Set up this device" }).waitFor({ timeout: 15000 });
  ok(true, "the assignee opens the assign-out with the transfer code and is asked for a passkey");
  await p3.getByRole("button", { name: "Set up device key" }).click();
  await p3.getByRole("heading", { name: "Review this assignment" }).waitFor({ timeout: 20000 });
  // The assignee records their delivery receipt from the review screen.
  const rcRow = p3.locator("div.mt-3", { has: p3.getByText("Delivery receipt", { exact: true }) }).first();
  await rcRow.getByRole("button", { name: "Edit" }).click();
  ok(await p3.getByLabel("Date received").count() === 1 && await p3.getByLabel("Certified mail number on the receipt").inputValue() !== "",
    "the assignee's delivery receipt asks for the date received, with the same certified mail number filled in");
  await p3.getByLabel("Certified mail number on the receipt").fill("9407-1000-0000-0000-0000-77");
  await p3.locator('input[type="file"]').first().setInputFiles({ name: "usps-delivered.pdf", mimeType: "application/pdf", buffer: Buffer.from("delivered") });
  await p3.getByRole("button", { name: "Confirm with your passkey", exact: true }).click();
  let got = null;
  for (let i = 0; i < 30 && !got; i++) { await p3.waitForTimeout(500); const r = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === child.id); if (r?.receiptRef) got = r; }
  ok(!!got && got.receiptMatches === true, "the assignee's delivery receipt is recorded, and its tracking number matches the assignor's mailing");
  await p3.getByText("Received " + got?.receivedOn, { exact: false }).first().waitFor({ timeout: 10000 }).catch(() => {});
  ok(await p3.getByText("Received " + got?.receivedOn, { exact: false }).count() > 0, "the assignee's receipt shows the date received");
  await p3.getByText(/tracking number matches the mailing/).waitFor({ timeout: 10000 }).catch(() => {});
  ok(await p3.getByText(/tracking number matches the mailing/).count() > 0, "the assignee sees the receipt recorded, matched to the mailing");
  if (SHOTS) await p3.screenshot({ path: SHOTS + "/7a-receipt.png", fullPage: true });
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

// ---- Verify: the browser reads the chain itself and compares it with the register
{
  const t1 = Date.now();
  while (Date.now() - t1 < 60000) { const q = await call(P, "GET", "/api/platform/chain"); if (!(q.counts.queued || q.counts.sent)) break; await new Promise((r) => setTimeout(r, 1000)); }
  await page.goto(H + "/holder");
  await page.getByRole("button", { name: "Verify" }).click();
  const box = page.getByLabel("Assignment or bond ID");
  await box.fill("PENS-0001-BD");
  await page.getByRole("button", { name: "Check the chain" }).click();
  await page.getByText(/agrees with the chain on this bond/).waitFor({ timeout: 20000 }).catch(() => {});
  ok(await page.getByText(/agrees with the chain on this bond/).count() > 0, "Verify: the bond's figures on-chain match the register");
  await box.fill(A1);
  await page.getByRole("button", { name: "Check the chain" }).click();
  await page.getByText(/register agrees with the chain/).waitFor({ timeout: 20000 }).catch(() => {});
  ok(await page.getByText(/register agrees with the chain/).count() > 0, "Verify: the assignment on-chain matches the register");
  // A record removed from the register still shows on-chain, flagged as removed.
  const db = new pg.Client({ connectionString: DB }); await db.connect();
  await db.query("delete from chain_ops where ref = $1", [child.id]); await db.query("delete from assignments where id = $1", [child.id]);
  await db.query("update meta set version = version + 1 where k = 'v'"); await db.end();
  await page.reload();
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByLabel("Assignment or bond ID").fill(child.id);
  await page.getByRole("button", { name: "Check the chain" }).click();
  await page.getByText(/has no .* it was removed from the register/).waitFor({ timeout: 20000 }).catch(() => {});
  ok(await page.getByText(/it was removed from the register/).count() > 0, "Verify: a record removed from the register is flagged, not shown as current");
  await page.getByText("Assignment rejected by the holder").or(page.getByText("No events found.")).first().waitFor({ timeout: 20000 }).catch(() => {});
  const hist = await page.locator("text=History on-chain").locator("xpath=following-sibling::*[1]").innerText().catch(() => "");
  ok(/Created by an assign-out/.test(hist) && !/No events found/.test(hist), "Verify: the record's on-chain history is listed (" + hist.replace(/\s+/g, " ").slice(0, 120) + ")");
  await shot("8-verify");
}

await browser.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
for (const c of procs) c.kill();
process.exit(fails ? 1 : 0);
