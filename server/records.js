// Record fingerprints and the assignee-signed actions.
//
// The register is the only record. What an assignee does to their own assignment (accept, reject,
// assign out, record a mailing, receipt or UCC-3) must be signed with their passkey: the server
// works out which actions a save implies, checks each signature before anything is saved, and
// keeps every signature in holder_signatures, so each act can be shown to be the assignee's own.
//
// Fingerprints: SHA-256 of a tagged JSON list, as 0x-hex. Documents themselves are never kept,
// only the SHA-256 of the file the person attached.
import crypto from "node:crypto";

export const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
const sha256hex = (s) => "0x" + crypto.createHash("sha256").update(s).digest("hex");
const tagged = (kind, values) => sha256hex(JSON.stringify(["BondInterestRegistry/" + kind + "/v2", ...values.map((v) => String(v ?? ""))]));

/** The UCC-3 behind a record: its filing number and the filed copy's SHA-256. */
export const filingRef = (recordId, filingNumber, filingDoc) => tagged("filing", [recordId, filingNumber, filingDoc || ""]);
/** The sender's delivery receipt: the mail number(s) and, when attached, the mailing receipt's SHA-256. */
export const deliveryRef = (recordId, instrumentMail, passkeyMail, mailingDoc) =>
  tagged("delivery", [recordId, instrumentMail, passkeyMail, mailingDoc || ""]);
/** The assignee's delivery receipt: the tracking number on it, the date received and the receipt copy's SHA-256. */
export const receiptRef = (recordId, receiptMail, receivedOn, receiptDoc) => tagged("receipt", [recordId, receiptMail, receivedOn, receiptDoc]);
/** The fingerprint a device key is registered under. */
export const deviceDoc = (recordId, credId) => tagged("device", [recordId, credId]);

/** The register keeps readable filing and mailing numbers, plus a fingerprint of each. */
export function normalizeRecord(a) {
  const out = { ...a };
  if (out.filingNumber) out.filingRef = filingRef(out.id, out.filingNumber, out.filingDoc);
  else if (out.filingRef && !isHash(out.filingRef)) out.filingRef = null;
  if (out.instrumentMail || out.passkeyMail) out.deliveryRef = deliveryRef(out.id, out.instrumentMail, out.passkeyMail, out.mailingDoc);
  else if (out.deliveryRef && !isHash(out.deliveryRef)) out.deliveryRef = null;
  if (out.receiptMail && out.receivedOn && out.receiptDoc) out.receiptRef = receiptRef(out.id, out.receiptMail, out.receivedOn, out.receiptDoc);
  else if (out.receiptRef && !isHash(out.receiptRef)) out.receiptRef = null;
  delete out.tx; // left by the retired chain mirror; never taken from a client
  delete out.chain;
  return out;
}

export const SCHEMA = `
  -- Every assignee-signed act: what was signed, the challenge, and the passkey's response,
  -- which anyone holding the record's public key can check again.
  create table if not exists holder_signatures (
    seq bigserial primary key,
    assignment text not null,     -- the record acted on
    signer text not null,         -- the record whose passkey signed
    fn text not null,
    args jsonb not null,
    nonce int not null,
    challenge text not null,
    assertion jsonb not null,
    created_at timestamptz not null default now());
  create index if not exists holder_signatures_assignment on holder_signatures (assignment, seq);
`;

// A pledge's lender signs in as the record's ID with this suffix (A00001~P): a separate passkey,
// for the one act that's theirs, releasing the pledge.
export const LENDER = "~P";

// Status moves an assignee makes, and what each is called when signed.
const SIGNED_MOVES = {
  "Issued>Accepted": "accept",
  "Issued>Rejected": "rejectAssignment",
  "Accepted>Locked": "lock",
  "Locked>Accepted": "unlock",
  "Issued>Cancelled": "cancelAssignOut", // an assignor taking back an assign-out nobody has claimed
};

/**
 * The signed acts one assignee-portal save implies, in order. Each names its signer: the record
 * whose passkey must sign ("$SESSION" = whoever is signed in).
 * `before` maps record id → stored data (undefined for new records); `after` is what will be saved.
 */
export function signedActions({ before, after }) {
  const acts = [];
  for (const a of after) {
    const o = before.get(a.id);
    if (!o && a.origin === "AssignOut")
      acts.push({ ref: a.id, fn: "assignOut", signer: a.parent, args: [a.bond, a.parent, a.id, String(a.units), a.docHash] });
    if (a.filingRef && a.filingRef !== o?.filingRef)
      acts.push({ ref: a.id, fn: "recordFiling", signer: "$SESSION", args: [a.bond, a.id, a.filingRef] });
    if (a.deliveryRef && a.deliveryRef !== o?.deliveryRef)
      acts.push({ ref: a.id, fn: "recordMailing", signer: a.parent, args: [a.bond, a.id, a.deliveryRef, a.mailedOn || ""] });
    if (a.receiptRef && a.receiptRef !== o?.receiptRef)
      acts.push({ ref: a.id, fn: "recordReceipt", signer: a.id, args: [a.bond, a.id, a.receiptRef, a.receivedOn || ""] });
    if (o && o.status !== a.status) {
      let fn = SIGNED_MOVES[o.status + ">" + a.status];
      // Lifting a lock: the assignee's own act, unless its lender has claimed the pledge, which only they release.
      if (fn === "unlock" && o.lender && !o.lender.releasedOn) fn = "releasePledge";
      // An accepted assignment ends as replaced only with its assignee's consent (a parent emptied by its assign-outs isn't signed).
      if (o.status + ">" + a.status === "Accepted>Superseded" && a.replacementAnswer === "consented") fn = "consentReplacement";
      if (fn) acts.push({ ref: a.id, fn, signer: fn === "cancelAssignOut" ? a.parent : fn === "releasePledge" ? a.id + LENDER : a.id,
        args: [a.bond, a.id, fn === "rejectAssignment" ? String(a.rejectionReason || "")
          : fn === "lock" ? [a.lockKind || "", a.pledgeTo || ""].join("|")
          : fn === "consentReplacement" ? String(o.replacement?.newId || "") : ""] });
    }
    if (o && o.status === a.status && a.replacementAnswer === "declined" && o.replacementAnswer !== "declined")
      acts.push({ ref: a.id, fn: "declineReplacement", signer: a.id, args: [a.bond, a.id, String(o.replacement?.newId || "")] });
  }
  return acts;
}

/** Keeps one checked signature. */
export async function keepSignature(c, { ref, signer, fn, args, nonce, challenge, assertion }) {
  await c.query(
    "insert into holder_signatures (assignment, signer, fn, args, nonce, challenge, assertion) values ($1, $2, $3, $4, $5, $6, $7)",
    [ref, signer, fn, JSON.stringify(args), nonce, challenge, JSON.stringify(assertion)]);
}
