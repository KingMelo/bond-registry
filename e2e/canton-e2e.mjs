// End-to-end, register → Canton (pilot): one assignment, its assignee's own keys, recovery.
//
//   1. The issuer issues A00001 in the register; it becomes an offer on Canton.
//   2. The assignee opens it in a browser: transfer code, passkey, then their Canton keys (a device
//      key the browser can't export, and a recovery code shown once), and accepts.
//   3. Canton has the Assignment, signed with the assignee's device key.
//   4. On a second browser (their passkey synced to it), they add that browser with the recovery code,
//      then replace the first browser as lost: its key stops working on Canton; the new one works.
//
// Needs Postgres on 127.0.0.1:54329, the apps built, and a Canton sandbox with the registry's DAR:
//   (cd canton && daml build && daml sandbox --json-api-port 7575 --dar .daml/dist/bond-registry-0.3.0.dar)
// Run from the repo root: node e2e/canton-e2e.mjs [screenshot-dir]
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium } = require("playwright");
const pg = require("pg");

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SHOTS = process.argv[2] || null;
const DB = "postgres://postgres@127.0.0.1:54329/cte";
const CANTON = process.env.CANTON_JSON_URL || "http://localhost:7575";
const JAR = process.env.CANTON_JAR || path.join(os.homedir(), ".daml/sdk/3.4.0-rc2/canton/canton.jar");
const I = "http://localhost:5202", P = "http://localhost:5203", H = "http://localhost:5204";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const H32 = () => "0x" + crypto.randomBytes(32).toString("hex");
const b64 = (b) => Buffer.from(b).toString("base64");

// Canton's admin API definitions, for the servers.
const PROTOS = fs.mkdtempSync(path.join(os.tmpdir(), "canton-protos-"));
execSync(`unzip -q -o "${JAR}" '*.proto' -d "${PROTOS}"`);

execSync(`psql -h 127.0.0.1 -p 54329 -U postgres -q -c "drop database if exists cte" -c "create database cte"`, { stdio: "ignore" });
const procs = [];
process.on("exit", () => { procs.forEach((c) => c.kill()); fs.rmSync(PROTOS, { recursive: true, force: true }); });
const start = (app, port) => new Promise((res, rej) => {
  const c = spawn("node", ["server/index.js"], { cwd: ROOT, env: { ...process.env, APP: app, PORT: String(port), DATABASE_URL: DB, SEED_SAMPLE: "0",
    ADMIN_SETUP_CODE: "setup-123", PASSKEY_PEPPER: "x", RESPONSE_CHECK_MS: "1500", CANTON_JSON_URL: CANTON, CANTON_ADMIN: "localhost:6866", CANTON_PROTOS: PROTOS } });
  procs.push(c); let out = "";
  c.stdout.on("data", (d) => { out += d; process.env.VERBOSE && process.stdout.write("[" + app + "] " + d); if (out.includes("listening")) res(c); });
  c.stderr.on("data", (d) => process.stdout.write("[" + app + " err] " + d));
  setTimeout(() => rej(new Error(app + " didn't start")), 20000);
});
await start("platform", 5203); await start("issuer", 5202); await start("holder", 5204);

const jar = {};
async function call(base, method, p, body) {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json", Origin: base, Cookie: jar[base] || "" }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) jar[base] = sc.split(";")[0];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(p + " " + r.status + " " + (j.error || JSON.stringify(j).slice(0, 300)));
  return j;
}
const canton = async (method, p, body) => {
  const r = await fetch(CANTON + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
};
const q = async (sql, args = []) => { const c = new pg.Client({ connectionString: DB }); await c.connect(); try { return (await c.query(sql, args)).rows; } finally { await c.end(); } };

// ---- 1. the issuer's bond and assignment
await call(P, "POST", "/api/auth/setup", { setupCode: "setup-123", name: "Owner", email: "o@x.test", password: "owner-pass-123" });
await call(I, "POST", "/api/auth/login", { email: "o@x.test", password: "owner-pass-123" });
const iss = await call(I, "POST", "/api/issuers", { legalName: "Penson Trust", issuerCode: "PENS" });
const issuerId = iss.issuer?.id || (await call(I, "GET", "/api/auth/me")).issuers[0].id;
const st = () => call(I, "GET", "/api/state?issuer=" + issuerId);
const icommit = async (body) => call(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], reg: [], events: [], ...body });
const TOTAL = 10_000_000_000, A1 = "PENS-0001-BD-A00001", CODE = "7KQM-R4XW-9TPH-C2NV";
await icommit({ bonds: [{ id: "PENS-0001-BD", title: "Series A", face: TOTAL, total: TOTAL, unassigned: TOTAL, redeemed: 0, prior: [],
  registered: "Nov 8, 2026", instrumentHash: H32(), ucc1: { number: "DE-1", office: "Delaware", date: "Nov 7, 2026", hash: H32(), file: "u.pdf" } }] });
