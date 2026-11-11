// The on-chain mirror of the register.
//
// Every save that changes something the contract tracks becomes one or more queued calls in
// chain_ops, written in the same database transaction as the save itself. One sender (the
// process with CHAIN_WORKER=1) works through the queue in order, so a write is never lost and
// never sent twice:
//
//   - before sending, it reads the chain: if the change is already there, the call is marked
//     confirmed without a transaction;
//   - it records the transaction hash as soon as the call is sent, so after a restart it looks
//     for that receipt instead of sending again;
//   - a call the contract refuses marks the op failed and holds back later calls on the same
//     bond, because the chain and the register no longer agree. Platform staff see it, fix the
//     cause and retry.
//
// Configuration:
//   CHAIN_CONTRACT     registry address; unset turns the whole mirror off
//   CHAIN_RPC_URL      JSON-RPC endpoint
//   CHAIN_SIGNER_KEY   the key that signs (sender only). On the testnet it holds every role.
//   CHAIN_WORKER=1     this process sends
//   CHAIN_EXPLORER     block explorer base URL, for links
//
// Hashing rules (identical to chain/scripts/anchor.js):
//   IDs            keccak256 of the display ID ("KJPII-0001-BD", "KJPII-0001-BD-A00001", "KJPII")
//   ucc1Ref        keccak256(abi.encode("BondInterestRegistry/ucc1/v1", number, office, date, fileSha256))
//   prior refHash  keccak256 of the identifier, trimmed and upper-cased
//   prior docHash  keccak256(abi.encode("BondInterestRegistry/prior/v1", bond, entry, identifier, units, recordedOn))
//   filingRef      keccak256(abi.encode("BondInterestRegistry/filing/v1", record, filing number))
//   deliveryRef    keccak256(abi.encode("BondInterestRegistry/delivery/v1", record, instrument mail no., passkey mail no.))
//   other docs     the document's SHA-256 when there is one; otherwise
//                  keccak256(abi.encode("BondInterestRegistry/action/v1", record, function, event id, note))
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import * as safeLib from "./safe.js";
import * as holderKeys from "./holder-keys.js";

const ABI = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "registry-abi.json"), "utf8"));
export const CONTRACT = process.env.CHAIN_CONTRACT || "";
export const EXPLORER = (process.env.CHAIN_EXPLORER || "https://amoy.polygonscan.com").replace(/\/+$/, "");
export const enabled = !!CONTRACT;
export const CHAIN_ID = Number(process.env.CHAIN_ID || 80002);
// The contract this one replaced, when it was deployed to copy that one's state (see importAll).
export const PREDECESSOR = process.env.CHAIN_PREDECESSOR ? ethers.getAddress(process.env.CHAIN_PREDECESSOR) : null;
const iface = new ethers.Interface(ABI);
const coder = ethers.AbiCoder.defaultAbiCoder();

// ------------------------------------------------------------------ hashing

export const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
export const id32 = (s) => ethers.keccak256(ethers.toUtf8Bytes(String(s)));
const tagged = (kind, values) => ethers.keccak256(coder.encode(
  ["string", ...values.map(() => "string")], ["BondInterestRegistry/" + kind + "/v1", ...values.map((v) => String(v ?? ""))]));
export const ucc1Ref = (u) => ethers.keccak256(coder.encode(["string", "string", "string", "string", "bytes32"],
  ["BondInterestRegistry/ucc1/v1", u.number, u.office, u.date, u.hash]));
const priorKey = (ref) => String(ref).trim().toUpperCase();
export const priorRef = (ref) => id32(priorKey(ref));
export const priorDoc = (bondDisplay, p) => ethers.keccak256(coder.encode(
  ["string", "string", "string", "string", "uint128", "string"],
  ["BondInterestRegistry/prior/v1", bondDisplay, p.id, priorKey(p.ref), BigInt(p.units), p.recordedOn || ""]));
// With the filed copy's SHA-256 when the holder uploaded it (no paper, no record); older ones have the number alone.
export const filingRef = (recordId, filingNumber, filingDoc) =>
  filingDoc ? tagged("filing", [recordId, filingNumber, filingDoc]) : tagged("filing", [recordId, filingNumber]);
/** The sender's delivery receipt: the mail number(s) and, when attached, the mailing receipt's SHA-256. */
export const deliveryRef = (recordId, instrumentMail, passkeyMail, mailingDoc) =>
  tagged("delivery", [recordId, instrumentMail, passkeyMail, ...(mailingDoc ? [mailingDoc] : [])]);
/** The assignee's delivery receipt: the tracking number on it, the date received and the receipt copy's SHA-256. */
export const receiptRef = (recordId, receiptMail, receivedOn, receiptDoc) => tagged("receipt", [recordId, receiptMail, receivedOn, receiptDoc]);
/** A YYYY-MM-DD date (or any date string) as unix seconds, never later than now. */
export const dateSecs = (d) => String(Math.floor(Math.min(Date.parse(d) || Date.now(), Date.now()) / 1000));
// Register changes the contract keeps no state for are logged with logChange: the kind of change,
// and a hash of the new values (in a fixed order) so the register can be checked against the chain.
export const RECORD_DETAILS = ["party", "contact", "position", "address", "assignor"];
export const BOND_DETAILS = ["title", "assignor", "face", "registered"];
export const changeKind = (kind) => ethers.id(kind);
export const changeDoc = (subjectId, kind, fields, data) =>
  tagged("change", [subjectId, kind, ...fields.map((k) => JSON.stringify(data?.[k] ?? null))]);
const detailsChanged = (fields, o, a) => !!o && fields.some((k) => JSON.stringify(o[k] ?? null) !== JSON.stringify(a[k] ?? null));
const logChangeOp = (bond, subjectId, kind, doc) =>
  ({ bond, ref: subjectId, fn: "logChange", args: [id32(bond), id32(subjectId), changeKind(kind), doc], role: "relayer" });

const actionDoc = (recordId, fn, ev) => (ev && isHash(ev.ref) ? ev.ref : tagged("action", [recordId, fn, ev?.eid, ev?.ref]));

