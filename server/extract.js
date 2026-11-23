// A certified extract of one assignment: everything the register holds about it, for printing.
//
// Built only from the register's own tables (never from what a browser sends): the entry, its
// chain of title back to the bond, the documents' SHA-256 fingerprints, every event with the
// database's own timestamp, each act the assignee signed with what anyone needs to check that
// signature again, and the contract as Canton holds it. Each extract is kept under its own number
// with a SHA-256 of its contents, so the register can later confirm a printed copy is one it made.
import crypto from "node:crypto";
import * as holderKeys from "./holder-keys.js";
import { LENDER } from "./records.js";

export const SCHEMA = `
  create table if not exists extracts (
    id text primary key, record text not null, digest text not null,
    made_at timestamptz not null default now(), made_by text not null, content jsonb not null);
  create index if not exists extracts_record on extracts (record, made_at);
`;

const sha256hex = (s) => "0x" + crypto.createHash("sha256").update(s).digest("hex");
// The same contents always hash the same: keys sorted at every level.
const canonical = (v) => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}"
  : JSON.stringify(v ?? null);
/** The SHA-256 that identifies an extract's contents (everything in it but the digest itself). */
export const digestOf = (ex) => { const { digest, ...rest } = ex; return sha256hex(canonical(rest)); };
const B32 = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const newId = () => "EX-" + [...crypto.randomBytes(10)].map((b) => B32[b % B32.length]).join("").replace(/(.{5})(?=.)/g, "$1-");

// What never goes on paper: one-time codes, and fields left by retired features.
const NEVER = ["accessCode", "passkey", "tx", "chain", "holder", "lender", "requestedContact"];

/** Re-checks one kept signature: the challenge is the act's, and the key made the signature. */
function recheck(sig, key) {
  const out = { challengeMatches: false, signatureValid: false, origin: null };
  try { out.challengeMatches = holderKeys.challengeFor({ signerId: sig.signer, nonce: sig.nonce, fn: sig.fn, args: sig.args }) === sig.challenge; } catch { /* not a holder act */ }
  try {
    const cd = JSON.parse(Buffer.from(sig.assertion.clientDataJSON, "base64url").toString("utf8"));
    out.origin = cd.origin;
    if (key?.x) {
      holderKeys.checkAssertion({ assertion: sig.assertion, challenge: sig.challenge, x: key.x, y: key.y,
        rpId: new URL(cd.origin).hostname, origins: [cd.origin] });
      out.signatureValid = true;
    }
  } catch { /* stays false */ }
  return out;
}