await call(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id: A1, passkey: CODE });
const docHash = H32();
await icommit({ bonds: [{ ...(await st()).bonds[0], unassigned: TOTAL - 1_000_000 }], reg: [{ origin: "Issuer", parent: null, assignor: "Penson Trust", party: "Company A",
  contact: "D", position: "", address: "addr", status: "Issued", created: "Nov 9, 2026", accepted: null, filingRef: null, deliveryRef: null,
  instrumentMail: null, passkeyMail: null, id: A1, bond: "PENS-0001-BD", units: 1_000_000, issuedUnits: 1_000_000, docHash }] });
{
  const refs = await q("select ref, template from canton_refs order by ref");
  ok(refs.some((r) => r.ref === A1 && r.template === "AssignmentOffer") && refs.some((r) => r.ref === "PENS-0001-BD" && r.template === "Bond"),
    "issuing in the register put the bond and an offer for " + A1 + " on Canton");
}

const acsFor = async (party) => {
  const end = (await canton("GET", "/v2/state/ledger-end")).body.offset;
  const r = await canton("POST", "/v2/state/active-contracts", { activeAtOffset: end, eventFormat: { verbose: false,
    filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } } });
  return (Array.isArray(r.body) ? r.body : []).map((x) => x.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean);
};
const issuerParty = (await q("select party from canton_parties where name like 'issuer-PENS%'"))[0].party;
const onCanton = async (template, recordId) => (await acsFor(issuerParty)).find((e) => e.templateId.endsWith(":Registry:" + template) && e.createArgument.recordId === recordId);
const until = async (f, ms = 30000) => { for (let t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 1000))) { const v = await f(); if (v) return v; } return null; };

// The issuer mails the packet and records it, and records the UCC-3: both go on Canton as the issuer's own acts.
{
  const r = (await st()).reg.find((a) => a.id === A1);
  await icommit({ reg: [{ ...r, instrumentMail: "9407 1000 0000 0000 0000 01", passkeyMail: "9407 1000 0000 0000 0000 01",
    mailedOn: new Date().toISOString().slice(0, 10), mailingDoc: H32(), filingNumber: "UCC3-2026-0417", filingDoc: H32(), filingFile: "ucc3.pdf",
    filedOn: "Nov 19, 2026", filedBy: "Penson Trust" }] });
  const saved = (await st()).reg.find((a) => a.id === A1);
  const offer = await until(async () => { const o = await onCanton("AssignmentOffer", A1); return o?.createArgument.deliveryRef && o.createArgument.ucc3Hash ? o : null; });
  ok(offer?.createArgument.deliveryRef === saved.deliveryRef && offer.createArgument.mailedOn?.startsWith(saved.mailedOn),
    "the issuer's certified mailing is on Canton: its fingerprint and the date sent (" + offer?.createArgument.mailedOn + ")");
  ok(offer?.createArgument.ucc3Hash === saved.filingDoc && offer.signatories.length === 1, "and its UCC-3's filed copy, as the issuer's own act");
}