/** The register keeps readable filing and mailing numbers; the chain gets their hashes. */
export function normalizeRecord(a) {
  const out = { ...a };
  if (out.filingNumber) out.filingRef = filingRef(out.id, out.filingNumber, out.filingDoc);
  else if (out.filingRef && !isHash(out.filingRef)) out.filingRef = null;
  if (out.instrumentMail || out.passkeyMail) out.deliveryRef = deliveryRef(out.id, out.instrumentMail, out.passkeyMail, out.mailingDoc);
  else if (out.deliveryRef && !isHash(out.deliveryRef)) out.deliveryRef = null;
  if (out.receiptMail && out.receivedOn && out.receiptDoc) out.receiptRef = receiptRef(out.id, out.receiptMail, out.receivedOn, out.receiptDoc);
  else if (out.receiptRef && !isHash(out.receiptRef)) out.receiptRef = null;
  delete out.tx; // transaction hashes come from chain_ops, never from a client
  return out;
}

// ------------------------------------------------------------------ the queue

export const SCHEMA = `
  create table if not exists chain_ops (
    seq bigserial primary key,
    bond text,                    -- the lane: ops on one bond go strictly in order
    ref text not null,            -- what it's about: a bond, a record, an issuer or bond:entry
    fn text not null,
    args jsonb not null,
    role text not null,           -- issuer | relayer | platform: who signs on mainnet
    status text not null default 'queued',   -- queued | sent | confirmed | failed
    tx text, block bigint, error text, note text,
    attempts int not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now());
  -- Writes belong to one contract. Rows written before this column existed are the first
  -- (since replaced) deployment's, so a new contract starts with a clean queue.
  alter table chain_ops add column if not exists contract text;
  -- When the acting role is a Safe: which Safe, the Safe transaction to sign, and the owner
  -- signatures collected so far. Status 'signing' while it waits for them.
  alter table chain_ops add column if not exists safe text;
  alter table chain_ops add column if not exists safe_tx jsonb;
  alter table chain_ops add column if not exists signatures jsonb not null default '[]';
  -- Writes queued by one save share a batch; a Safe approves a run of them as one transaction,
  -- and the first write of the run lists the others it carries.
  alter table chain_ops add column if not exists batch text;
  alter table chain_ops add column if not exists batched jsonb;
  create index if not exists chain_ops_open on chain_ops (status, seq);
  create index if not exists chain_ops_ref on chain_ops (ref, seq);
`;

/** The challenge the holder of `signerId` signs for this call, at this nonce. */
export const holderChallenge = (signerId, nonce, fn, args) =>
  holderKeys.challengeFor({ iface, chainId: CHAIN_ID, contract: CONTRACT || ethers.ZeroAddress, signerId, nonce, fn, args });
/** A document hash for an action that has only a note behind it. */
export const noteDoc = (recordId, fn, note) => tagged("action", [recordId, fn, "", note]);
/** The document hash a device key is registered under. */
export const deviceDoc = (recordId, credId) => tagged("device", [recordId, credId]);

/** When a record's mailing went out, in unix seconds: starts the holder's response period on-chain. */
const mailedOn = (a) => {
  const t = Date.parse(a.deliveredAt || "") || Date.parse(a.created || "") || Date.now();
  return String(Math.floor(Math.min(t, Date.now()) / 1000));
};

export async function queueOps(c, ops) { if (enabled) await queue(c, ops); }

