// End-to-end: assignments made before the Canton mirror was switched on are brought across.
//
//   1. With Canton off: the issuer records a prior instrument, issues A00001, A00002 and A00003, and
//      mails A00001. Company A sets up its passkey, accepts, and assigns $10.40 out (A00001-1).
//   2. The servers restart with Canton on. The issuer service brings the bond across: the bond, its
//      prior instrument, an offer for each live record it made (A00001 holding what it held before
//      its assign-out), and the issuer's mailing. A00003, whose paper's fingerprint isn't on the
//      register, is left off and reported.
//   3. Company A signs in with its passkey, makes its Canton keys, and is asked to sign what it did
//      before: accepting, then the assign-out. Canton then matches the register.
//
// Needs Postgres on 127.0.0.1:54329, the apps built, and a Canton sandbox with the registry's DAR
// (see canton/README.md). Run from the repo root: node e2e/canton-backfill-e2e.mjs
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
const DB = "postgres://postgres@127.0.0.1:54329/cbf";
const CANTON = process.env.CANTON_JSON_URL || "http://localhost:7575";
const JAR = process.env.CANTON_JAR || path.join(os.homedir(), ".daml/sdk/3.4.0-rc2/canton/canton.jar");
const I = "http://localhost:5212", P = "http://localhost:5213", H = "http://localhost:5214";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const H32 = () => "0x" + crypto.randomBytes(32).toString("hex");

const PROTOS = fs.mkdtempSync(path.join(os.tmpdir(), "canton-protos-"));
execSync(`unzip -q -o "${JAR}" '*.proto' -d "${PROTOS}"`);
execSync(`psql -h 127.0.0.1 -p 54329 -U postgres -q -c "drop database if exists cbf" -c "create database cbf"`, { stdio: "ignore" });
let procs = [];
process.on("exit", () => { procs.forEach((c) => c.kill()); fs.rmSync(PROTOS, { recursive: true, force: true }); });
const logs = [];
const start = (app, port, withCanton) => new Promise((res, rej) => {
  const env = { ...process.env, APP: app, PORT: String(port), DATABASE_URL: DB, SEED_SAMPLE: "0", ADMIN_SETUP_CODE: "setup-123", PASSKEY_PEPPER: "x", RESPONSE_CHECK_MS: "60000" };
  delete env.CANTON_JSON_URL;
  if (withCanton) Object.assign(env, { CANTON_JSON_URL: CANTON, CANTON_ADMIN: "localhost:6866", CANTON_PROTOS: PROTOS });
  const c = spawn("node", ["server/index.js"], { cwd: ROOT, env });
  procs.push(c); let out = "";
  c.stdout.on("data", (d) => { out += d; logs.push("[" + app + "] " + d); process.env.VERBOSE && process.stdout.write("[" + app + "] " + d); if (out.includes("listening")) res(c); });
  c.stderr.on("data", (d) => process.stdout.write("[" + app + " err] " + d));
  setTimeout(() => rej(new Error(app + " didn't start")), 20000);
});
const startAll = async (withCanton) => { await start("platform", 5213, withCanton); await start("issuer", 5212, withCanton); await start("holder", 5214, withCanton); };
const stopAll = async () => {
  await Promise.all(procs.map((c) => new Promise((r) => { c.once("exit", r); c.kill(); })));
  procs = [];
};
await startAll(false);

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
const until = async (f, ms = 30000) => { for (let t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 1000))) { const v = await f(); if (v) return v; } return null; };

