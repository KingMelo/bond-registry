// Reads the registry contract straight from the blockchain, in the visitor's browser.
// Nothing here goes through the platform's own server or database: the page is given the
// contract address and a public RPC endpoint, and everything else comes from the chain.
import { JsonRpcProvider, Contract, Interface, keccak256, toUtf8Bytes, ZeroHash } from "ethers";
import ABI from "../server/registry-abi.json";

export const id32 = (s) => keccak256(toUtf8Bytes(String(s).trim().toUpperCase()));
export const STATUS = ["None", "AwaitingCredential", "CredentialRequested", "Issued", "Accepted", "Locked",
  "PendingRedemption", "Redeemed", "Superseded", "Cancelled", "Rejected"];
const ORIGIN = ["Issuer", "AssignOut", "Replacement"];
const iface = new Interface(ABI);

const cache = new Map();
function contractFor(info) {
  const key = info.rpc + "|" + info.contract;
  if (!cache.has(key)) {
    const provider = new JsonRpcProvider(info.rpc, info.chainId || undefined, info.chainId ? { staticNetwork: true } : undefined);
    cache.set(key, { provider, reg: new Contract(info.contract, ABI, provider) });
  }
  return cache.get(key);
}

/** A bond display ID is the start of an assignment ID: KJPII-0001-BD-A00001 → KJPII-0001-BD. */
export const bondOf = (displayId) => String(displayId).trim().toUpperCase().replace(/-A\d+$/, "");
export const looksLikeRecord = (s) => /-A\d+$/i.test(String(s).trim());

export async function readBond(info, displayId) {
  const { reg } = contractFor(info);
  const bondId = id32(displayId);
  const b = await reg.bonds(bondId);
  if (b.issuerId === ZeroHash) return null;
  const t = await reg.bondTotals(bondId);
  return {
    id: String(displayId).trim().toUpperCase(), bondId, issuerId: b.issuerId,
    instrumentHash: b.instrumentHash, ucc1Ref: b.ucc1Ref, anchoredAt: Number(b.anchoredAt),
    total: Number(t[0]), prior: Number(t[1]), live: Number(t[2]), unassigned: Number(t[3]), redeemed: Number(t[4]),
    reconciled: t[5],
  };
}

export async function readRecord(info, displayId) {
  const { reg } = contractFor(info);
  const id = id32(displayId);
  const a = await reg.assignments(id);
  if (Number(a.status) === 0) return null;
  // The record's bond, by its own hash: only accept the display ID if it hashes to the same thing.
  const bondDisplay = bondOf(displayId);
  const bond = a.bondId === id32(bondDisplay) ? await readBond(info, bondDisplay) : null;
  return {
    id: String(displayId).trim().toUpperCase(), recordId: id, bondId: a.bondId, bond,
    parentId: a.parentId === ZeroHash ? null : a.parentId,
    units: Number(a.units), pendingChildren: Number(a.pendingChildren),
    origin: ORIGIN[Number(a.origin)], status: STATUS[Number(a.status)], updatedAt: Number(a.updatedAt),
    docHash: a.docHash, filingRef: a.filingRef === ZeroHash ? null : a.filingRef,
    deliveryRef: a.deliveryRef === ZeroHash ? null : a.deliveryRef,
  };
}

/** Finds which of the given display IDs hashes to `hash`, so a parent can be named. */
export const nameFor = (hash, candidates) => candidates.find((c) => id32(c) === hash) || null;

// Plain-language names for the contract's events.
const SAY = {
  AssignmentIssued: "Issued by the issuer", Accepted: "Took effect", AssignedOut: "Assigned out",
  AssignOutCancelled: "Assign-out cancelled", CredentialRequested: "New holder requested access",
  CredentialRequestRejected: "Access request rejected", CredentialIssued: "New holder activated by the issuer",
  Locked: "Locked by the holder", Unlocked: "Unlocked by the issuer", PasskeyRotated: "Passkey reissued",
  RedemptionRequested: "Redemption requested", Redeemed: "Redeemed and retired", RedemptionRejected: "Redemption declined",
  AssignmentReplaced: "Replaced by a new record", Superseded: "Closed (superseded)", FilingRecorded: "UCC-3 filing recorded",
  DeliveryRecorded: "Certified mailing recorded", BondAnchored: "Bond anchored",
  PriorInstrumentRecorded: "Prior instrument recorded", PriorInstrumentReversed: "Prior instrument reversed",
  AssignmentRejected: "Rejected by the holder",
};

/**
 * Every event that names this record, oldest first, with its block time and transaction.
 * Searched in block ranges, because public endpoints cap how far one query may reach.
 */
export async function history(info, recordId, { step = 49_999, maxRanges = 60 } = {}) {
  const { provider } = contractFor(info);
  const latest = await provider.getBlockNumber();
  const from = Number(info.fromBlock || 0);
  const ranges = [];
  for (let start = Math.max(from, latest - step * maxRanges); start <= latest; start += step + 1)
    ranges.push([start, Math.min(latest, start + step)]);
  const logs = [];
  for (const [fromBlock, toBlock] of ranges) {
    const q = { address: info.contract, fromBlock, toBlock };
    // The record is the second indexed field of most events, and the third (the child) of AssignedOut.
    const [a, b] = await Promise.all([
      provider.getLogs({ ...q, topics: [null, null, recordId] }),
      provider.getLogs({ ...q, topics: [null, null, null, recordId] }),
    ]);
    logs.push(...a, ...b);
  }
  const seen = new Set(), out = [];
  for (const l of logs.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index)) {
    const key = l.transactionHash + ":" + l.index;
    if (seen.has(key)) continue;
    seen.add(key);
    let parsed = null;
    try { parsed = iface.parseLog(l); } catch { /* not ours */ }
    if (!parsed) continue;
    const childSide = parsed.name === "AssignedOut" && parsed.args[2] === recordId;
    out.push({
      name: parsed.name, label: childSide ? "Created by an assign-out" : SAY[parsed.name] || parsed.name,
      block: l.blockNumber, tx: l.transactionHash,
      docHash: parsed.fragment.inputs.some((i) => i.name === "docHash") ? parsed.args.docHash : null,
    });
  }
  const times = new Map();
  await Promise.all([...new Set(out.map((e) => e.block))].map(async (n) => {
    const blk = await provider.getBlock(n);
    times.set(n, blk ? Number(blk.timestamp) : null);
  }));
  return out.map((e) => ({ ...e, time: times.get(e.block) }));
}

export async function sha256Hex(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const when = (sec) => (sec ? new Date(sec * 1000).toLocaleString("en-US",
  { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "—");