async function queue(c, ops) {
  const batch = ops.length > 1 ? crypto.randomUUID() : null;
  for (const o of ops) {
    await c.query("insert into chain_ops (bond, ref, fn, args, role, status, error, contract, batch) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [o.bond ?? null, o.ref, o.fn, JSON.stringify(o.args), o.role, o.status || "queued", o.error || null, CONTRACT, batch]);
  }
}

function anchorArgs(row) {
  const b = row.data, u = b.ucc1 || {};
  const problem = !isHash(b.instrumentHash) ? "the bond instrument's hash isn't a full SHA-256"
    : !(u.number && u.office && u.date && isHash(u.hash)) ? "the bond's UCC-1 is incomplete" : null;
  if (problem) return { problem: "Can't anchor: " + problem + "." };
  return { args: [id32(row.id), id32(row.code), String(b.total), b.instrumentHash, ucc1Ref(u)] };
}

/** Queues everything needed to put an approved bond on-chain: its issuer, the bond, its prior instruments. */
export async function queueAnchor(c, bondId) {
  if (!enabled) return;
  if ((await c.query("select 1 from chain_ops where fn in ('anchorBond', 'importBond') and ref = $1 and contract = $2", [bondId, CONTRACT])).rows.length) return;
  const row = (await c.query(
    "select b.id, b.data, i.id as issuer_id, i.code from bonds b join issuers i on i.id = b.issuer_id where b.id = $1", [bondId])).rows[0];
  if (!row) return;
  const b = row.data;
  const ops = [];
  if (!(await c.query("select 1 from chain_ops where fn in ('registerIssuer', 'importIssuer') and ref = $1 and contract = $2", [row.issuer_id, CONTRACT])).rows.length)
    ops.push({ bond: bondId, ref: row.issuer_id, fn: "registerIssuer", args: [id32(row.code), "$SIGNER"], role: "platform" });
  const a = anchorArgs(row);
  ops.push(a.problem
    ? { bond: bondId, ref: bondId, fn: "anchorBond", args: [], role: "issuer", status: "failed", error: a.problem }
    : { bond: bondId, ref: bondId, fn: "anchorBond", args: a.args, role: "issuer" });
  for (const p of (b.prior || []).filter((x) => !x.reversed))
    ops.push({ bond: bondId, ref: bondId + ":" + p.id, fn: "recordPriorInstrument",
      args: [id32(bondId), priorRef(p.ref), String(p.units), priorDoc(bondId, p)], role: "issuer" });
  await queue(c, ops);
}

/** Prior instruments added or reversed on a bond that is already on-chain. */
export async function queuePriorChanges(c, bondId, before, after) {
  if (!enabled) return;
  if (!(await c.query("select 1 from chain_ops where fn in ('anchorBond', 'importBond') and ref = $1 and contract = $2", [bondId, CONTRACT])).rows.length) return;
  const was = new Map(((before && before.prior) || []).map((p) => [p.id, p]));
  const ops = [];
  // The bond's own details (title, assignor, face, date): logged when they change.
  if (detailsChanged(BOND_DETAILS, before, after)) ops.push(logChangeOp(bondId, bondId, "bond", changeDoc(bondId, "bond", BOND_DETAILS, after)));
  for (const p of after.prior || []) {
    const o = was.get(p.id);
    if (!o && !p.reversed)
      ops.push({ bond: bondId, ref: bondId + ":" + p.id, fn: "recordPriorInstrument",
        args: [id32(bondId), priorRef(p.ref), String(p.units), priorDoc(bondId, p)], role: "issuer" });
    if (o && !o.reversed && p.reversed)
      ops.push({ bond: bondId, ref: bondId + ":" + p.id, fn: "reversePriorInstrument",
        args: [id32(bondId), priorRef(p.ref), tagged("action", [bondId + ":" + p.id, "reversePriorInstrument", "", p.reversedReason])], role: "issuer" });
  }
  await queue(c, ops);
}

// Status changes the contract makes itself, or that come with another call.
const IMPLIED = new Set(["Superseded"]);
// from → to → [function, role]; the role decides who signs on mainnet.
const TRANSITIONS = {
  "Issued>Accepted": ["accept", "relayer"],
  // An assign-out, before it takes effect: the assignor (until it's claimed) or the issuer cancels.
  "Issued>Cancelled": [null, null], // depends on who cancelled
  "Accepted>Locked": ["lock", "relayer"],
  "Locked>Accepted": ["unlock", "issuer"],
  // Redemption is the issuer's act: the bond's holder pays under the paperwork, then records it.
  "Accepted>Redeemed": ["redeem", "issuer"],
  "Issued>Rejected": ["rejectAssignment", "relayer"],
};
// The event each call usually comes with, for its document reference.
const EVENT_FOR = {
  accept: "Accepted", requestCredential: "CredentialRequested", rejectCredentialRequest: "CredentialRequestRejected",
  issueCredential: "CredentialIssued", cancelAssignOut: "AssignOutCancelled", issuerCancelAssignOut: "AssignOutCancelled",
  lock: "Locked", unlock: "Unlocked", redeem: "Redeemed", recordRotation: "PasskeyRotated", rejectAssignment: "AssignmentRejected",
};

/**
 * The contract calls that one save of assignment records implies.
 * `before` maps record id → stored data (undefined for new records); `after` is what was saved.
 */
export async function queueRecordChanges(c, { app, before, after, events, authFor }) {
  if (!enabled || !after.length) return;
  const evFor = (id, name) => events.find((e) => e.id === id && e.ev === name);
  const created = [], refs = [], moves = [];
  for (const a of after) {
    const o = before.get(a.id), B = id32(a.bond), A = id32(a.id);
    if (!o) {
      if (a.origin === "AssignOut")
        created.push({ bond: a.bond, ref: a.id, fn: "assignOut", args: [B, id32(a.parent), A, String(a.units), a.docHash], role: "relayer", signer: a.parent });
      else if (a.origin === "Replacement")
        created.push({ bond: a.bond, ref: a.id, fn: "replaceAssignment", args: [B, id32(a.parent), A, a.docHash], role: "issuer" });
      else
        created.push({ bond: a.bond, ref: a.id, fn: "issueAssignment", args: [B, A, String(a.units), a.docHash], role: "issuer" });
    }
    if (a.filingRef && a.filingRef !== o?.filingRef)
      refs.push(app === "holder"
        // The holder's own UCC-3, signed with the device of whoever is signed in (the record's holder, or its assignor).
        ? { bond: a.bond, ref: a.id, fn: "recordFiling", args: [B, A, "$SIGNER_ID", a.filingRef], role: "relayer", signer: "$SESSION" }
        : { bond: a.bond, ref: a.id, fn: "setFilingRef", args: [B, A, a.filingRef], role: "issuer" });
    // Corrected names, contacts and addresses: no state on-chain, so they're logged as a hash.
    if (detailsChanged(RECORD_DETAILS, o, a)) refs.push(logChangeOp(a.bond, a.id, "details", changeDoc(a.id, "details", RECORD_DETAILS, a)));
    if (a.deliveryRef && a.deliveryRef !== o?.deliveryRef)
      refs.push(app === "holder"
        // An assign-out's mailing, recorded by its assignor and signed with their device.
        ? { bond: a.bond, ref: a.id, fn: "recordMailing", args: [B, A, a.deliveryRef, mailedOn(a)], role: "relayer", signer: a.parent }
        : { bond: a.bond, ref: a.id, fn: "setDeliveryRef", args: [B, A, a.deliveryRef, mailedOn(a)], role: "issuer" });
    // The assignee's delivery receipt, signed with their own device.
    if (app === "holder" && a.receiptRef && a.receiptRef !== o?.receiptRef)
      refs.push({ bond: a.bond, ref: a.id, fn: "recordReceipt", args: [B, A, a.receiptRef, dateSecs(a.receivedOn)], role: "relayer", signer: a.id });
    if (o && o.status !== a.status && !IMPLIED.has(a.status)) {
      let [fn, role] = TRANSITIONS[o.status + ">" + a.status] || [undefined, undefined];
      if (fn === null) [fn, role] = app === "holder" ? ["cancelAssignOut", "relayer"] : ["issuerCancelAssignOut", "issuer"];
      if (!fn) {
        moves.push({ bond: a.bond, ref: a.id, fn: "unsupported", args: [], role: "issuer", status: "failed",
          error: `No contract call moves a record from ${o.status} to ${a.status}.` });
      } else {
        // A holder's own move is signed by their key: the assignor's for cancelling an assign-out.
        const signer = holderKeys.SIGNED[fn] ? (fn === "cancelAssignOut" ? a.parent : a.id) : undefined;
        moves.push({ bond: a.bond, ref: a.id, fn, args: [B, A, actionDoc(a.id, fn, evFor(a.id, EVENT_FOR[fn]))], role, signer });
      }
    }
    // A passkey reissued on a locked record: the status stays Locked.
    const rot = o && o.status === "Locked" && a.status === "Locked" && evFor(a.id, "PasskeyRotated");
    if (rot) moves.push(logChangeOp(a.bond, a.id, "rotation", actionDoc(a.id, "rotation", rot)));
  }
  // New records first (a cancel or replacement can refer to them), then references (a credential
  // needs its UCC-3 on record first), then status changes.
  const ops = [...created, ...refs, ...moves];
  // Holder moves carry the holder's device signature. Without one, only an assignment taking
  // effect at the end of its response period can go (the contract checks the date).
  for (const op of ops) {
    if (!op.signer) continue;
    const auth = authFor ? await authFor(op) : null;
    if (auth) op.args.push(auth);
    else if (op.fn === "accept") op.args.push(holderKeys.NOAUTH);
    else Object.assign(op, { status: "failed", error: op.fn + " needs the holder's device signature, and none came with it." });
    delete op.signer;
  }
  await queue(c, ops);
}

/**
 * The calls that rebuild one record on a fresh contract. Covers records that were issued and then
 * took effect or were rejected, with no transfers; anything with more history is flagged for a
 * person to replay rather than guessed at.
 */
function replayOps(a) {
  const B = id32(a.bond), A = id32(a.id), ops = [];
  const simple = a.origin === "Issuer" && ["Issued", "Accepted", "Rejected"].includes(a.status) && Number(a.units) === Number(a.issuedUnits ?? a.units);
  if (!simple || !isHash(a.docHash))
    return [{ bond: a.bond, ref: a.id, fn: "unsupported", args: [], role: "issuer", status: "failed",
      error: `Can't rebuild ${a.id} (${a.origin}, ${a.status}) on the new contract automatically.` }];
  ops.push({ bond: a.bond, ref: a.id, fn: "issueAssignment", args: [B, A, String(a.issuedUnits ?? a.units), a.docHash], role: "issuer" });
  if (a.filingRef && isHash(a.filingRef)) ops.push({ bond: a.bond, ref: a.id, fn: "setFilingRef", args: [B, A, a.filingRef], role: "issuer" });
  if (a.deliveryRef && isHash(a.deliveryRef)) ops.push({ bond: a.bond, ref: a.id, fn: "setDeliveryRef", args: [B, A, a.deliveryRef, mailedOn(a)], role: "issuer" });
  // Without the holder's signature, only an unanswered assignment can be rebuilt as in effect
  // (once its response period has passed); a holder's own acceptance or rejection can't be replayed.
  if (a.status === "Accepted") ops.push(a.effective === "deemed"
    ? { bond: a.bond, ref: a.id, fn: "accept", args: [B, A, tagged("action", [a.id, "accept", "replay", ""]), holderKeys.NOAUTH], role: "relayer" }
    : { bond: a.bond, ref: a.id, fn: "unsupported", args: [], role: "relayer", status: "failed",
        error: `${a.id} took effect with the holder's signature on the old contract; it can't be replayed without it.` });
  if (a.status === "Rejected") ops.push({ bond: a.bond, ref: a.id, fn: "unsupported", args: [], role: "relayer", status: "failed",
    error: `${a.id} was rejected with the holder's signature on the old contract; it can't be replayed without it.` });
  return ops;
}

export async function queueIssuerStatus(c, issuerId, code, status) {
  if (!enabled) return;
  if (!(await c.query("select 1 from chain_ops where fn in ('registerIssuer', 'importIssuer') and ref = $1 and contract = $2", [issuerId, CONTRACT])).rows.length) return;
  const fn = status === "suspended" ? "suspendIssuer" : "reinstateIssuer";
  await queue(c, [{ bond: null, ref: issuerId, fn, args: [id32(code), tagged("action", [issuerId, fn, new Date().toISOString(), ""])], role: "platform" }]);
}

// ------------------------------------------------------------------ reading status back

/**
 * On-chain standing: confirmed / pending / failed, with the latest transaction.
 * A record is judged by its own writes; a bond by everything in its lane except record writes
 * (its issuer, its anchoring, its prior instruments), so a stuck prior instrument shows on the bond.
 */
export async function statusFor(pool, bondIds, recordIds) {
  if (!enabled || (!bondIds.length && !recordIds.length)) return new Map();
  const r = await pool.query(
    `select ref, bond, status, tx, error, fn from chain_ops
      where contract = $3 and (ref = any($1) or (bond = any($2) and ref not like bond || '-A%')) order by seq`,
    [recordIds, bondIds, CONTRACT]);
  const out = new Map();
  for (const o of r.rows) {
    const key = recordIds.includes(o.ref) ? o.ref : o.bond;
    const s = out.get(key) || { state: "confirmed", tx: null, error: null, pending: 0 };
    if (o.status === "failed") { s.state = "failed"; s.error = s.error || o.error; }
    else if (o.status === "signing") { if (s.state !== "failed") s.state = "signing"; s.pending++; }
    else if (o.status === "queued" || o.status === "sent") { if (s.state !== "failed" && s.state !== "signing") s.state = "pending"; s.pending++; }
    if (o.tx && o.status === "confirmed" && (key === o.ref || o.fn === "anchorBond")) s.tx = o.tx;
    out.set(key, s);
  }
  return out;
}

// What a browser needs to read the contract itself, without this server: the public endpoint,
// the network, and the block the contract was deployed in (where the event search starts).
export const publicInfo = () => (enabled ? {
  contract: CONTRACT, explorer: EXPLORER,
  rpc: process.env.CHAIN_PUBLIC_RPC || "https://polygon-amoy-bor-rpc.publicnode.com",
  chainId: Number(process.env.CHAIN_ID || 80002),
  network: process.env.CHAIN_NETWORK || "Polygon Amoy (testnet)",
  fromBlock: Number(process.env.CHAIN_FROM_BLOCK || 52339175),
} : null);

// ------------------------------------------------------------------ the sender

const TARGET = { accept: 4, requestCredential: 2, rejectCredentialRequest: 1, issueCredential: 3, cancelAssignOut: 9,
  issuerCancelAssignOut: 9, lock: 5, unlock: 4, redeem: 7,
  rejectAssignment: 10 };

/** True when the chain already shows the op's effect, so it must not be sent again. */
async function alreadyDone(reg, op, signer) {
  const a = op.args;
  switch (op.fn) {
    case "registerIssuer": {
      const i = await reg.issuers(a[0]);
      if (i.account === ethers.ZeroAddress) return false;
      if (i.account.toLowerCase() !== String(a[1]).toLowerCase() && i.account.toLowerCase() !== signer.toLowerCase())
        throw new Error("Issuer is registered on-chain to " + i.account + ".");
      return true;
    }
    case "anchorBond": {
      const b = await reg.bonds(a[0]);
      if (b.issuerId === ethers.ZeroHash) return false;
      if (b.total !== BigInt(a[2]) || b.instrumentHash !== a[3] || b.ucc1Ref !== a[4] || b.issuerId !== a[1])
        throw new Error("The bond is already on-chain with different figures.");
      return true;
    }
    case "recordPriorInstrument": {
      const p = await reg.priorInstruments(a[0], a[1]);
      if (!p.recorded) return false;
      if (p.units !== BigInt(a[2])) throw new Error("This prior instrument is already on-chain with a different amount.");
      return true;
    }
    case "reversePriorInstrument": return (await reg.priorInstruments(a[0], a[1])).reversed;
    case "issueAssignment": case "replaceAssignment": return Number((await reg.assignments(a[1 + (op.fn === "replaceAssignment" ? 1 : 0)])).status) !== 0;
    case "assignOut": return Number((await reg.assignments(a[2])).status) !== 0;
    case "setFilingRef": return (await reg.assignments(a[1])).filingRef === a[2];
    case "setDeliveryRef": case "recordMailing": return (await reg.assignments(a[1])).deliveryRef === a[2];
    case "recordReceipt": return (await reg.receipts(a[1])).ref === a[2];
    case "suspendIssuer": return (await reg.issuers(a[0])).suspended;
    case "reinstateIssuer": return !(await reg.issuers(a[0])).suspended;
    case "registerHolderKey": case "rotateHolderKey": return (await reg.holderKeys(a[1])).x === BigInt(a[2]);
    case "clearHolderKey": { const k = await reg.holderKeys(a[1]); return k.x === 0n && k.y === 0n; }
    case "pause": return reg.paused();
    case "importIssuer": return (await reg.issuers(a[0])).account !== ethers.ZeroAddress;
    case "importBond": return (await reg.bonds(a[0])).issuerId !== ethers.ZeroHash;
    case "importPrior": return (await reg.priorInstruments(a[0], a[1])).recorded;
    case "importRecord": return Number((await reg.assignments(a[0])).status) !== 0;
    case "finishImport": return !(await reg.migrating());
    default:
      if (op.fn in TARGET) return Number((await reg.assignments(a[1])).status) === TARGET[op.fn];
      return false;
  }
}

const STATUS_NAME = ["None", "AwaitingCredential", "CredentialRequested", "Issued", "Accepted", "Locked",
  "PendingRedemption", "Redeemed", "Superseded", "Cancelled", "Rejected"];
// Contract errors in words: IDs are hashes, so they're left out; statuses and amounts are kept.
function readable(p) {
  const a = [...p.args];
  switch (p.name) {
    case "WrongStatus": return "the record is " + STATUS_NAME[Number(a[1])] + " on-chain, which doesn't allow this";
    case "NotEnoughUnits": return "only " + a[0] + " units are available, " + a[1] + " were asked for";
    case "PendingChildren": return "the record has " + a[1] + " pending transfer(s)";
    case "UnknownRecord": return "the record isn't on-chain";
    case "UnknownBond": return "the bond isn't on-chain";
    case "IssuerIsSuspended": return "the issuer is suspended on-chain";
    case "FilingNotRecorded": return "the UCC-3 filing isn't on-chain yet";
    case "Migrating": return "this contract is still copying from the one it replaced; it opens when the copy is finished";
    case "EnforcedPause": return "this contract is frozen (paused), for a move or an emergency";
    case "PredecessorNotPaused": return "the old contract has to be frozen before its records can be copied";
    case "NotOnPredecessor": return "the old contract doesn't hold that";
    case "AlreadyImported": return "already copied";
    default: return p.name;
  }
}

const revertReason = (e) => {
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try { const p = iface.parseError(data); if (p) return readable(p); } catch { /* unknown */ }
  }
  if (e?.code === "CALL_EXCEPTION") return e.reason || e.shortMessage || "reverted";
  return null;
};