// ---- 2. the assignee, in a browser with a (virtual) passkey device
const browser = await chromium.launch();
async function newBrowser() {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[page error] " + e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { ctx, page, cdp, authenticatorId };
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: SHOTS + "/" + name + ".png", fullPage: true });
const one = await newBrowser();
let page = one.page;
await page.goto(H + "/assignee?id=" + A1);
await page.getByLabel("Transfer code").waitFor({ timeout: 15000 });
await page.getByLabel("Transfer code").fill(CODE);
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("button", { name: "Set up device key" }).click();
await page.getByRole("heading", { name: "Set up your keys" }).waitFor({ timeout: 20000 });
ok(true, "after the passkey, the assignee is asked to set up their Canton keys");
await shot(page, "c1-keys");
await page.getByRole("button", { name: "Make my keys" }).click();
await page.getByTestId("recovery-code").waitFor({ timeout: 30000 });
const RECOVERY = (await page.getByTestId("recovery-code").innerText()).trim().split(/\s+/).join("-");
ok(/^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/.test(RECOVERY), "the recovery code is shown once: 14 groups of four (" + RECOVERY.slice(0, 9) + "…)");
await shot(page, "c2-recovery");
const cont = page.getByRole("button", { name: "I've kept it: continue" });
ok(await cont.isDisabled(), "it can't be skipped: the last group has to be typed back");
await page.getByLabel(/type its last group/).fill(RECOVERY.split("-").pop());
await cont.click();
await page.getByRole("heading", { name: "Review this assignment" }).waitFor({ timeout: 20000 });
ok(!(await page.getByTestId("recovery-code").count()), "and once past it, the page doesn't show it again");
const holder = (await q("select party, keys from canton_holders where record = $1", [A1]))[0];
ok(!!holder && holder.keys.length === 2 && holder.keys.some((k) => k.role === "recovery") && holder.keys.some((k) => k.role === "device"),
  "the assignee has an external party on Canton with a recovery key and this browser's device key (" + holder?.party.split("::")[0] + ")");
ok(holder.keys.every((k) => !("privateKey" in k)) && !JSON.stringify(holder).includes(RECOVERY.replace(/-/g, "")), "the server keeps only public halves; the recovery code never reached it");
const stored = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("bond-registry-keys"); r.onsuccess = () => { const t = r.result.transaction("keys").objectStore("keys").getAll(); t.onsuccess = () => res(t.result.map((k) => k.privateKey.extractable)); };
}));
ok(stored.length === 1 && stored[0] === false, "this browser's device key is stored non-extractable");

// The tour may be offered; skip it, then accept.
const skip = page.getByRole("button", { name: "Skip, I've done this before" });
if (await skip.count()) await skip.click();
// The assignee records their delivery receipt; their key signs it on Canton.
async function recordReceipt(pg, name, expectId) {
  const rcRow = pg.locator("div.mt-3", { has: pg.getByText("Delivery receipt", { exact: true }) }).first();
  await rcRow.getByRole("button", { name: "Edit" }).click();
  await pg.getByLabel("Date received").fill(new Date().toISOString().slice(0, 10));
  await pg.locator('input[type="file"]').first().setInputFiles({ name: "usps-delivered.pdf", mimeType: "application/pdf", buffer: Buffer.from("delivered " + name) });
  await pg.getByRole("button", { name: "Confirm with your passkey", exact: true }).click();
  await answerCanton(pg, new RegExp("Record your delivery receipt for " + expectId + ", received \\d{4}-\\d{2}-\\d{2}\\. Its fingerprint: 0x"), "receipt " + name);
}

await recordReceipt(page, "A", A1.replace(/-/g, "\\-"));
{
  const saved = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === A1);
  const offer = await until(async () => { const o = await onCanton("AssignmentOffer", A1); return o?.createArgument.receiptRef ? o : null; });
  ok(!!saved.receiptRef && offer?.createArgument.receiptRef === saved.receiptRef, "Company A's delivery receipt is on Canton, signed with its own key");
}
await page.getByRole("button", { name: /^Accept: confirm with your passkey/ }).click();
// Before the key signs, the page checks the transaction against its hash and says what it does.
async function answerCanton(pg, expect, name) {
  const dlg = pg.getByTestId("canton-ask");
  await dlg.waitFor({ timeout: 40000 }).catch(() => {});
  const said = (await dlg.innerText().catch(() => "")).replace(/\s+/g, " ");
  ok(expect.test(said) && (await pg.getByText(/Checked in this browser/).count()) > 0, name + ": the page checks it and shows what it does (" + said.slice(0, 150) + ")");
  if (SHOTS) await pg.screenshot({ path: SHOTS + "/ask-" + name.replace(/\W+/g, "-").slice(0, 30) + ".png" });
  await pg.getByRole("button", { name: "Sign with this browser's key" }).click();
}
await answerCanton(page, /Accept assignment PENS-0001-BD-A00001 of \$10,000\.00 in bond PENS-0001-BD, from issuer PENS\./, "accepting");
await page.getByText(/On Canton: in effect, signed with your own key/).waitFor({ timeout: 40000 }).catch(() => {});
ok(await page.getByText(/On Canton: in effect, signed with your own key/).count() > 0, "accepting in the register is then signed on Canton with the device key");
await shot(page, "c3-in-effect");