// ---- 1. the register, with Canton off
await call(P, "POST", "/api/auth/setup", { setupCode: "setup-123", name: "Owner", email: "o@x.test", password: "owner-pass-123" });
await call(I, "POST", "/api/auth/login", { email: "o@x.test", password: "owner-pass-123" });
const iss = await call(I, "POST", "/api/issuers", { legalName: "Penson Trust", issuerCode: "PENS" });
const issuerId = iss.issuer?.id || (await call(I, "GET", "/api/auth/me")).issuers[0].id;
const st = () => call(I, "GET", "/api/state?issuer=" + issuerId);
const icommit = async (body) => call(I, "POST", "/api/commit", { issuer: issuerId, base: (await st()).version, bonds: [], reg: [], events: [], ...body });
const TOTAL = 10_000_000_000, BOND = "PENS-0001-BD", A1 = BOND + "-A00001", A2 = BOND + "-A00002", A3 = BOND + "-A00003", CHILD = A1 + "-1";
const CODE = "7KQM-R4XW-9TPH-C2NV";
await icommit({ bonds: [{ id: BOND, title: "Series A", face: TOTAL, total: TOTAL, unassigned: TOTAL - 7000, redeemed: 0,
  prior: [{ id: "P001", ref: "PN-2024-007", holder: "Old Note Holder LLC", mail: "9407 7777", units: 7000, recordedOn: "Nov 1, 2026", reversed: false }],
  registered: "Nov 8, 2026", instrumentHash: H32(), ucc1: { number: "DE-1", office: "Delaware", date: "Nov 7, 2026", hash: H32(), file: "u.pdf" } }] });
const rec = (id, party, units) => ({ origin: "Issuer", parent: null, assignor: "Penson Trust", party, contact: "D", position: "", address: "addr", status: "Issued",
  created: "Nov 9, 2026", accepted: null, filingRef: null, deliveryRef: null, instrumentMail: null, passkeyMail: null, id, bond: BOND, units, issuedUnits: units, docHash: H32() });
await call(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id: A1, passkey: CODE });
await call(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id: A2, passkey: "JJJJ-KKKK-LLLL-MMMM" });
await call(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id: A3, passkey: "NNNN-PPPP-QQQQ-RRRR" });
await icommit({ bonds: [{ ...(await st()).bonds[0], unassigned: TOTAL - 7000 - 1_000_000 - 4200 - 3300 }],
  reg: [rec(A1, "Company A", 1_000_000), rec(A2, "Company B", 4200), rec(A3, "Company C", 3300)] });
{
  const r = (await st()).reg.find((a) => a.id === A1);
  await icommit({ reg: [{ ...r, instrumentMail: "9407 1000 0000 0000 0000 01", passkeyMail: "9407 1000 0000 0000 0000 01",
    mailedOn: new Date().toISOString().slice(0, 10), mailingDoc: H32() }] });
}
// A record from before the register kept each paper's fingerprint.
await q(`update assignments set data = data - 'docHash' where id = $1`, [A3]);
ok((await q("select to_regclass('canton_refs') as t"))[0].t === null || !(await q("select 1 from canton_refs")).length, "with Canton off, nothing is mirrored");

// Company A: passkey, accepts, assigns $10.40 out. No Canton keys are asked for.
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[page error] " + e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await page.goto(H + "/assignee?id=" + A1);
await page.getByLabel("Transfer code").fill(CODE, { timeout: 15000 });
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("button", { name: "Set up device key" }).click();
await page.getByRole("heading", { name: "Review this assignment" }).waitFor({ timeout: 20000 });
ok(!(await page.getByRole("heading", { name: "Set up your keys" }).count()), "with Canton off, the assignee goes straight to the offer");
const skip = page.getByRole("button", { name: "Skip, I've done this before" });
if (await skip.count()) await skip.click();
await page.getByRole("button", { name: /^Accept: confirm with your passkey/ }).click();
await page.getByRole("button", { name: "Assign out" }).waitFor({ timeout: 20000 });
ok(await until(async () => (await call(H, "GET", "/api/state")).reg.find((a) => a.id === A1)?.status === "Accepted"), "Company A accepted in the register");
ok(!(await page.getByText(/Request a new access code|Rotate passkey|Reset passkey/i).count()), "there's no passkey rotation or reset on the assignee's page");
await page.getByRole("button", { name: "Assign out" }).click();
await page.getByLabel("Amount to assign").fill("10.40");
await page.getByLabel("Legal name").fill("Company D, LLC");
await page.getByLabel("Attention of").fill("M. Doe");
await page.getByLabel("Mailing address").fill("Company D, LLC\n1 Main St\nDover, DE 19901");
await page.locator('input[type="file"]').first().setInputFiles({ name: "assignment-to-company-d.pdf", mimeType: "application/pdf", buffer: Buffer.from("signed assignment to D") });
await page.getByRole("button", { name: "Create the assignment" }).click();
const childDoc = "0x" + crypto.createHash("sha256").update("signed assignment to D").digest("hex");
const child = await until(async () => (await call(H, "GET", "/api/state")).reg.find((a) => a.id === CHILD));
ok(child?.units === 1040 && child.docHash === childDoc, "and assigned $10.40 out as " + CHILD + ", in the register only");