// ------------------------------------------------------------------ Safes

/** The platform's Safe, when the platform role is held by one. */
export const PLATFORM_SAFE = process.env.CHAIN_PLATFORM_SAFE ? ethers.getAddress(process.env.CHAIN_PLATFORM_SAFE) : null;
let readProvider = null;
const provider = () => (readProvider ||= new ethers.JsonRpcProvider(process.env.CHAIN_RPC_URL || process.env.CHAIN_PUBLIC_RPC));

/** Which Safe must approve this op, or null when the platform's key sends it directly. */
export async function safeFor(pool, op) {
  if (op.role === "relayer") return null;
  if (op.role === "platform" || op.role === "guardian") return PLATFORM_SAFE; // the platform's Safe holds both
  // Issuer calls act for the issuer that owns the op's bond.
  const r = (await pool.query("select i.safe_address from bonds b join issuers i on i.id = b.issuer_id where b.id = $1", [op.bond])).rows[0];
  return r?.safe_address ? ethers.getAddress(r.safe_address) : null;
}

/** The address an issuer acts through on-chain: its Safe if it has one, otherwise the platform's key. */
async function issuerAccount(pool, issuerId, fallback) {
  const r = (await pool.query("select safe_address from issuers where id = $1", [issuerId])).rows[0];
  return r?.safe_address ? ethers.getAddress(r.safe_address) : fallback;
}