// ---- 3. what Canton holds, read straight from the node
{
  const mine = (await acsFor(holder.party)).filter((e) => e.templateId.endsWith(":Registry:Assignment"));
  ok(mine.length === 1 && mine[0].createArgument.recordId === A1 && mine[0].signatories.includes(holder.party) && mine[0].createArgument.instrumentHash === docHash,
    "Canton holds the Assignment for " + A1 + ", signed by the assignee's party, with the signed paper's fingerprint");
  ok(mine[0].createArgument.units === "1000000", "and the same amount as the register ($10,000.00)");
}

// ---- an assign-out, rejected by its new assignee, and the units taken back, all signed on Canton
const CHILD = A1 + "-1";
await page.getByRole("button", { name: "Assign out" }).click();
await page.getByLabel("Amount to assign").fill("10.40");
await page.getByLabel("Legal name").fill("Company D, LLC");
await page.getByLabel("Attention of").fill("M. Doe");
await page.getByLabel("Mailing address").fill("Company D, LLC\n1 Main St\nDover, DE 19901");
await page.locator('input[type="file"]').first().setInputFiles({ name: "assignment-to-company-d.pdf", mimeType: "application/pdf", buffer: Buffer.from("signed assignment to D") });
await page.getByRole("button", { name: "Create the assignment" }).click();
await answerCanton(page, /Assign \$10\.40 of PENS-0001-BD-A00001 to Company D, LLC, as PENS-0001-BD-A00001-1\. New signed paper: 0x.*You keep \$9,989\.60/, "assigning out");
const childDoc = "0x" + crypto.createHash("sha256").update("signed assignment to D").digest("hex");
for (let i = 0; i < 30 && !(await onCanton("AssignmentOffer", CHILD)); i++) await new Promise((r) => setTimeout(r, 1000));
{
  const rest = await onCanton("Assignment", A1), offer = await onCanton("AssignmentOffer", CHILD);
  ok(rest?.createArgument.units === "998960" && rest.createArgument.carveOuts.includes(childDoc) && rest.createArgument.instrumentHash === docHash,
    "on Canton, A00001 now holds $9,989.60, keeps its own paper and lists the new one as a carve-out");
  ok(offer?.createArgument.units === "1040" && offer.createArgument.instrumentHash === childDoc && offer.signatories.includes(holder.party),
    "and " + CHILD + " is an offer of $10.40 with its own paper, signed by Company A's own party");
}
const codeBox = page.getByText(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
await codeBox.first().waitFor({ timeout: 20000 });
const TRANSFER = (await codeBox.first().textContent()).trim();
await page.getByRole("button", { name: "Back to my record" }).click().catch(() => {});
// Company A, as assignor, records the certified mailing and the UCC-3 for its assign-out; its key signs each.
{
  const childCard = page.locator("div.mb-2", { has: page.getByText(CHILD + " · ", { exact: false }) }).first();
  await childCard.getByRole("button", { name: "Edit" }).click();
  await childCard.getByLabel("Certified mail number").fill("9407 1000 0000 0000 0000 77");
  await childCard.locator('input[type="file"]').setInputFiles({ name: "ps3800.pdf", mimeType: "application/pdf", buffer: Buffer.from("certified mail receipt") });
  await page.getByRole("button", { name: "Confirm with your passkey", exact: true }).click();
  await answerCanton(page, /Record the certified mailing of PENS-0001-BD-A00001-1 to Company D, LLC, sent \d{4}-\d{2}-\d{2}\. Its fingerprint: 0x/, "assignor's mailing");
  const mailed = await until(async () => { const o = await onCanton("AssignmentOffer", CHILD); return o?.createArgument.deliveryRef ? o : null; });
  const reg = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === CHILD);
  ok(mailed?.createArgument.deliveryRef === reg.deliveryRef, "the assignor's mailing of " + CHILD + " is on Canton, signed with Company A's key");
  await page.getByRole("button", { name: "Record the UCC-3 for this assignment" }).click();
  await page.getByLabel("Filing number").fill("UCC3-2026-0555");
  await page.locator("div.mt-3", { has: page.getByText(/^Record your UCC-3 for/) }).locator('input[type="file"]').setInputFiles({ name: "ucc3-child.pdf", mimeType: "application/pdf", buffer: Buffer.from("child ucc-3") });
  await page.getByRole("button", { name: /^Record UCC-3: confirm with your passkey/ }).click();
  await answerCanton(page, /Record the UCC-3 filed for PENS-0001-BD-A00001-1: filed copy 0x/, "assignor's UCC-3");
  const filed = await until(async () => { const o = await onCanton("AssignmentOffer", CHILD); return o?.createArgument.ucc3Hash ? o : null; });
  ok(filed?.createArgument.ucc3Hash === "0x" + crypto.createHash("sha256").update("child ucc-3").digest("hex"), "and its UCC-3's filed copy");
}