// ---- 2. Canton switched on
await stopAll();
await startAll(true);
const brought = await until(async () => logs.find((l) => l.includes("Canton: brought across")), 60000);
ok(!!brought && logs.some((l) => l.includes("left off " + BOND) && l.includes(A3)), "on start, the issuer service brings the bond across and reports what it left off (" + A3 + ")");
const issuerParty = (await q("select party from canton_parties where name like 'issuer-PENS%'"))[0]?.party;
const acsFor = async (party) => {
  const end = (await canton("GET", "/v2/state/ledger-end")).body.offset;
  const r = await canton("POST", "/v2/state/active-contracts", { activeAtOffset: end, eventFormat: { verbose: false,
    filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } } });
  return (Array.isArray(r.body) ? r.body : []).map((x) => x.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean);
};
const on = async (template, key, v) => (await acsFor(issuerParty)).find((e) => e.templateId.endsWith(":Registry:" + template) && e.createArgument[key] === v);
{
  const regBond = (await st()).bonds[0], b = await on("Bond", "bondId", BOND);
  ok(b && Number(b.createArgument.unassigned) === regBond.unassigned && b.createArgument.prior === "7000" && Number(b.createArgument.total) === TOTAL,
    "Canton's bond matches the register: $" + (regBond.unassigned / 100).toLocaleString() + " left to assign, $70.00 held as prior");
  const p = await on("PriorInstrument", "entryId", "P001");
  ok(p?.createArgument.units === "7000" && !JSON.stringify(p).includes("Old Note Holder"), "the prior instrument is there as a fingerprint, its holder not");
  const o1 = await on("AssignmentOffer", "recordId", A1), o2 = await on("AssignmentOffer", "recordId", A2);
  const r1 = (await st()).reg.find((a) => a.id === A1);
  ok(o1?.createArgument.units === "1000000" && o1.createArgument.instrumentHash === r1.docHash,
    A1 + " is an offer for what it held before its assign-out ($10,000.00), with its paper's fingerprint");
  ok(o1?.createArgument.deliveryRef === r1.deliveryRef && !!o1.createArgument.mailedOn, "with the issuer's mailing already on it");
  ok(o2?.createArgument.units === "4200", A2 + " is an offer too");
  ok(!(await on("AssignmentOffer", "recordId", A3)) && !(await on("AssignmentOffer", "recordId", CHILD)),
    A3 + " (no paper fingerprint) is left off; " + CHILD + " waits for Company A's own key");
}
{
  // Restarting again changes nothing.
  const before = (await q("select ref, cid from canton_refs order by ref")).map((r) => r.ref + r.cid).join();
  await stopAll(); logs.length = 0; await startAll(true);
  await new Promise((r) => setTimeout(r, 4000));
  const after = (await q("select ref, cid from canton_refs order by ref")).map((r) => r.ref + r.cid).join();
  ok(before === after && !logs.some((l) => l.includes("brought across")), "starting again brings nothing across twice");
}