/** Ops waiting on a Safe's owners, oldest first, with what a wallet needs to sign them. */
export async function awaitingSignature(pool, safe) {
  if (!enabled || !safe) return [];
  const rows = (await pool.query(
    "select seq, bond, ref, fn, safe_tx, signatures, batched, created_at from chain_ops where contract = $1 and status = 'signing' and safe = $2 order by seq",
    [CONTRACT, ethers.getAddress(safe)])).rows;
  if (!rows.length) return [];
  const st = await safeLib.safeState(provider(), safe);
  return rows.map((r) => ({
    seq: Number(r.seq), bond: r.bond, ref: r.ref, fn: r.fn, createdAt: r.created_at,
    // One approval for several writes: each call it carries, in order (the first is this one).
    calls: r.batched?.length ? [{ fn: r.fn, ref: r.ref }, ...r.batched.map((b) => ({ fn: b.fn, ref: b.ref }))] : [{ fn: r.fn, ref: r.ref }],
    safe: r.safe_tx.safe, nonce: Number(r.safe_tx.message.nonce), owners: st.owners, threshold: st.threshold,
    signedBy: (r.signatures || []).map((x) => x.signer),
    typedData: safeLib.typedDataFor(r.safe_tx),
    explorer: EXPLORER,
  }));
}

/** The last few writes this Safe approved, newest first, with their transactions. */
export async function recentForSafe(pool, safe, limit = 4) {
  if (!enabled || !safe) return [];
  const rows = (await pool.query(
    `select seq, ref, fn, status, tx, error, safe_tx->'message'->>'nonce' as nonce, updated_at from chain_ops
      where contract = $1 and safe = $2 and status in ('sent', 'confirmed', 'failed') and safe_tx is not null
      order by updated_at desc limit $3`, [CONTRACT, ethers.getAddress(safe), limit])).rows;
  return rows.map((r) => ({ seq: Number(r.seq), ref: r.ref, fn: r.fn, status: r.status, nonce: Number(r.nonce), error: r.error,
    tx: r.tx, link: r.tx ? EXPLORER + "/tx/" + r.tx : null, at: r.updated_at }));
}