// Company D, on its own device: transfer code, passkey, its own Canton keys, then rejects with a reason.
const three = await newBrowser();
const p3 = three.page;
await p3.goto(H + "/assignee?id=" + CHILD);
await p3.getByLabel("Transfer code").waitFor({ timeout: 15000 });
await p3.getByLabel("Transfer code").fill(TRANSFER);
await p3.getByRole("button", { name: "Continue" }).click();
await p3.getByRole("button", { name: "Set up device key" }).click();
await p3.getByRole("button", { name: "Make my keys" }).click({ timeout: 20000 });
await p3.getByTestId("recovery-code").waitFor({ timeout: 30000 });
const CODE_D = (await p3.getByTestId("recovery-code").innerText()).trim().split(/\s+/);
await p3.getByLabel(/type its last group/).fill(CODE_D[CODE_D.length - 1]);
await p3.getByRole("button", { name: "I've kept it: continue" }).click();
await p3.getByRole("heading", { name: "Review this assignment" }).waitFor({ timeout: 20000 });
const skip3 = p3.getByRole("button", { name: "Skip, I've done this before" });
if (await skip3.count()) await skip3.click();
const holderD = (await q("select party from canton_holders where record = $1", [CHILD]))[0];
ok(!!holderD && holderD.party !== holder.party, "Company D has its own party on Canton, with its own keys");
{
  const companyDSees = (await acsFor(holderD.party)).map((e) => e.createArgument.recordId);
  ok(companyDSees.length && companyDSees.every((id) => id === CHILD), "Company D sees only its own offer on Canton, not Company A's assignment (" + companyDSees.join(", ") + ")");
}
await recordReceipt(p3, "D", CHILD.replace(/-/g, "\\-"));
{
  const o = await until(async () => { const x = await onCanton("AssignmentOffer", CHILD); return x?.createArgument.receiptRef ? x : null; });
  ok(!!o, "Company D's delivery receipt is on Canton, signed with Company D's own key");
}
await p3.getByRole("button", { name: "Reject this assignment" }).click();
await p3.getByLabel(/Reason for rejecting/).fill("The amount on the instrument I received does not match what the register shows, and I did not agree to take this portion " +
  "from the assignor. I have not signed anything about it and would like the issuer to review how this assignment was created. Please return it.");
await p3.getByRole("button", { name: /^Reject: confirm with your passkey/ }).click();
await answerCanton(p3, /Reject assignment PENS-0001-BD-A00001-1; its \$10\.40 go back to PENS-0001-BD-A00001\. Reason: .The amount on the instrument/, "rejecting");
for (let i = 0; i < 30 && !(await onCanton("UnitsReturned", CHILD)); i++) await new Promise((r) => setTimeout(r, 1000));
ok(!!(await onCanton("UnitsReturned", CHILD)) && !(await onCanton("AssignmentOffer", CHILD)), "on Canton the offer is gone and its $10.40 waits to be taken back");