/** Everything about record `id`, as of now. */
export async function build(pool, id, { canton } = {}) {
  const row = (await pool.query(
    `select a.data, a.created_at, b.data as bond, b.review, i.legal_name, i.code
       from assignments a join bonds b on b.id = a.bond left join issuers i on i.id = b.issuer_id where a.id = $1`, [id])).rows[0];
  if (!row) return null;
  const rec = row.data, bond = row.bond;

  // The chain of title: this record, then the one it came from, back to the bond.
  const chain = [];
  for (let cur = rec, n = 0; cur && n < 50; n++) {
    chain.push({ id: cur.id, origin: cur.origin, party: cur.party, assignor: cur.assignor, units: Number(cur.issuedUnits ?? cur.units),
      unitsNow: Number(cur.units), status: cur.status, created: cur.created || null, accepted: cur.accepted || null,
      instrumentHash: cur.docHash || null, filingNumber: cur.filingNumber || null });
    cur = cur.parent ? (await pool.query("select data from assignments where id = $1", [cur.parent])).rows[0]?.data : null;
  }

  const events = (await pool.query(
    "select seq, data, created_at from events where assignment = $1 order by seq", [id])).rows
    .map((e) => ({ seq: Number(e.seq), recordedAt: e.created_at.toISOString(), event: e.data.ev, by: e.data.actor, ref: e.data.ref ?? null, stamp: e.data.t ?? null }));

  // Signatures on this record (by its assignee, a lender, or the assignor of an assign-out), and every
  // act this record's own key signed elsewhere (its assign-outs).
  const sigRows = (await pool.query(
    `select seq, assignment, signer, fn, args, nonce, challenge, assertion, created_at from holder_signatures
      where assignment = $1 or signer = $1 or signer = $2 order by seq`, [id, id + LENDER])).rows;
  const keys = new Map();
  const keyOf = async (signer) => {
    if (!keys.has(signer)) {
      const lender = signer.endsWith(LENDER), base = lender ? signer.slice(0, -LENDER.length) : signer;
      const d = (await pool.query("select data from assignments where id = $1", [base])).rows[0]?.data;
      keys.set(signer, (lender ? d?.lender : d?.holder) || null);
    }
    return keys.get(signer);
  };
  const signatures = [];
  for (const s of sigRows) {
    const key = await keyOf(s.signer);
    signatures.push({ seq: Number(s.seq), onRecord: s.assignment, signedAt: s.created_at.toISOString(), signer: s.signer, act: s.fn, details: s.args, counter: s.nonce,
      challenge: s.challenge, publicKey: key ? { curve: "P-256", x: key.x, y: key.y, fingerprint: holderKeys.fingerprint(key.x) } : null,
      response: s.assertion, check: recheck(s, key) });
  }

  let onCanton = null;
  if (canton?.enabled) {
    try { onCanton = await canton.recordOnCanton(pool, rec); } catch (e) { onCanton = { error: "Canton couldn't be read when this extract was made: " + e.message }; }
  }

  const entry = Object.fromEntries(Object.entries(rec).filter(([k]) => !NEVER.includes(k)));
  if (rec.holder?.x) entry.deviceKey = { fingerprint: holderKeys.fingerprint(rec.holder.x), since: rec.holder.since || null };
  if (rec.lender?.x) entry.lenderKey = { fingerprint: holderKeys.fingerprint(rec.lender.x), claimedOn: rec.lender.claimedOn || null, releasedOn: rec.lender.releasedOn || null };

  return {
    format: "BondInterestRegistry/extract/v1",
    issuer: { legalName: row.legal_name || null, code: row.code || null },
    bond: { id: bond.id, title: bond.title || null, total: Number(bond.total), registered: bond.registered || null, assignor: bond.assignor || null,
      instrumentHash: bond.instrumentHash || null, ucc1: bond.ucc1 ? { number: bond.ucc1.number, office: bond.ucc1.office, date: bond.ucc1.date, hash: bond.ucc1.hash } : null,
      review: row.review },
    record: entry, enteredAt: row.created_at.toISOString(), chain, events, signatures, canton: onCanton,
  };
}

/** Makes, keeps and returns a numbered extract of record `id`. */
export async function make(pool, id, { madeBy, canton }) {
  const content = await build(pool, id, { canton });
  if (!content) return null;
  const ex = { id: newId(), madeAt: new Date().toISOString(), madeBy, ...content };
  const digest = digestOf(ex);
  await pool.query("insert into extracts (id, record, digest, made_at, made_by, content) values ($1, $2, $3, $4, $5, $6)",
    [ex.id, id, digest, ex.madeAt, madeBy, JSON.stringify(ex)]);
  return { ...ex, digest };
}

/** What the register confirms about an extract number: never the contents. */
export async function confirm(pool, extractId) {
  const r = (await pool.query("select id, record, digest, made_at, made_by from extracts where id = $1", [String(extractId || "").trim().toUpperCase()])).rows[0];
  return r ? { id: r.id, record: r.record, digest: r.digest, madeAt: r.made_at.toISOString(), madeBy: r.made_by } : null;
}