/** Records one owner's signature on a waiting op. Refuses anything that isn't a current owner's. */
export async function addSignature(pool, seq, safe, signature) {
  const op = (await pool.query("select * from chain_ops where seq = $1 and contract = $2 and status = 'signing'", [seq, CONTRACT])).rows[0];
  if (!op || ethers.getAddress(op.safe) !== ethers.getAddress(safe)) return { ok: false, error: "That approval isn't waiting for this Safe." };
  let signer;
  try { signer = ethers.getAddress(safeLib.signerOf(op.safe_tx, signature)); } catch { return { ok: false, error: "That signature couldn't be read." }; }
  const st = await safeLib.safeState(provider(), op.safe);
  if (!st.owners.includes(signer)) return { ok: false, error: `The signature is from ${signer}, which isn't an owner of this Safe.` };
  if (Number(op.safe_tx.message.nonce) !== st.nonce) return { ok: false, error: "This approval is out of date; it will be prepared again. Refresh and sign the new one." };
  const sigs = (op.signatures || []).filter((x) => x.signer !== signer).concat([{ signer, signature, at: new Date().toISOString() }]);
  await pool.query("update chain_ops set signatures = $2, updated_at = now() where seq = $1", [seq, JSON.stringify(sigs)]);
  return { ok: true, signer, signatures: sigs.length, threshold: st.threshold };
}