// Company A takes the units back, with its own key. First, a server that lies about the hash is caught.
await page.reload();
await page.getByRole("button", { name: "Sign in with your passkey" }).click({ timeout: 15000 });
await page.getByText(/one change waiting for your key's signature/).waitFor({ timeout: 20000 }).catch(() => {});
ok(await page.getByText(/one change waiting for your key's signature/).count() > 0, "Company A's page says a change is waiting for its key");
// Signing in, the page offers to sign what's waiting; answering "Not now" leaves it unsigned.
const askAppeared = page.getByTestId("canton-ask");
await askAppeared.waitFor({ timeout: 20000 }).catch(() => {});
ok(await askAppeared.count() > 0, "signing in, the page offers the waiting change for signature");
await page.getByRole("button", { name: "Not now" }).click();
await page.getByText(/Not signed on Canton yet/).waitFor({ timeout: 10000 }).catch(() => {});
ok(!!(await onCanton("UnitsReturned", CHILD)), "\u201cNot now\u201d signs nothing: the units still wait on Canton");
await page.route("**/api/holder/canton/act/prepare", async (route) => {
  const res = await route.fetch(); const j = await res.json();
  j.hash = Buffer.from(crypto.randomBytes(32)).toString("base64"); // a different transaction's hash
  await route.fulfill({ response: res, json: j });
});
await page.getByRole("button", { name: "Review and sign" }).click();
await page.getByText(/isn't this transaction's/).waitFor({ timeout: 15000 }).catch(() => {});
ok(await page.getByText(/isn't this transaction's/).count() > 0 && !(await askAppeared.count()), "a hash that isn't the transaction's is caught in the page: nothing is shown or signed");
await page.unroute("**/api/holder/canton/act/prepare");
await page.getByRole("button", { name: "Review and sign" }).click();
await answerCanton(page, /Take back the units of a rejected assign-out into PENS-0001-BD-A00001, which then holds \$10,000\.00/, "taking back");
for (let i = 0; i < 30 && (await onCanton("Assignment", A1))?.createArgument.units !== "1000000"; i++) await new Promise((r) => setTimeout(r, 1000));
ok((await onCanton("Assignment", A1))?.createArgument.units === "1000000" && !(await onCanton("UnitsReturned", CHILD)),
  "on Canton, A00001 holds $10,000.00 again, as in the register");
// An AssignOut on Canton, signed by whichever key we're testing: the way to see who can still act.
const sync = (await canton("GET", "/v2/state/connected-synchronizers")).body.connectedSynchronizers[0].synchronizerId;
async function tryActWith(pageWithKey, n) {
  const asg = (await acsFor(holder.party)).find((e) => e.templateId.endsWith(":Registry:Assignment"));
  const p = (await canton("POST", "/v2/interactive-submission/prepare", { userId: "participant_admin", commandId: crypto.randomUUID(), actAs: [holder.party], readAs: [],
    synchronizerId: sync, verboseHashing: false, packageIdSelectionPreference: [],
    commands: [{ ExerciseCommand: { templateId: "#bond-registry:Registry:Assignment", contractId: asg.contractId, choice: "AssignOut",
      choiceArgument: { childId: A1 + "-" + n, childUnits: "1", childHash: H32(), childName: "Test", childParty: null } } }] })).body;
  // The browser's own stored key signs, inside the page (it can't be read out).
  const k = await pageWithKey.evaluate(async (hashB64) => {
    const key = await new Promise((res) => { const r = indexedDB.open("bond-registry-keys"); r.onsuccess = () => { const t = r.result.transaction("keys").objectStore("keys").getAll(); t.onsuccess = () => res(t.result[0]); }; });
    const data = Uint8Array.from(atob(hashB64), (c) => c.charCodeAt(0));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, data));
    return { sig: btoa(String.fromCharCode(...sig)), fp: key.fp };
  }, p.preparedTransactionHash);
  const rs = Buffer.from(k.sig, "base64");
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const r = int(rs.subarray(0, 32)), s = int(rs.subarray(32));
  const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, s.length]), s]);
  const der = Buffer.concat([Buffer.from([0x30, body.length]), body]);
  return canton("POST", "/v2/interactive-submission/executeAndWait", { preparedTransaction: p.preparedTransaction, hashingSchemeVersion: p.hashingSchemeVersion,
    userId: "participant_admin", submissionId: crypto.randomUUID(), deduplicationPeriod: { Empty: {} },
    partySignatures: { signatures: [{ party: holder.party, signatures: [{ format: "SIGNATURE_FORMAT_DER", signature: b64(der), signedBy: k.fp,
      signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256" }] }] } });
}

// ---- 4. a second browser: the passkey is synced to it (as iCloud or Google would), the Canton key isn't
const two = await newBrowser();
{
  const creds = (await one.cdp.send("WebAuthn.getCredentials", { authenticatorId: one.authenticatorId })).credentials;
  for (const c of creds) await two.cdp.send("WebAuthn.addCredential", { authenticatorId: two.authenticatorId, credential: c });
}
const page2 = two.page;
await page2.goto(H + "/assignee?id=" + A1);
await page2.getByRole("button", { name: "Sign in with your passkey" }).click({ timeout: 15000 });
await page2.getByTestId("canton-keys").waitFor({ timeout: 20000 });
await page2.getByText(/This browser has no key for this assignment/).waitFor({ timeout: 10000 }).catch(() => {});
ok(await page2.getByText(/This browser has no key for this assignment/).count() > 0, "on a second browser, the page says it has no Canton key here");
await page2.getByRole("button", { name: "Add this browser" }).click();
await page2.getByLabel("Recovery code").fill(RECOVERY.slice(0, -1) + (RECOVERY.endsWith("0") ? "1" : "0"));
await page2.getByRole("button", { name: "Add this browser" }).last().click();
await page2.getByText(/doesn't check out|character/).first().waitFor({ timeout: 5000 }).catch(() => {});
ok(await page2.getByText(/doesn't check out/).count() > 0, "a mistyped recovery code is caught before anything is signed");
await page2.getByLabel("Recovery code").fill(RECOVERY.toLowerCase().replace(/-/g, " "));
await page2.getByRole("button", { name: "Add this browser" }).last().click();
await page2.getByText(/This browser can now act on/).waitFor({ timeout: 40000 }).catch(() => {});
let keys = (await q("select keys from canton_holders where record = $1", [A1]))[0].keys;
ok(keys.filter((k) => k.role === "device").length === 2, "with the recovery code, the second browser adds its own key; the first keeps its own (" + keys.length + " keys)");
await shot(page2, "c4-added");
let r = await tryActWith(page, 5);
ok(r.ok, "the first browser's key still acts on Canton (" + r.status + ")");
r = await tryActWith(page2, 6);
ok(r.ok, "and so does the second's (" + r.status + ")");

// The first browser is lost: from the second, replace it.
await page2.getByRole("button", { name: "Lost a device? Replace it" }).click();
await page2.getByLabel("Recovery code").fill(RECOVERY);
await page2.getByRole("button", { name: "Replace my lost device" }).click();
await page2.getByText(/lost device's key no longer works/).waitFor({ timeout: 40000 }).catch(() => {});
keys = (await q("select keys from canton_holders where record = $1", [A1]))[0].keys;
ok(keys.length === 2 && keys.filter((k) => k.role === "device").length === 1, "replacing the lost device leaves the recovery key and one new device key");
r = await tryActWith(page, 7);
ok(!r.ok, "the lost browser's key no longer works on Canton, whoever has it now (" + r.status + ")");
r = await tryActWith(page2, 8);
ok(r.ok, "the second browser's new key does (" + r.status + ")");
await shot(page2, "c5-replaced");

// An offer mailed 31 days ago and never answered: the register and Canton record only that.
{
  const A2 = "PENS-0001-BD-A00002";
  await call(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id: A2, passkey: "EEEE-FFFF-GGGG-HHHH" });
  const b = (await st()).bonds[0];
  await icommit({ bonds: [{ ...b, unassigned: b.unassigned - 2000 }], reg: [{ origin: "Issuer", parent: null, assignor: "Penson Trust", party: "Company E",
    contact: "E", position: "", address: "addr", status: "Issued", created: "Oct 1, 2026", accepted: null, filingRef: null, deliveryRef: null,
    instrumentMail: null, passkeyMail: null, id: A2, bond: "PENS-0001-BD", units: 2000, issuedUnits: 2000, docHash: H32() }] });
  const sent = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
  await icommit({ reg: [{ ...(await st()).reg.find((a) => a.id === A2), instrumentMail: "9407 0002", passkeyMail: "9407 0002", mailedOn: sent, mailingDoc: H32() }] });
  const noted = await until(async () => { const o = await onCanton("AssignmentOffer", A2); return o?.createArgument.noResponseAsOf ? o : null; }, 40000);
  const r2 = (await st()).reg.find((a) => a.id === A2);
  ok(r2.noResponseAsOf && r2.status === "Issued", "31 days after its mailing, the register records only that " + A2 + " was offered and not answered");
  ok(!!noted && !(await onCanton("Assignment", A2)), "Canton notes the same on the offer, and it stays an offer: nothing is accepted for anyone");
}

// The register is untouched by all of this, and still in control.
{
  const rec = (await call(H, "GET", "/api/state")).reg.find((a) => a.id === A1);
  ok(rec.status === "Accepted" && rec.units === 1_000_000, "the register still shows " + A1 + " in effect at $10,000.00");
}

await browser.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
for (const c of procs) c.kill();
process.exit(fails ? 1 : 0);
