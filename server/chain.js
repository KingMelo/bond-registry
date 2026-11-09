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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const ABI = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "registry-abi.json"), "utf8"));
export const CONTRACT = process.env.CHAIN_CONTRACT || "";
export const EXPLORER = (process.env.CHAIN_EXPLORER || "https://amoy.polygonscan.com").replace(/\/+$/, "");
export const enabled = !!CONTRACT;
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
export const filingRef = (recordId, filingNumber) => tagged("filing", [recordId, filingNumber]);
export const deliveryRef = (recordId, instrumentMail, passkeyMail) => tagged("delivery", [recordId, instrumentMail, passkeyMail]);
const actionDoc = (recordId, fn, ev) => (ev && isHash(ev.ref) ? ev.ref : tagged("action", [recordId, fn, ev?.eid, ev?.ref]));

/** The register keeps readable filing and mailing numbers; the chain gets their hashes. */
export function normalizeRecord(a) {
  const out = { ...a };
  if (out.filingNumber) out.filingRef = filingRef(out.id, out.filingNumber);
  else if (out.filingRef && !isHash(out.filingRef)) out.filingRef = null;
  if (out.instrumentMail || out.passkeyMail) out.deliveryRef = deliveryRef(out.id, out.instrumentMail, out.passkeyMail);
  else if (out.deliveryRef && !isHash(out.deliveryRef)) out.deliveryRef = null;
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
  create index if not exists chain_ops_open on chain_ops (status, seq);
  create index if not exists chain_ops_ref on chain_ops (ref, seq);
`;

async function queue(c, ops) {
  for (const o of ops) {
    await c.query("insert into chain_ops (bond, ref, fn, args, role, status, error, contract) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [o.bond ?? null, o.ref, o.fn, JSON.stringify(o.args), o.role, o.status || "queued", o.error || null, CONTRACT]);
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
  if ((await c.query("select 1 from chain_ops where fn = 'anchorBond' and ref = $1 and contract = $2", [bondId, CONTRACT])).rows.length) return;
  const row = (await c.query(
    "select b.id, b.data, i.id as issuer_id, i.code from bonds b join issuers i on i.id = b.issuer_id where b.id = $1", [bondId])).rows[0];
  if (!row) return;
  const b = row.data;
  const ops = [];
  if (!(await c.query("select 1 from chain_ops where fn = 'registerIssuer' and ref = $1 and contract = $2", [row.issuer_id, CONTRACT])).rows.length)
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
  if (!(await c.query("select 1 from chain_ops where fn = 'anchorBond' and ref = $1 and contract = $2", [bondId, CONTRACT])).rows.length) return;
  const was = new Map(((before && before.prior) || []).map((p) => [p.id, p]));
  const ops = [];
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
  "AwaitingCredential>CredentialRequested": ["requestCredential", "relayer"],
  "CredentialRequested>AwaitingCredential": ["rejectCredentialRequest", "issuer"],
  "CredentialRequested>Issued": ["issueCredential", "issuer"],
  "AwaitingCredential>Cancelled": [null, null], // depends on who cancelled
  "CredentialRequested>Cancelled": ["issuerCancelAssignOut", "issuer"],
  "Accepted>Locked": ["lock", "relayer"],
  "Locked>Accepted": ["unlock", "issuer"],
  "Accepted>PendingRedemption": ["requestRedemption", "relayer"],
  "PendingRedemption>Redeemed": ["approveRedemption", "issuer"],
  "PendingRedemption>Accepted": ["rejectRedemption", "issuer"],
  "Issued>Rejected": ["rejectAssignment", "relayer"],
};
// The event each call usually comes with, for its document reference.
const EVENT_FOR = {
  accept: "Accepted", requestCredential: "CredentialRequested", rejectCredentialRequest: "CredentialRequestRejected",
  issueCredential: "CredentialIssued", cancelAssignOut: "AssignOutCancelled", issuerCancelAssignOut: "AssignOutCancelled",
  lock: "Locked", unlock: "Unlocked", requestRedemption: "RedemptionRequested", approveRedemption: "Redeemed",
  rejectRedemption: "RedemptionRejected", recordRotation: "PasskeyRotated", rejectAssignment: "AssignmentRejected",
};

/**
 * The contract calls that one save of assignment records implies.
 * `before` maps record id → stored data (undefined for new records); `after` is what was saved.
 */
export async function queueRecordChanges(c, { app, before, after, events }) {
  if (!enabled || !after.length) return;
  const evFor = (id, name) => events.find((e) => e.id === id && e.ev === name);
  const created = [], refs = [], moves = [];
  for (const a of after) {
    const o = before.get(a.id), B = id32(a.bond), A = id32(a.id);
    if (!o) {
      if (a.origin === "AssignOut")
        created.push({ bond: a.bond, ref: a.id, fn: "assignOut", args: [B, id32(a.parent), A, String(a.units), a.docHash], role: "relayer" });
      else if (a.origin === "Replacement")
        created.push({ bond: a.bond, ref: a.id, fn: "replaceAssignment", args: [B, id32(a.parent), A, a.docHash], role: "issuer" });
      else
        created.push({ bond: a.bond, ref: a.id, fn: "issueAssignment", args: [B, A, String(a.units), a.docHash], role: "issuer" });
    }
    if (a.filingRef && a.filingRef !== o?.filingRef)
      refs.push({ bond: a.bond, ref: a.id, fn: "setFilingRef", args: [B, A, a.filingRef], role: "issuer" });
    if (a.deliveryRef && a.deliveryRef !== o?.deliveryRef)
      refs.push({ bond: a.bond, ref: a.id, fn: "setDeliveryRef", args: [B, A, a.deliveryRef], role: "issuer" });
    if (o && o.status !== a.status && !IMPLIED.has(a.status)) {
      let [fn, role] = TRANSITIONS[o.status + ">" + a.status] || [undefined, undefined];
      if (fn === null) [fn, role] = app === "holder" ? ["cancelAssignOut", "relayer"] : ["issuerCancelAssignOut", "issuer"];
      if (!fn) {
        moves.push({ bond: a.bond, ref: a.id, fn: "unsupported", args: [], role: "issuer", status: "failed",
          error: `No contract call moves a record from ${o.status} to ${a.status}.` });
      } else {
        moves.push({ bond: a.bond, ref: a.id, fn, args: [B, A, actionDoc(a.id, fn, evFor(a.id, EVENT_FOR[fn]))], role });
      }
    }
    // A passkey reissued on a locked record: the status stays Locked.
    const rot = o && o.status === "Locked" && a.status === "Locked" && evFor(a.id, "PasskeyRotated");
    if (rot) moves.push({ bond: a.bond, ref: a.id, fn: "recordRotation", args: [B, A, actionDoc(a.id, "recordRotation", rot)], role: "issuer" });
  }
  // New records first (a cancel or replacement can refer to them), then references (a credential
  // needs its UCC-3 on record first), then status changes.
  await queue(c, [...created, ...refs, ...moves]);
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
  if (a.deliveryRef && isHash(a.deliveryRef)) ops.push({ bond: a.bond, ref: a.id, fn: "setDeliveryRef", args: [B, A, a.deliveryRef], role: "issuer" });
  if (a.status === "Accepted") ops.push({ bond: a.bond, ref: a.id, fn: "accept", args: [B, A, tagged("action", [a.id, "accept", "replay", ""])], role: "relayer" });
  if (a.status === "Rejected") ops.push({ bond: a.bond, ref: a.id, fn: "rejectAssignment", args: [B, A, tagged("action", [a.id, "rejectAssignment", "replay", a.rejectionReason])], role: "relayer" });
  return ops;
}

export async function queueIssuerStatus(c, issuerId, code, status) {
  if (!enabled) return;
  if (!(await c.query("select 1 from chain_ops where fn = 'registerIssuer' and ref = $1 and contract = $2", [issuerId, CONTRACT])).rows.length) return;
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
    else if (o.status === "queued" || o.status === "sent") { if (s.state !== "failed") s.state = "pending"; s.pending++; }
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
  issuerCancelAssignOut: 9, lock: 5, unlock: 4, requestRedemption: 6, approveRedemption: 7, rejectRedemption: 4,
  rejectAssignment: 10 };

/** True when the chain already shows the op's effect, so it must not be sent again. */
async function alreadyDone(reg, op, signer) {
  const a = op.args;
  switch (op.fn) {
    case "registerIssuer": {
      const i = await reg.issuers(a[0]);
      if (i.account === ethers.ZeroAddress) return false;
      if (i.account.toLowerCase() !== signer.toLowerCase()) throw new Error("Issuer is registered on-chain to " + i.account + ", not this signer.");
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
    case "setDeliveryRef": return (await reg.assignments(a[1])).deliveryRef === a[2];
    case "suspendIssuer": return (await reg.issuers(a[0])).suspended;
    case "reinstateIssuer": return !(await reg.issuers(a[0])).suspended;
    case "recordRotation": return false;
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
      const rows = (await c.query(`select b.id from bonds b join issuers i on i.id = b.issuer_id
        where b.review = 'approved' and i.status in ('approved','suspended')
          and not exists (select 1 from chain_ops o where o.fn = 'anchorBond' and o.ref = b.id and o.contract = $1) order by b.id`, [CONTRACT])).rows;
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

  async function next() {
    // The oldest open op whose bond has nothing failed.
    return (await pool.query(`
      select * from chain_ops o where o.contract = $1 and o.status in ('queued','sent')
        and not exists (select 1 from chain_ops f where f.contract = $1 and f.status = 'failed' and f.bond is not distinct from o.bond and f.seq < o.seq)
      order by o.seq limit 1`, [CONTRACT])).rows[0];
  }
  const mark = (op, fields) => {
    const keys = Object.keys(fields);
    return pool.query(`update chain_ops set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where seq = $1`,
      [op.seq, ...keys.map((k) => fields[k])]);
  };

  async function handle(op) {
    if (typeof reg[op.fn] !== "function" || (op.fn === "anchorBond" && !op.args.length))
      return mark(op, { status: "failed", error: op.error || "Nothing to send for " + op.fn + "." });
    const args = op.args.map((x) => (x === "$SIGNER" ? wallet.address : x));
    const opx = { ...op, args };
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

  async function tick() {
    if (busy || stopped) return;
    if (wait > 0) { wait--; return; }
    busy = true;
    try {
      for (let i = 0; i < 25; i++) {
        const op = await next();
        if (!op) break;
        await handle(op);
        const after = (await pool.query("select status from chain_ops where seq = $1", [op.seq])).rows[0];
        if (after?.status === "sent") break; // still waiting on it
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

export async function summary(pool) {
  if (!enabled) return { enabled: false };
  const counts = Object.fromEntries((await pool.query("select status, count(*)::int as n from chain_ops where contract = $1 group by status", [CONTRACT])).rows.map((r) => [r.status, r.n]));
  const failed = (await pool.query("select seq, bond, ref, fn, error, updated_at from chain_ops where status = 'failed' and contract = $1 order by seq limit 20", [CONTRACT])).rows;
  const last = (await pool.query("select tx, updated_at from chain_ops where status = 'confirmed' and tx is not null and contract = $1 order by seq desc limit 1", [CONTRACT])).rows[0] || null;
  return { enabled: true, contract: CONTRACT, explorer: EXPLORER, counts, failed, last };
}