export function startWorker(pool, log = console) {
  if (!enabled || process.env.CHAIN_WORKER !== "1") return null;
  if (!process.env.CHAIN_SIGNER_KEY || !process.env.CHAIN_RPC_URL) {
    log.error("Chain sender not started: set CHAIN_SIGNER_KEY and CHAIN_RPC_URL.");
    return null;
  }
  const provider = new ethers.JsonRpcProvider(process.env.CHAIN_RPC_URL);
  const wallet = new ethers.Wallet(process.env.CHAIN_SIGNER_KEY, provider);
  const signer = new ethers.NonceManager(wallet);
  const reg = new ethers.Contract(CONTRACT, ABI, signer);
  let busy = false, stopped = false, wait = 0;

  async function reconcile() {
    // Approved bonds that aren't queued yet: anchor them (the already-on-chain check makes this safe).
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select pg_advisory_xact_lock(424243)");
      // A contract that replaced another copies its state first; the rest below then finds it covered.
      if (PREDECESSOR && (await reg.migrating().catch(() => false))) {
        const n = await queueImports(c);
        if (n) log.log(`Chain: queued ${n} import(s) from ${PREDECESSOR}`);
      }
      const rows = (await c.query(`select b.id from bonds b join issuers i on i.id = b.issuer_id
        where b.review = 'approved' and i.status in ('approved','suspended')
          and not exists (select 1 from chain_ops o where o.fn in ('anchorBond', 'importBond') and o.ref = b.id and o.contract = $1) order by b.id`, [CONTRACT])).rows;
      for (const r of rows) await queueAnchor(c, r.id);
      // Records that have nothing on this contract yet (it replaced an earlier deployment):
      // rebuild them, oldest first, after their bond.
      const recs = (await c.query(`select a.id, a.data from assignments a join bonds b on b.id = a.bond
        where b.review = 'approved'
          and not exists (select 1 from chain_ops o where o.ref = a.id and o.contract = $1)
        order by a.created_at, a.id`, [CONTRACT])).rows;
      for (const r of recs) await queue(c, replayOps(r.data));
      await c.query("commit");
      if (rows.length || recs.length) log.log(`Chain: queued ${rows.length} bond(s) and ${recs.length} record(s) for this contract`);
    } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
  }

  /**
   * The next op of each bond's lane (bonds go strictly in order; different bonds don't wait on
   * each other), oldest first. A lane stops at a failed op until it's fixed and retried.
   */
  async function heads() {
    const open = (await pool.query(`
      select * from chain_ops o where o.contract = $1 and o.status in ('queued','sent','signing')
        and not exists (select 1 from chain_ops f where f.contract = $1 and f.status = 'failed' and f.bond is not distinct from o.bond and f.seq < o.seq)
      order by o.seq`, [CONTRACT])).rows;
    const seen = new Set(), out = [];
    for (const o of open) { const k = o.bond ?? ""; if (!seen.has(k)) { seen.add(k); out.push(o); } }
    return out;
  }
  const mark = (op, fields) => {
    const keys = Object.keys(fields);
    return pool.query(`update chain_ops set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where seq = $1`,
      [op.seq, ...keys.map((k) => fields[k])]);
  };

  async function resolveArgs(op) {
    // "$SIGNER" is the account an issuer is registered with: its Safe if it has one.
    const acct = op.fn === "registerIssuer" ? await issuerAccount(pool, op.ref, wallet.address) : wallet.address;
    return op.args.map((x) => (x === "$SIGNER" ? acct : x));
  }

  async function handle(op) {
    if (typeof reg[op.fn] !== "function" || (op.fn === "anchorBond" && !op.args.length))
      return mark(op, { status: "failed", error: op.error || "Nothing to send for " + op.fn + "." });
    const args = await resolveArgs(op);
    const opx = { ...op, args };
    const safe = op.safe || (await safeFor(pool, op));
    if (safe) return handleSafe(op, opx, safe);
    if (op.status === "sent" && op.tx) {
      const r = await provider.getTransactionReceipt(op.tx);
      if (r && r.status === 1) return mark(op, { status: "confirmed", block: r.blockNumber });
      if (!r && Date.now() - new Date(op.updated_at).getTime() < 10 * 60_000) return; // still pending
      // Reverted, or dropped: decide from what the chain shows now.
    }
    if (await alreadyDone(reg, opx, wallet.address)) return mark(op, { status: "confirmed", note: "already on-chain" });
    let tx;
    try {
      await reg[op.fn].staticCall(...args); // a refusal is caught here, before paying gas
      tx = await reg[op.fn](...args);
    } catch (e) {
      const why = revertReason(e);
      if (why) {
        signer.reset();
        return mark(op, { status: "failed", error: "The contract refused " + op.fn + ": " + why, attempts: op.attempts + 1 });
      }
      signer.reset();
      throw e; // network trouble: retried
    }
    await mark(op, { status: "sent", tx: tx.hash, attempts: op.attempts + 1 });
    // Poll for the receipt rather than relying on block subscriptions, which can stall behind a
    // load-balanced endpoint. If it takes longer than this, the next round picks it up by hash.
    let r = null;
    for (let i = 0; i < 90 && !r; i++) {
      r = await provider.getTransactionReceipt(tx.hash).catch(() => null);
      if (!r) await new Promise((res) => setTimeout(res, 1500));
    }
    if (!r) return; // still pending: handled as 'sent' next round
    if (r.status === 1) return mark(op, { status: "confirmed", block: r.blockNumber });
    // Reverted after a clean dry run: usually a node behind a load balancer that hadn't seen the
    // previous write yet. Try again a few times; the dry run before each send catches a real refusal.
    await mark(op, op.attempts + 1 < 3
      ? { status: "queued", note: "reverted on-chain; retrying" }
      : { status: "failed", error: "Transaction reverted on-chain three times" });
  }

  // Waits for a receipt by polling; null if it doesn't arrive in time (picked up next round).
  async function waitReceipt(hash) {
    for (let i = 0; i < 90; i++) {
      const r = await provider.getTransactionReceipt(hash).catch(() => null);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 1500));
    }
    return null;
  }

  /**
   * An op whose role is held by a Safe: prepare the Safe transaction and wait for owner signatures,
   * then submit it. The platform's key only pays the gas; the Safe checks the signatures.
   */
  // Whether Safe's MultiSendCallOnly is on this chain (checked once): without it, one approval per write.
  let multiSendOk = null;
  const canBatch = async () => (multiSendOk ??= (await provider.getCode(safeLib.MULTISEND).catch(() => "0x")) !== "0x");

  /** The writes right behind `op` in its lane, from the same save and for the same Safe: approved with it. */
  async function batchFor(op, safe) {
    if (!op.batch || !(await canBatch())) return [];
    const next = (await pool.query(`select * from chain_ops where contract = $1 and status = 'queued' and seq > $2
      and bond is not distinct from $3 order by seq limit 20`, [CONTRACT, op.seq, op.bond])).rows;
    const out = [];
    for (const n of next) {
      if (n.batch !== op.batch || (await safeFor(pool, n)) !== safe) break; // the run ends at the first that isn't
      if (await alreadyDone(reg, { ...n, args: await resolveArgs(n) }, wallet.address)) break; // let it confirm on its own
      out.push(n);
    }
    return out;
  }

  async function handleSafe(op, opx, safe) {
    const data = iface.encodeFunctionData(op.fn, opx.args);
    const confirmBatch = (txHash, block) => Promise.all((op.batched || []).map((b) => pool.query(
      "update chain_ops set status = 'confirmed', tx = $2, block = $3, safe = $4, note = $5, updated_at = now() where seq = $1 and status = 'queued'",
      [b.seq, txHash, block, safe, "approved with #" + op.seq])));
    if (op.status === "sent" && op.tx) {
      const r = await provider.getTransactionReceipt(op.tx);
      if (r && r.status === 1) { await confirmBatch(op.tx, r.blockNumber); return mark(op, { status: "confirmed", block: r.blockNumber }); }
      if (!r && Date.now() - new Date(op.updated_at).getTime() < 10 * 60_000) return;
      // Reverted or dropped: fall through and decide from the chain.
    }
    if (await alreadyDone(reg, opx, wallet.address)) return mark(op, { status: "confirmed", note: "already on-chain" });
    const st = await safeLib.safeState(provider, safe);

    if (op.status !== "signing" || !op.safe_tx || Number(op.safe_tx.message.nonce) !== st.nonce) {
      // One approval at a time per Safe, in order: the Safe's nonce makes them sequential anyway.
      const other = (await pool.query("select 1 from chain_ops where contract = $1 and status = 'signing' and safe = $2 and seq <> $3",
        [CONTRACT, safe, op.seq])).rows.length;
      if (other) return;
      // Dry run as the Safe: a refusal is caught before anyone is asked to sign. (The rest of a batch
      // depends on this one, so it's checked as a whole just before it's executed.)
      try { await provider.call({ from: safe, to: CONTRACT, data }); }
      catch (e) {
        const why = revertReason(e) || e.shortMessage || e.message;
        return mark(op, { status: "failed", error: "The contract would refuse " + op.fn + " from the Safe: " + why, safe });
      }
      const chainId = (await provider.getNetwork()).chainId;
      const more = await batchFor(op, safe);
      const stx = more.length
        ? safeLib.buildSafeTx({ safe, chainId, to: safeLib.MULTISEND, operation: 1, nonce: st.nonce,
            data: safeLib.multiSendData([{ to: CONTRACT, data }, ...(await Promise.all(more.map(async (n) =>
              ({ to: CONTRACT, data: iface.encodeFunctionData(n.fn, await resolveArgs(n)) }))))]) })
        : safeLib.buildSafeTx({ safe, chainId, to: CONTRACT, data, nonce: st.nonce });
      return mark(op, { status: "signing", safe, safe_tx: JSON.stringify(stx), signatures: "[]",
        batched: more.length ? JSON.stringify(more.map((n) => ({ seq: Number(n.seq), fn: n.fn, ref: n.ref }))) : null,
        note: "waiting for " + st.threshold + " signature(s)" + (more.length ? " · one approval for " + (more.length + 1) + " writes" : "") });
    }

    const valid = (op.signatures || []).filter((x) => st.owners.includes(x.signer));
    if (valid.length < st.threshold) return; // still waiting on owners
    const safeC = new ethers.Contract(safe, safeLib.SAFE_ABI, signer);
    const args = safeLib.execArgs(op.safe_tx, valid.slice(0, st.threshold));
    let tx;
    try {
      await safeC.execTransaction.staticCall(...args);
      tx = await safeC.execTransaction(...args);
    } catch (e) {
      signer.reset();
      const why = revertReason(e) || e.reason || e.shortMessage;
      if (why) return mark(op, { status: "failed", error: "The Safe refused to execute " + op.fn + ": " + why });
      throw e;
    }
    await mark(op, { status: "sent", tx: tx.hash, attempts: op.attempts + 1 });
    const r = await waitReceipt(tx.hash);
    if (!r) return;
    if (r.status === 1) { await confirmBatch(tx.hash, r.blockNumber); return mark(op, { status: "confirmed", block: r.blockNumber }); }
    await mark(op, { status: "failed", error: "The Safe transaction reverted on-chain" });
  }

  async function tick() {
    if (busy || stopped) return;
    if (wait > 0) { wait--; return; }
    busy = true;
    try {
      for (let round = 0; round < 25; round++) {
        let progressed = false;
        for (const op of await heads()) {
          await handle(op);
          const after = (await pool.query("select status from chain_ops where seq = $1", [op.seq])).rows[0];
          if (after?.status === "confirmed") progressed = true; // its lane may have more to do
        }
        if (!progressed) break;
      }
    } catch (e) {
      log.error("Chain sender:", e.shortMessage || e.message);
      wait = 3; // back off a few ticks
    } finally { busy = false; }
  }

  reconcile().catch((e) => log.error("Chain reconcile:", e.message));
  const timer = setInterval(tick, 4000);
  log.log(`Chain sender on: ${CONTRACT} as ${wallet.address}`);
  return { stop: () => { stopped = true; clearInterval(timer); }, tick };
}

