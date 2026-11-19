// Browser end-to-end: a holder signs in on the portal, sets up a device key with a (virtual)
// passkey authenticator, confirms an assignment, assigns out, and the new assignee rejects.
// Every act must be signed with the right passkey, and the signatures kept.
//
// Needs Postgres on 127.0.0.1:54329 and the apps built (npm run build). Run from the repo root:
//   node e2e/holder-browser-e2e.mjs [screenshot-dir]
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium } = require("playwright");

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SHOTS = process.argv[2] || null;
const DB = "postgres://postgres@127.0.0.1:54329/hbe";
const pg = require("pg");
const I = "http://localhost:5002", P = "http://localhost:5003", H = "http://localhost:5004";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const H32 = () => "0x" + crypto.randomBytes(32).toString("hex");

execSync(`psql -h 127.0.0.1 -p 54329 -U postgres -q -c "drop database if exists hbe" -c "create database hbe"`, { stdio: "ignore" });
const procs = [];
process.on("exit", () => procs.forEach((c) => c.kill())); // stop the servers even when a step throws
const start = (app, port, extra = {}) => new Promise((res, rej) => {
  const c = spawn("node", ["server/index.js"], { cwd: ROOT, env: { ...process.env, APP: app, PORT: String(port), DATABASE_URL: DB, SEED_SAMPLE: "0",
    ADMIN_SETUP_CODE: "setup-123", PASSKEY_PEPPER: "x", ...extra } });
  procs.push(c); let out = "";
  c.stdout.on("data", (d) => { out += d; if (out.includes("listening")) res(c); });
  c.stderr.on("data", (d) => process.stdout.write("[" + app + " err] " + d));
  setTimeout(() => rej(new Error(app + " didn't start")), 20000);
});
await start("platform", 5003);
await start("issuer", 5002);
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
page.on("pageerror", (e) => console.log("[page error] " + e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
  protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
const shot = async (name) => SHOTS && page.screenshot({ path: SHOTS + "/" + name + ".png", fullPage: true });

{
  const r = await fetch(H + "/holder", { redirect: "manual" });
  ok(r.status === 301 && r.headers.get("location") === "/assignee", "the old /holder address redirects to /assignee");
}
await page.goto(H + "/assignee");
{
  const left = (await page.locator("body").innerText()).split("\n").filter((l) => /\bholders?\b/i.test(l));
  ok(await page.getByRole("button", { name: "Assignee access" }).count() === 1 && !left.length, "the portal says assignee, never holder" + (left.length ? ": " + left.join(" | ") : ""));
}
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
// The first-time tour: offered once the passkey is set up; this assignee takes it, step by step.
{
  await page.getByRole("button", { name: "Show me around" }).waitFor({ timeout: 10000 });
  ok(await page.getByRole("button", { name: "Skip, I've done this before" }).count() === 1, "after the passkey, the tour is offered, with a way to skip it");
  await page.getByRole("button", { name: "Show me around" }).click();
  const titles = [];
  for (let n = 0; n < 10; n++) {
    const dlg = page.getByRole("dialog");
    await dlg.waitFor({ timeout: 5000 }).catch(() => {});
    if (!(await dlg.count())) break;
    titles.push((await dlg.locator("div").nth(2).innerText().catch(() => "")).trim());
    if (n === 3 && SHOTS) { await page.waitForTimeout(700); await page.screenshot({ path: SHOTS + "/3a-tour.png" }); }
    const btn = dlg.getByRole("button", { name: /^(Next|Done)$/ });
    if (!(await btn.count())) break;
    await btn.click();
    await page.waitForTimeout(150);
  }
  ok(titles.length === 7 && !(await page.getByRole("dialog").count()), "the tour walks through 7 tips and closes (" + titles.join(" / ") + ")");
  ok(await page.evaluate(() => localStorage.getItem("assignee-tour-seen")) === "1", "the device remembers the tour was seen");
}
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
ok(!(await page.getByText(/blockchain|on-chain/i).count()), "the page no longer talks about a blockchain");
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
const QR_LINK = (await import(ROOT + "/src/print-packet.js")).assigneeLink(H, child.id);
// The mailing packet: the instruction letter with the entries filled in, and the code on its own page.
{
  const [pop] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Print mailing packet" }).first().click()]);
  await pop.waitForLoadState();
  const txt = await pop.locator("body").innerText();
  ok(txt.includes(child.id) && txt.includes("$10.40") && txt.includes("Company D, LLC") && txt.includes(TRANSFER)
    && /\/assignee/.test(txt) && /255 characters/.test(txt) && /30 days/.test(txt) && (await pop.locator("section.page").count()) === 2,
    "the mailing packet prints the letter with the entries and instructions, and the code on its own page");
  ok(await pop.locator("header .qr svg").count() === 1 && /Scan to open/.test(txt), "the letter has a QR code under the date");
  if (SHOTS) await pop.screenshot({ path: SHOTS + "/6b-packet.png", fullPage: true });
  await pop.close();
}
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

// ---- the kept signatures
{
  const db = new pg.Client({ connectionString: DB }); await db.connect();
  const fns = (await db.query("select fn from holder_signatures where signer = $1 order by seq", [A1])).rows.map((r) => r.fn); await db.end();
  ok(fns.join(",") === "registerHolderKey,accept,assignOut,recordMailing,recordFiling",
    "A00001's passkey signed 5 acts, each kept: key, accept, assign-out, mailing, the assign-out's UCC-3 (" + fns.join(", ") + ")");
  ok(!!filed && filed.filingNumber === "UCC3-2026-0417", "the register holds the issuer's UCC-3");
}

// ---- a second browser with no passkey can sign in, but not act
const other = await browser.newContext({ viewport: { width: 430, height: 900 } });
const p2 = await other.newPage();
const cdp2 = await other.newCDPSession(p2);
await cdp2.send("WebAuthn.enable");
await cdp2.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await p2.goto(H + "/assignee");
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
  // The assignee scans the packet's QR code: the portal opens with the assignment ID in and asks for the code.
  await p3.goto(QR_LINK);
  ok(!(await p3.getByRole("button", { name: "Request access" }).count()), "there's no Request access tab");
  await p3.getByLabel("Transfer code").waitFor({ timeout: 15000 });
  ok((await p3.getByLabel("Assignment ID").inputValue()) === child.id, "the QR link opens the portal with the assignment ID filled in, straight to the transfer code");
  await p3.getByLabel("Transfer code").fill(TRANSFER);
  await p3.getByRole("button", { name: "Continue" }).click();
  await p3.getByRole("heading", { name: "Set up this device" }).waitFor({ timeout: 15000 });
  ok(true, "the assignee opens the assign-out with the transfer code and is asked for a passkey");
  await p3.getByRole("button", { name: "Set up device key" }).click();
  await p3.getByRole("heading", { name: "Review this assignment" }).waitFor({ timeout: 20000 });
  // Not their first assignment: they skip the tour.
  await p3.getByRole("button", { name: "Skip, I've done this before" }).click();
  ok(!(await p3.getByRole("dialog").count()), "the tour can be skipped");
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

// ---- Verify: anyone can check a bond or an assignment against the register
{
  await page.goto(H + "/assignee");
  await page.getByRole("button", { name: "Verify" }).click();
  const box = page.getByLabel("Assignment or bond ID");
  await box.fill("PENS-0001-BD");
  await page.getByRole("button", { name: "Check the register" }).click();
  await page.getByText("Adds up to the total").waitFor({ timeout: 10000 }).catch(() => {});
  ok(await page.getByText("Yes ✓").count() > 0, "Verify: the bond's figures add up to its total");
  await box.fill(child.id);
  await page.getByRole("button", { name: "Check the register" }).click();
  await page.getByText(/The assignee rejected this assignment/).waitFor({ timeout: 10000 }).catch(() => {});
  ok(await page.getByText(/The assignee rejected this assignment/).count() > 0, "Verify: the assignment's status is shown");
  const hist = await page.locator("text=History").last().locator("xpath=following-sibling::*[1]").innerText().catch(() => "");
  ok(hist.trim() && !/No events recorded/.test(hist), "Verify: the record's history is listed (" + hist.replace(/\s+/g, " ").slice(0, 120) + ")");
  // Their copy of the instrument: the same file matches, another doesn't.
  await page.locator('input[type="file"]').first().setInputFiles({ name: "assignment-to-company-d.pdf", mimeType: "application/pdf", buffer: Buffer.from("signed assignment") });
  await page.getByText(/^Match\./).waitFor({ timeout: 10000 }).catch(() => {});
  ok(await page.getByText(/^Match\./).count() > 0, "Verify: the signed instrument's copy matches the one on record");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("altered") });
  await page.getByText(/^No match\./).waitFor({ timeout: 10000 }).catch(() => {});
  ok(await page.getByText(/^No match\./).count() > 0, "Verify: an altered copy doesn't");
  await box.fill("PENS-0001-BD-A09999");
  await page.getByRole("button", { name: "Check the register" }).click();
  ok(await page.getByText(/Nothing with the ID PENS-0001-BD-A09999/).count() > 0, "Verify: an unknown ID says so");
  await shot("8-verify");
}

await browser.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
for (const c of procs) c.kill();
process.exit(fails ? 1 : 0);