/* ------------------------------------------------------------------ the printed page */

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (n) => "$" + (Number(n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const utc = (iso) => (iso ? new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "");
const words = (s) => String(s || "").replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ (\w)/g, (m) => m.toLowerCase()).replace(/ ucc/g, " UCC");
const ACT = { accept: "Accepted the assignment", rejectAssignment: "Rejected the assignment", lock: "Locked the record", unlock: "Lifted the lock",
  cancelAssignOut: "Cancelled an assign-out", assignOut: "Assigned out", registerHolderKey: "Registered the assignee's device key",
  recordFiling: "Recorded a UCC-3", recordMailing: "Recorded the certified mailing", recordReceipt: "Recorded the delivery receipt",
  consentReplacement: "Consented to a replacement", declineReplacement: "Declined a replacement", claimPledge: "Lender claimed the pledge",
  releasePledge: "Lender released the pledge" };
const ORIGIN = { Issuer: "Issued by the issuer", AssignOut: "Assigned out from an earlier record", Replacement: "Replacement of an earlier record" };
const cssStr = (v) => '"' + String(v).replace(/[\\"]/g, "\\$&").replace(/[\n\r]/g, " ") + '"';
const ROLE = { RELAYER: "Register (automatic)", ISSUER: "Issuer", HOLDER: "Assignee", LENDER: "Lender", PLATFORM: "Platform", ASSIGNOR: "Assignor", SYSTEM: "Register" };

const rows = (pairs) => '<table class="kv">' + pairs.filter(Boolean).filter(([, v]) => v !== null && v !== undefined && v !== "")
  .map(([k, v, mono]) => `<tr><th>${esc(k)}</th><td${mono ? ' class="mono"' : ""}>${esc(v)}</td></tr>`).join("") + "</table>";

/** The extract as a self-contained page, laid out for US Letter. */
export function render(ex, { verifyAt } = {}) {
  const r = ex.record, c = ex.canton && !ex.canton.error ? ex.canton : null;
  const sigOk = ex.signatures.filter((s) => s.check.challengeMatches && s.check.signatureValid).length;
  const entryPairs = [
    ["Record", r.id, true], ["Bond", r.bond, true], ["Status", r.status], ["Amount held", usd(r.units)],
    r.issuedUnits !== undefined && Number(r.issuedUnits) !== Number(r.units) && ["Amount when issued", usd(r.issuedUnits)],
    ["How it began", ORIGIN[r.origin] || r.origin], r.parent && ["From record", r.parent, true],
    ["Assignor", r.assignor], ["Assignee", r.party], r.contact && ["Attention of", r.contact + (r.position ? ", " + r.position : "")],
    r.address && ["Mailing address", r.address], ["Issued", r.created], r.accepted && ["Accepted", r.accepted],
    r.effectiveOn && ["Effective", r.effectiveOn], ["Entered in the register", utc(ex.enteredAt)],
    r.lockKind && ["Lock", words(r.lockKind) + (r.lockedOn ? " since " + r.lockedOn : "") + (r.lockReason ? " — " + r.lockReason : "")],
    r.pledgeTo && ["Pledged to", r.pledgeTo + (r.pledgeContact ? " (" + r.pledgeContact + ")" : "")],
    r.rejectionReason && ["Rejection reason", r.rejectionReason + (r.rejectedOn ? " (" + r.rejectedOn + ")" : "")],
    r.cancelReason && ["Cancellation", r.cancelReason + (r.cancelledBy ? " — by the " + r.cancelledBy : "")],
    r.noResponseAsOf && ["No response", "Offered; no authenticated response within the response period (recorded " + r.noResponseAsOf + ")"],
    r.deviceKey && ["Assignee's device key", r.deviceKey.fingerprint + (r.deviceKey.since ? ", registered " + r.deviceKey.since : ""), true],
    r.lenderKey && ["Lender's device key", r.lenderKey.fingerprint + (r.lenderKey.claimedOn ? ", claimed " + r.lenderKey.claimedOn : "") + (r.lenderKey.releasedOn ? ", released " + r.lenderKey.releasedOn : ""), true],
  ];
  const docPairs = [
    ["Signed assignment instrument (SHA-256)", r.docHash, true], r.docFile && ["Instrument file name", r.docFile],
    ["Bond instrument (SHA-256)", ex.bond.instrumentHash, true],
    ex.bond.ucc1 && ["UCC-1 (bond)", [ex.bond.ucc1.number, ex.bond.ucc1.office, ex.bond.ucc1.date].filter(Boolean).join(" · ")],
    ex.bond.ucc1?.hash && ["UCC-1 filed copy (SHA-256)", ex.bond.ucc1.hash, true],
    ["UCC-3", r.filingNumber ? r.filingNumber + (r.filedOn ? ", filed " + r.filedOn : "") + (r.filedBy ? " by " + r.filedBy : "") : "Not recorded"],
    r.filingDoc && ["UCC-3 filed copy (SHA-256)", r.filingDoc, true],
    ["Certified mailing", r.instrumentMail ? "Tracking " + r.instrumentMail + (r.mailedOn ? ", sent " + r.mailedOn : "") : r.deliveryRef ? "Recorded" : "Not recorded"],
    r.passkeyMail && r.passkeyMail !== r.instrumentMail && ["Access code mailing", "Tracking " + r.passkeyMail],
    r.mailingDoc && ["Mailing receipt (SHA-256)", r.mailingDoc, true],
    ["Delivery receipt", r.receiptMail ? "Tracking " + r.receiptMail + (r.receivedOn ? ", received " + r.receivedOn : "") + (r.receiptMatches === true ? " — matches the recorded mailing" : r.receiptMatches === false ? " — differs from the recorded mailing" : "") : "Not recorded"],
    r.receiptDoc && ["Delivery receipt copy (SHA-256)", r.receiptDoc, true],
  ];

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ex.id)} · Register extract · ${esc(r.id)}</title>
<style>
@page { size: letter; margin: 0.75in 0.75in 0.9in;
  @bottom-center { content: ${cssStr("Extract " + ex.id + " · record " + r.id + " · page ")} counter(page) " of " counter(pages); font: 8pt Georgia, serif; color: #444; }
  @bottom-left { content: ""; } }
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #111; font: 10.5pt/1.45 Georgia, "Times New Roman", serif; }
main { max-width: 7in; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 18pt; margin: 0 0 4px; font-weight: normal; }
h2 { font-size: 12pt; margin: 22px 0 8px; padding-bottom: 3px; border-bottom: 1px solid #111; break-after: avoid; }
p { margin: 6px 0; }
.sub { color: #333; }
.mono, code { font-family: "Courier New", monospace; font-size: 8.5pt; word-break: break-all; }
table { width: 100%; border-collapse: collapse; margin: 4px 0; }
table.kv th { width: 36%; text-align: left; vertical-align: top; font-weight: normal; color: #333; padding: 3px 10px 3px 0; }
table.kv td { padding: 3px 0; vertical-align: top; }
table.kv tr { border-bottom: 1px solid #ddd; break-inside: avoid; }
table.list th { text-align: left; font-weight: normal; color: #333; border-bottom: 1px solid #111; padding: 3px 6px 3px 0; font-size: 9pt; }
table.list td { border-bottom: 1px solid #ddd; padding: 3px 6px 3px 0; vertical-align: top; font-size: 9pt; }
table.list tr { break-inside: avoid; }
.box { border: 1px solid #111; padding: 10px 12px; margin: 10px 0; break-inside: avoid; }
.sig { display: grid; grid-template-columns: 1fr 1fr; gap: 26px 28px; margin-top: 20px; }
.line { border-top: 1px solid #111; padding-top: 3px; font-size: 9pt; color: #333; }
.appendix { break-before: page; }
.raw { margin: 8px 0 14px; break-inside: avoid; }
.toolbar { position: sticky; top: 0; background: #f4f4f2; border-bottom: 1px solid #ccc; padding: 10px 16px; text-align: center; font: 14px system-ui, sans-serif; }
.toolbar button { font: inherit; padding: 6px 14px; margin-left: 8px; cursor: pointer; }
@media print { .toolbar { display: none; } main { padding: 0; } }
thead { display: table-header-group; }
@media (max-width: 560px) { table.kv th { width: 42%; } .sig { grid-template-columns: 1fr; } }
</style></head><body>
<div class="toolbar">Certified register extract ${esc(ex.id)} <button onclick="window.print()">Print or save as PDF</button></div>
<main>
<h1>Certified extract from the register</h1>
<p class="sub">${esc(ex.issuer.legalName || "Issuer")} · Bond ${esc(ex.bond.id)}${ex.bond.title ? " (" + esc(ex.bond.title) + ")" : ""} · Record ${esc(r.id)}</p>
${rows([["Extract number", ex.id, true], ["Made", utc(ex.madeAt)], ["Made for", ex.madeBy], ["Contents SHA-256", ex.digest, true]])}

<div class="box"><p>As of ${esc(utc(ex.madeAt))}, the register of ${esc(ex.issuer.legalName || "the issuer")} records
<strong>${esc(r.party)}</strong> as the assignee of record <strong>${esc(r.id)}</strong>, holding <strong>${esc(usd(r.units))}</strong>
of bond ${esc(ex.bond.id)}, with status <strong>${esc(r.status)}</strong>${r.assignor ? ", assigned from " + esc(r.assignor) : ""}.</p></div>

<h2>1. The entry</h2>
${rows(entryPairs)}

<h2>2. Chain of title</h2>
<p>From this record back to the bond. Each record names the signed instrument that created it by its SHA-256 fingerprint.</p>
<table class="list"><thead><tr><th>Record</th><th>Assignee</th><th>From</th><th>Amount</th><th>Issued / accepted</th><th>Status</th></tr></thead>
${ex.chain.map((x) => `<tr><td class="mono">${esc(x.id)}</td><td>${esc(x.party)}</td><td>${esc(x.assignor)}</td><td>${esc(usd(x.units))}</td><td>${esc([x.created, x.accepted].filter(Boolean).join(" / "))}</td><td>${esc(x.status)}</td></tr>
<tr><td></td><td colspan="5" class="mono">Instrument ${esc(x.instrumentHash || "—")}${x.filingNumber ? " · UCC-3 " + esc(x.filingNumber) : ""}</td></tr>`).join("")}
<tr><td class="mono">${esc(ex.bond.id)}</td><td colspan="5">The bond: ${esc(usd(ex.bond.total))} registered ${esc(ex.bond.registered || "")} by ${esc(ex.issuer.legalName || "the issuer")}</td></tr>
</table>

<h2>3. Documents and their fingerprints</h2>
<p>The register keeps each document's SHA-256 fingerprint, not the document. A copy is the same document only if its SHA-256 equals the one below.</p>
${rows(docPairs)}

<h2>4. History in the register</h2>
<p>Every event recorded for this record, in order. The register's event log is append-only: the database refuses any change or deletion of an entry.</p>
<table class="list"><thead><tr><th>#</th><th>Recorded (database time)</th><th>Event</th><th>By</th><th>Reference</th></tr></thead>
${ex.events.map((e) => `<tr><td>${e.seq}</td><td>${esc(utc(e.recordedAt))}</td><td>${esc(words(e.event))}</td><td>${esc(ROLE[e.by] || e.by)}</td><td class="mono">${esc(e.ref)}</td></tr>`).join("") || '<tr><td colspan="5">No events.</td></tr>'}
</table>

<h2>5. Acts signed with the assignee's own key</h2>
<p>${ex.signatures.length ? `${ex.signatures.length} signed act${ex.signatures.length === 1 ? "" : "s"}; ${sigOk} re-checked as valid when this extract was made.
Each was signed on the signer's own device with a passkey (fingerprint, face or PIN), over a challenge built from the act itself, and can be checked again from Appendix A.` : "No acts on this record were signed with an assignee's key."}</p>
${ex.signatures.length ? `<table class="list"><thead><tr><th>#</th><th>Signed (database time)</th><th>Act</th><th>On record</th><th>Signer</th><th>Key</th><th>Check</th></tr></thead>
${ex.signatures.map((s, i) => `<tr><td>A${i + 1}</td><td>${esc(utc(s.signedAt))}</td><td>${esc(ACT[s.act] || s.act)}</td><td class="mono">${esc(s.onRecord)}</td><td class="mono">${esc(s.signer)}</td><td class="mono">${esc(s.publicKey?.fingerprint || "—")}</td><td>${s.check.challengeMatches && s.check.signatureValid ? "Valid" : "Not verified"}</td></tr>`).join("")}
</table>` : ""}

<h2>6. The record on Canton</h2>
${ex.canton?.error ? `<p>${esc(ex.canton.error)}</p>` : !c ? "<p>This record is not on the Canton ledger.</p>" : !c.onCanton ? "<p>This record is not on the Canton ledger yet.</p>" : `
<p>The same record, read from the issuer's Canton node when this extract was made. Canton is a separate ledger: each contract is held only by its parties' nodes and each change is a transaction with its own ID.</p>
${rows([["Contract", c.contract.kind], ["Contract ID", c.contract.id, true], c.contract.since && ["Since", utc(c.contract.since)],
  ["Issuer", c.contract.issuer], ["Assignor", c.contract.assignor], ["Assignee", c.contract.assignee], ["Amount", usd(c.contract.units)],
  c.contract.signedBy && ["Signed by", [].concat(c.contract.signedBy).join(", ")], ["Instrument (SHA-256)", c.contract.paper, true],
  c.contract.ucc3 && ["UCC-3 (SHA-256)", c.contract.ucc3, true], c.contract.locked && ["Locked", c.contract.locked],
  c.contract.pledgedTo && ["Pledged to", c.contract.pledgedTo]])}
<table class="list"><thead><tr><th>When</th><th>What</th><th>By</th><th>Transaction</th><th>Offset</th></tr></thead>
${(c.history || []).map((h) => `<tr><td>${esc(utc(h.at))}</td><td>${esc(h.what)}</td><td>${esc(h.by)}</td><td class="mono">${esc(h.transaction)}</td><td>${esc(h.offset)}</td></tr>`).join("")}
</table>`}

<h2>7. How to check this extract</h2>
<p><strong>The extract itself.</strong> ${verifyAt ? `Enter ${esc(ex.id)} on the Verify page at ${esc(verifyAt)}.` : `Enter ${esc(ex.id)} on the register's public Verify page.`}
The register answers with the record it was made for, when it was made, and its contents SHA-256, which must equal ${esc(ex.digest)}.</p>
<p><strong>A document.</strong> Compute the SHA-256 of the file (for example <code>shasum -a 256 file.pdf</code> or <code>certutil -hashfile file.pdf SHA256</code>) and compare it with section 3. The Verify page does the same in the browser without uploading the file.</p>
<p><strong>A signed act.</strong> Each act's challenge is the SHA-256 of the JSON array
<code>["BondInterestRegistry/holder/v2", signer, counter, act, [details…]]</code>; the counter only goes up, so a signature can't be replayed.
The signature is ECDSA P-256 with SHA-256 over <em>authenticatorData</em> followed by the SHA-256 of <em>clientDataJSON</em> (the WebAuthn standard),
checked against the public key in Appendix A. clientDataJSON names the site it was made on and carries the challenge.</p>

<h2>8. Certification of the records custodian</h2>
<div class="box">
<p>I, the undersigned, declare:</p>
<p>1. I am a custodian of the records of ${esc(ex.issuer.legalName || "the issuer")}, or another person qualified to make this certification, and I am familiar with how its register of bond assignments is kept.</p>
<p>2. The register is kept in the course of ${esc(ex.issuer.legalName || "the issuer")}'s regularly conducted activity, and it is a regular practice of that activity to make these records. Each entry, event and signature in this extract was recorded at or near the time of the act it records, by, or from information transmitted by, a person with knowledge of it: the issuer, or the assignee or lender who signed it with their own key.</p>
<p>3. This extract, number ${esc(ex.id)}, is a true copy of the register's records for record ${esc(r.id)} as of ${esc(utc(ex.madeAt))}, produced by the register's own process, which identifies it by the SHA-256 value ${esc(ex.digest)}.</p>
<p>I declare under penalty of perjury under the laws of the United States of America that the foregoing is true and correct.</p>
<div class="sig">
<div class="line">Signature</div><div class="line">Date</div>
<div class="line">Printed name</div><div class="line">Title</div>
<div class="line">Executed at (city, state)</div><div class="line">Email or telephone</div>
</div></div>

${ex.signatures.length ? `<section class="appendix"><h2>Appendix A. Signed acts, in full</h2>
<p>Everything needed to check each signature again without the register: the act, the challenge, the signer's public key and the device's response (base64url).</p>
${ex.signatures.map((s, i) => `<div class="raw"><p><strong>A${i + 1}. ${esc(ACT[s.act] || s.act)}</strong> — ${esc(utc(s.signedAt))}, on record ${esc(s.onRecord)}, signer ${esc(s.signer)}, counter ${esc(s.counter)}${s.check.origin ? ", made on " + esc(s.check.origin) : ""}</p>
${rows([["Act details", JSON.stringify(s.details), true], ["Challenge", s.challenge, true],
  s.publicKey && ["Public key x", s.publicKey.x, true], s.publicKey && ["Public key y", s.publicKey.y, true],
  ["authenticatorData", s.response.authenticatorData, true], ["clientDataJSON", s.response.clientDataJSON, true], ["signature", s.response.signature, true],
  ["Re-checked when this extract was made", (s.check.challengeMatches ? "challenge matches the act" : "challenge does NOT match the act") + "; " + (s.check.signatureValid ? "signature valid for this key" : "signature NOT verified")]])}</div>`).join("")}
</section>` : ""}
</main></body></html>`;
}