/** Puts a failed op (and everything held behind it) back in the queue. */
export async function retry(pool, seq) {
  const op = (await pool.query("select * from chain_ops where seq = $1 and status = 'failed' and contract = $2", [seq, CONTRACT])).rows[0];
  if (!op) return false;
  let args = op.args;
  if (op.fn === "anchorBond" && !args.length) {
    // Anchoring was blocked by the bond's own data: rebuild from what the register holds now.
    const row = (await pool.query(
      "select b.id, b.data, i.code from bonds b join issuers i on i.id = b.issuer_id where b.id = $1", [op.ref])).rows[0];
    const a = row ? anchorArgs(row) : { problem: "The bond is gone." };
    if (a.problem) {
      await pool.query("update chain_ops set error = $2, updated_at = now() where seq = $1", [seq, a.problem]);
      return false;
    }
    args = a.args;
  }
  await pool.query("update chain_ops set status = 'queued', error = null, args = $2, updated_at = now() where seq = $1", [seq, JSON.stringify(args)]);
  return true;
}

/**
 * Freezes this contract for a move to a new version: queues pause(), approved through the
 * platform's Safe. Only with nothing else open, so the new contract copies a settled state.
 */
export async function freezeForMove(pool) {
  if (!enabled) throw Object.assign(new Error("The chain mirror is off."), { status: 409 });
  const open = (await pool.query("select count(*)::int c from chain_ops where contract = $1 and status in ('queued','sent','signing','failed')", [CONTRACT])).rows[0].c;
  if (open) throw Object.assign(new Error(open + " chain write(s) are still open. Let them finish (or fix the failed ones) before freezing."), { status: 409 });
  if ((await pool.query("select 1 from chain_ops where contract = $1 and fn = 'pause' and status <> 'failed'", [CONTRACT])).rows.length)
    throw Object.assign(new Error("This contract is already frozen, or the freeze is waiting for approval."), { status: 409 });
  await queue(pool, [{ bond: null, ref: "registry", fn: "pause", args: [], role: "guardian" }]);
}

/**
 * On a contract deployed to replace PREDECESSOR: the imports that copy everything the
 * predecessor holds, in order (issuers, bonds, prior instruments, records), then finishImport.
 * All in one lane, so nothing runs out of order. Holders' device keys move with their records.
 */
async function queueImports(c) {
  const done = (await c.query("select 1 from chain_ops where contract = $1 and fn like 'import%' limit 1", [CONTRACT])).rows.length;
  if (done) return 0;
  const was = (fn) => c.query("select ref, args from chain_ops where contract = $1 and fn = any($2) and status = 'confirmed' order by seq", [PREDECESSOR, fn]);
  const ops = [];
  for (const r of (await was(["registerIssuer", "importIssuer"])).rows)
    ops.push({ bond: null, ref: r.ref, fn: "importIssuer", args: [r.args[0]], role: "relayer" });
  for (const r of (await was(["anchorBond", "importBond"])).rows)
    ops.push({ bond: null, ref: r.ref, fn: "importBond", args: [r.args[0]], role: "relayer" });
  for (const r of (await was(["recordPriorInstrument", "importPrior"])).rows)
    ops.push({ bond: null, ref: r.ref, fn: "importPrior", args: [r.args[0], r.args[1]], role: "relayer" });
  // Every record the predecessor created (issued, assigned out, replacement, or itself imported).
  const recs = (await c.query(`select distinct on (ref) ref, fn, args from chain_ops where contract = $1 and status = 'confirmed'
      and fn in ('issueAssignment', 'assignOut', 'replaceAssignment', 'importRecord') order by ref, seq`, [PREDECESSOR])).rows;
  const recId = (r) => r.fn === "assignOut" ? r.args[2] : r.fn === "replaceAssignment" ? r.args[2] : r.fn === "importRecord" ? r.args[0] : r.args[1];
  for (const r of recs) ops.push({ bond: null, ref: r.ref, fn: "importRecord", args: [recId(r)], role: "relayer" });
  ops.push({ bond: null, ref: "registry", fn: "finishImport", args: [], role: "relayer" });
  await queue(c, ops);
  // From v5 an assign-out is open to its assignee at once; one still waiting arrives open.
  await c.query(`update assignments set data = data || '{"status":"Issued"}'::jsonb, rev = rev + 1
    where data->>'origin' = 'AssignOut' and data->>'status' in ('AwaitingCredential', 'CredentialRequested')`);
  // The register's device keys now belong to this contract (the import copies them, counter included).
  await c.query(`update assignments set data = jsonb_set(data, '{holder,contract}', to_jsonb($1::text))
    where data->'holder'->>'contract' = $2`, [CONTRACT, PREDECESSOR]);
  return ops.length;
}

export async function summary(pool) {
  if (!enabled) return { enabled: false };
  const counts = Object.fromEntries((await pool.query("select status, count(*)::int as n from chain_ops where contract = $1 group by status", [CONTRACT])).rows.map((r) => [r.status, r.n]));
  const failed = (await pool.query("select seq, bond, ref, fn, error, updated_at from chain_ops where status = 'failed' and contract = $1 order by seq limit 20", [CONTRACT])).rows;
  const last = (await pool.query("select tx, updated_at from chain_ops where status = 'confirmed' and tx is not null and contract = $1 order by seq desc limit 1", [CONTRACT])).rows[0] || null;
  const frozen = (await pool.query("select status from chain_ops where contract = $1 and fn = 'pause' order by seq desc limit 1", [CONTRACT])).rows[0]?.status || null;
  return { enabled: true, contract: CONTRACT, explorer: EXPLORER, counts, failed, last, platformSafe: PLATFORM_SAFE,
    predecessor: PREDECESSOR, freeze: frozen };
}