// ---- 3. Company A signs what it did before, with its own new keys
await page.goto(H + "/assignee?id=" + A1);
await page.getByRole("button", { name: "Sign in with your passkey" }).click({ timeout: 15000 });
await page.getByRole("heading", { name: "Set up your keys" }).waitFor({ timeout: 20000 });
ok(true, "signing in, Company A is asked to set up its Canton keys");
await page.getByRole("button", { name: "Make my keys" }).click();
await page.getByTestId("recovery-code").waitFor({ timeout: 30000 });
const RECOVERY = (await page.getByTestId("recovery-code").innerText()).trim().split(/\s+/);
await page.getByLabel(/type its last group/).fill(RECOVERY[RECOVERY.length - 1]);
await page.getByRole("button", { name: "I've kept it: continue" }).click();
async function answer(expect, name) {
  const dlg = page.getByTestId("canton-ask");
  await dlg.waitFor({ timeout: 40000 }).catch(() => {});
  const said = (await dlg.innerText().catch(() => "")).replace(/\s+/g, " ");
  ok(expect.test(said), name + ": shown before signing (" + said.slice(0, 140) + ")");
  await page.getByRole("button", { name: "Sign with this browser's key" }).click();
  await dlg.waitFor({ state: "detached", timeout: 40000 }).catch(() => {});
}
await answer(/Accept assignment PENS-0001-BD-A00001 of \$10,000\.00/, "accepting, made before Canton");
await answer(/Assign \$10\.40 of PENS-0001-BD-A00001 to Company D, LLC, as PENS-0001-BD-A00001-1\..*You keep \$9,989\.60/, "the assign-out, made before Canton");
const holder = (await q("select party from canton_holders where record = $1", [A1]))[0];
const rest = await until(async () => { const a = (await acsFor(holder.party)).find((e) => e.templateId.endsWith(":Registry:Assignment")); return a?.createArgument.units === "998960" ? a : null; });
const offerD = await on("AssignmentOffer", "recordId", CHILD);
ok(!!rest && rest.signatories.includes(holder.party) && rest.createArgument.carveOuts.includes(childDoc),
  "on Canton, A00001 is now Company A's assignment of $9,989.60, signed with its key, the assign-out's paper listed");
ok(offerD?.createArgument.units === "1040" && offerD.createArgument.instrumentHash === childDoc, "and " + CHILD + " is an offer of $10.40 with its own paper, as in the register");
await page.getByText(/On Canton: in effect, signed with your own key/).waitFor({ timeout: 20000 }).catch(() => {});
ok((await page.getByText(/On Canton: in effect, signed with your own key/).count()) > 0 && !(await page.getByText(/waiting for your key's signature/).count()),
  "Company A's page shows it in effect on Canton, with nothing left waiting for its key");

// ---- 4. The issuer proposes replacing A00001; Company A consents with its own key, and Canton follows.
{
  const rp = { newId: BOND + "-A00004", party: "Company A Holdings", contact: "Treasurer", address: "1 Main St", docHash: H32(), reasonDoc: H32(), proposedOn: "Nov 21, 2026", assignor: "Penson Trust (replacement)" };
  await call(I, "POST", "/api/issuer/passkey", { issuer: issuerId, id: rp.newId, passkey: "WWWW-XXXX-YYYY-ZZZZ" });
  await icommit({ reg: [{ ...(await st()).reg.find((a) => a.id === A1), replacement: rp }] });
  const prop = await until(async () => (await acsFor(issuerParty)).find((e) => e.templateId.endsWith(":Registry:ReplacementProposal") && e.createArgument.recordId === A1));
  ok(!!prop, "the issuer's proposal to replace A00001 is on Canton");
  await page.reload();
  await page.getByRole("button", { name: "Sign in with your passkey" }).click({ timeout: 15000 });
  await page.getByTestId("replacement").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Agree to the replacement: confirm with your passkey" }).click();
  await answer(/Agree to the issuer replacing PENS-0001-BD-A00001: it ends, and PENS-0001-BD-A00004 is offered to Company A Holdings for the same \$9,989\.60\./, "consenting to the replacement");
  const nu = await until(async () => await on("AssignmentOffer", "recordId", rp.newId));
  const regNow = (await st()).reg;
  ok(nu?.createArgument.units === "998960" && nu.createArgument.instrumentHash === rp.docHash && !(await on("Assignment", "recordId", A1)),
    "consented with Company A's key: A00001 is gone from Canton and " + rp.newId + " is offered for the same $9,989.60, with the proposed paper");
  ok(regNow.find((a) => a.id === A1).status === "Superseded" && regNow.find((a) => a.id === rp.newId)?.status === "Issued", "as in the register");
  ok(!!(await acsFor(issuerParty)).find((e) => e.templateId.endsWith(":Registry:Superseded") && e.createArgument.recordId === A1 && e.createArgument.reasonHash === rp.reasonDoc),
    "and Canton keeps what replaced it, with the memo's fingerprint");
}

await browser.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
process.exit(fails ? 1 : 0);
