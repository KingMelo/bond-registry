// The register's mirror on Canton (pilot). Off unless CANTON_JSON_URL is set.
//
// The register stays in control; Canton gets one contract per assignment, seen only by its parties:
//   - an issuer-made assignment becomes an AssignmentOffer from the issuer's party (issuer service);
//   - when the assignee sets up, their browser makes a device key (non-extractable) and a recovery
//     key (shown once as a code, then forgotten). The assignee's Canton party is rooted in the
//     recovery key; the device key may sign and manage the party's keys. The node holds neither.
//   - the assignee's acts in the register (accepting, rejecting, assigning out, taking back units
//     from a rejected assign-out) are then signed on Canton with their device key;
//   - with the recovery code, a new device can be added, or a lost one replaced.
//
// Every topology change and transaction is built by the node and signed in the browser; this
// module only carries them. The page checks each transaction against its hash before signing. Settings:
//   CANTON_JSON_URL   the node's JSON Ledger API, e.g. http://localhost:7575
//   CANTON_ADMIN      its admin API (gRPC), e.g. localhost:6866
//   CANTON_PROTOS     a folder with the admin API's .proto files (from the Daml SDK's canton.jar)
//   CANTON_USER       the ledger user to submit as (default participant_admin)
import path from "node:path";
import crypto from "node:crypto";

const API = (process.env.CANTON_JSON_URL || "").replace(/\/+$/, "");
export const enabled = !!API;
const USER = process.env.CANTON_USER || "participant_admin";
const PKG = process.env.CANTON_PACKAGE || "#bond-registry";
const ALGO = "SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256";
const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);

export const SCHEMA = `
  -- The Canton contract each bond or record currently maps to.
  create table if not exists canton_refs (ref text primary key, template text not null, cid text not null,
    updated_at timestamptz not null default now());
  -- The node's own parties: the platform and each issuer.
  create table if not exists canton_parties (name text primary key, party text not null);
  -- Each assignee's external party and its keys (public halves only).
  create table if not exists canton_holders (record text primary key, party text not null, keys jsonb not null,
    updated_at timestamptz not null default now());
`;

// The server's own writes for one bond go to Canton one at a time: two passes acting on the same
// contract at once would have one of them refused (the other just replaced it).
const queues = new Map();
function onBond(bondId, fn) {
  const prev = queues.get(bondId) || Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(bondId, run.catch(() => {}));
  return run;
}

class CantonError extends Error { constructor(m, status = 502) { super(m); this.status = status; } }

async function json(method, p, body) {
  const r = await fetch(API + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new CantonError("Canton refused " + p.split("/").slice(-2).join("/") + ": " + String(j.cause || j.raw || JSON.stringify(j)).slice(0, 300), r.status === 400 ? 422 : 502);
  return j;
}

// ---- the admin API (topology), loaded on first use
let admin = null;
async function adminApi() {
  if (admin) return admin;
  const dir = process.env.CANTON_PROTOS;
  if (!dir || !process.env.CANTON_ADMIN) throw new CantonError("Canton's admin API isn't configured (CANTON_ADMIN, CANTON_PROTOS).", 503);
  const [{ default: grpc }, { default: loader }, { default: protobuf }] = await Promise.all([import("@grpc/grpc-js"), import("@grpc/proto-loader"), import("protobufjs")]);
  const def = loader.loadSync("com/digitalasset/canton/topology/admin/v30/topology_manager_write_service.proto",
    { includeDirs: [dir], keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  const Svc = grpc.loadPackageDefinition(def).com.digitalasset.canton.topology.admin.v30.TopologyManagerWriteService;
  const client = new Svc(process.env.CANTON_ADMIN, grpc.credentials.createInsecure());
  const root = new protobuf.Root();
  root.resolvePath = (_, target) => path.join(dir, target);
  root.loadSync("com/digitalasset/canton/protocol/v30/topology.proto", { keepCase: true });
  admin = {
    rpc: (m, req) => new Promise((res, rej) => client[m](req, (e, r) => (e ? rej(new CantonError("Canton refused the key change: " + (e.details || e.message), 422)) : res(r)))),
    Tx: root.lookupType("com.digitalasset.canton.protocol.v30.TopologyTransaction"),
  };
  return admin;
}

let syncId = null;
async function sync() {
  if (syncId) return syncId;
  syncId = (await json("GET", "/v2/state/connected-synchronizers")).connectedSynchronizers?.[0]?.synchronizerId;
  if (!syncId) throw new CantonError("The Canton node isn't connected to a synchronizer yet.", 503);
  return syncId;
}

/** The node's party for a name (the platform, or an issuer), made the first time it's needed. */
async function localParty(pool, name) {
  const got = (await pool.query("select party from canton_parties where name = $1", [name])).rows[0];
  if (got) return got.party;
  // A node outlives any one register (and is shared on a network), so names get a unique suffix.
  const hint = name.replace(/[^A-Za-z0-9-]/g, "-") + "-" + crypto.randomUUID().slice(0, 8);
  const party = (await json("POST", "/v2/parties", { partyIdHint: hint, identityProviderId: "" })).partyDetails.party;
  await json("POST", "/v2/users/" + USER + "/rights", { userId: USER, identityProviderId: "", rights: [{ kind: { CanActAs: { value: { party } } } }] });
  await pool.query("insert into canton_parties (name, party) values ($1, $2) on conflict (name) do nothing", [name, party]);
  return (await pool.query("select party from canton_parties where name = $1", [name])).rows[0].party;
}

const refOf = async (pool, ref) => (await pool.query("select template, cid from canton_refs where ref = $1", [ref])).rows[0] || null;
const setRef = (pool, ref, template, cid) => pool.query(
  `insert into canton_refs (ref, template, cid) values ($1, $2, $3)
   on conflict (ref) do update set template = excluded.template, cid = excluded.cid, updated_at = now()`, [ref, template, cid]);

async function submit(actAs, commands) {
  return json("POST", "/v2/commands/submit-and-wait-for-transaction", {
    commands: { commands, commandId: crypto.randomUUID(), userId: USER, actAs, synchronizerId: await sync() } });
}
const createdOf = (tx, tpl) => tx.transaction.events.map((e) => e.CreatedEvent).filter(Boolean).find((e) => e.templateId.endsWith(":Registry:" + tpl));
const tpl = (name) => PKG + ":Registry:" + name;

// ------------------------------------------------------------------ the issuer's side

/**
 * Issuer-made records just saved in the register: each becomes an offer on Canton. A bond goes on
 * Canton with its first such record; assignments from before the mirror was switched on aren't copied.
 */
export async function mirrorIssued(pool, records) {
  for (const bondId of [...new Set(records.map((r) => r.bond))])
    await onBond(bondId, () => mirrorIssuedOn(pool, records.filter((r) => r.bond === bondId), records));
}
async function mirrorIssuedOn(pool, mine) {
  // A bond's first assignment on Canton brings the bond, and every live assignment already on it.
  if (!(await refOf(pool, mine[0].bond))) return backfillNow(pool, mine[0].bond);
  for (const rec of mine) {
    if (await refOf(pool, rec.id)) continue;
    await issueOne(pool, rec, Number(rec.units));
  }
}

async function issueOne(pool, rec, units) {
  const issuer = await issuerPartyOf(pool, rec.bond), bond = await refOf(pool, rec.bond);
  const tx = await submit([issuer], [{ ExerciseCommand: { templateId: tpl("Bond"), contractId: bond.cid, choice: "Issue", choiceArgument: {
    recordId: rec.id, units: String(units), docHash: rec.docHash, ucc3Hash: isHash(rec.filingDoc) ? rec.filingDoc : null,
    assigneeName: rec.party || "", assignee: null } } }]);
  await setRef(pool, rec.bond, "Bond", createdOf(tx, "Bond").contractId);
  await setRef(pool, rec.id, "AssignmentOffer", createdOf(tx, "AssignmentOffer").contractId);
}

// ------------------------------------------------------------------ records from before the mirror

const LIVE = ["Issued", "Accepted", "Locked"];
// What a record is replayed on Canton with: what it holds now, plus what each of its live assign-outs
// holds (each is then assigned out from it again, with its holder's key).
async function replayedUnits(pool, rec) {
  const kids = (await pool.query(`select data from assignments where data->>'parent' = $1 and data->>'origin' = 'AssignOut'`, [rec.id])).rows.map((r) => r.data);
  let n = Number(rec.units);
  for (const c of kids) if (LIVE.includes(c.status)) n += await replayedUnits(pool, c);
  return n;
}

/**
 * A bond that isn't on Canton yet, with whatever the register already holds for it: the bond, its
 * prior instruments, an offer for each live assignment the issuer made (holding what it and its
 * live assign-outs hold), and the issuer's own facts on them. What needs an assignee's own key
 * (accepting, assigning out, locking) waits for them, as any act does. Records whose signed paper
 * isn't on the register in full are left off and reported, rather than guessed at.
 */
export const backfill = (pool, bondId) => onBond(bondId, () => backfillNow(pool, bondId));
async function backfillNow(pool, bondId) {
  if (await refOf(pool, bondId)) return { bondId, already: true };
  const b = (await pool.query("select b.data, b.review, i.code from bonds b join issuers i on i.id = b.issuer_id where b.id = $1", [bondId])).rows[0];
  if (!b || b.review !== "approved" || !isHash(b.data.instrumentHash) || !isHash(b.data.ucc1?.hash)) return { bondId, skipped: "the bond isn't approved with its papers' fingerprints" };
  const roots = (await pool.query(`select data from assignments where bond = $1 and data->>'origin' in ('Issuer', 'Replacement')
    and data->>'status' = any($2) order by id`, [bondId, LIVE])).rows.map((r) => r.data);
  const recordIdOk = (id) => new RegExp("^" + bondId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-A\\d{5}$").test(id);
  const ok = [], left = [];
  for (const r of roots) (isHash(r.docHash) && recordIdOk(r.id) ? ok : left).push(r);
  const units = new Map();
  for (const r of ok) units.set(r.id, await replayedUnits(pool, r));
  const priorHeld = (b.data.prior || []).filter((p) => !p.reversed).reduce((t, p) => t + Number(p.units), 0);
  const issuing = [...units.values()].reduce((t, n) => t + n, 0);
  const issuer = await localParty(pool, "issuer-" + b.code), platform = await localParty(pool, "platform");
  const tx = await submit([issuer, platform], [{ CreateCommand: { templateId: tpl("Bond"), createArguments: {
    issuer, platform, bondId, total: String(b.data.total), unassigned: String(Number(b.data.unassigned) + issuing + priorHeld),
    redeemed: String(b.data.redeemed || 0), prior: "0", instrumentHash: b.data.instrumentHash, ucc1Hash: b.data.ucc1.hash, observers: [] } } }]);
  await setRef(pool, bondId, "Bond", createdOf(tx, "Bond").contractId);
  await syncBondNow(pool, bondId);
  for (const r of ok) await issueOne(pool, r, units.get(r.id));
  await syncIssuerFactsOn(pool, ok.map((r) => r));
  const out = { bondId, issued: ok.map((r) => r.id), left: left.map((r) => r.id) };
  if (left.length) console.log("Canton: left off " + bondId + " (no full signed-paper fingerprint): " + out.left.join(", "));
  return out;
}

/** Every approved bond with live assignments that isn't on Canton yet: run when the issuer service starts. */
export async function backfillAll(pool) {
  const ids = (await pool.query(`select b.id from bonds b where b.review = 'approved'
    and exists (select 1 from assignments a where a.bond = b.id and a.data->>'status' = any($1))
    and not exists (select 1 from canton_refs r where r.ref = b.id)`, [LIVE])).rows.map((r) => r.id);
  const done = [];
  for (const id of ids) done.push(await backfill(pool, id).catch((e) => ({ bondId: id, error: e.message })));
  return done;
}

/**
 * The issuer's own acts, after a save, go on Canton as the issuer's party (held by the node), so
 * nobody else is asked to sign: the certified mailing and UCC-3 of an assignment it made, an unlock,
 * a redemption (with the payment confirmation's fingerprint), a replacement and cancelling a
 * disputed assign-out;
 * and the platform's note that an offer went unanswered past its response period.
 * Each is compared with what Canton holds, so it's recorded once.
 */
export async function syncIssuerFacts(pool, records) {
  for (const bondId of [...new Set(records.map((r) => r.bond))])
    await onBond(bondId, () => syncIssuerFactsOn(pool, records.filter((r) => r.bond === bondId)));
}
async function syncIssuerFactsOn(pool, records) {
  for (const rec of records) {
    const ref = await refOf(pool, rec.id);
    if (ref?.template !== "AssignmentOffer" && ref?.template !== "Assignment") continue;
    const issuer = await issuerPartyOf(pool, rec.bond);
    const on = async () => (await heldOnCanton(pool, rec.bond)).get(rec.id);
    let now = await on();
    if (!now) continue;
    const act = async (choice, choiceArgument) => {
      const tx = await submit([issuer], [{ ExerciseCommand: { templateId: tpl(now.template), contractId: now.cid, choice, choiceArgument } }]);
      now = await on();
      return tx;
    };
    const issuerMade = rec.origin === "Issuer" || rec.origin === "Replacement";
    if (issuerMade && rec.deliveryRef && now.deliveryRef == null && now.template === "AssignmentOffer")
      await act("RecordMailing", { sentOn: asTime(rec.mailedOn || rec.deliveredAt), mailingRef: rec.deliveryRef });
    // The response period passed with no authenticated answer: noted by the platform, after the mailing it runs from.
    if (rec.noResponseAsOf && now?.template === "AssignmentOffer" && now.noResponseAsOf == null && now.mailedOn != null) {
      const platform = await localParty(pool, "platform");
      await submit([platform], [{ ExerciseCommand: { templateId: tpl("AssignmentOffer"), contractId: now.cid, choice: "RecordNoResponse", choiceArgument: {} } }]);
      now = await on();
    }
    if (issuerMade && isHash(rec.filingDoc) && now && now.ucc3Hash == null)
      await act(now.template === "Assignment" ? "RecordUcc3OnAssignment" : "RecordUcc3", { filedHash: rec.filingDoc });
    if (now?.template === "Assignment" && now.locked != null && rec.status === "Accepted")
      await act("Unlock", { release: rec.unlockRef || "Unlocked by the issuer" });
    if (now?.template === "Assignment" && rec.status === "Redeemed" && isHash(rec.redemptionHash)) {
      const bond = await refOf(pool, rec.bond);
      const tx = await act("Redeem", { paymentHash: rec.redemptionHash, bondCid: bond.cid });
      const nb = createdOf(tx, "Bond");
      if (nb) await setRef(pool, rec.bond, "Bond", nb.contractId);
      await setRef(pool, rec.id, "Closed", "-");
      continue;
    }
    // Replaced by the issuer: the new record's offer takes its place on Canton, same amount, new paper.
    if (now && rec.status === "Superseded") {
      const nu = (await pool.query(`select data from assignments where data->>'parent' = $1 and data->>'origin' = 'Replacement'`, [rec.id])).rows[0]?.data;
      if (nu && isHash(nu.docHash)) {
        const tx = await act(now.template === "Assignment" ? "SupersedeAssignment" : "SupersedeOffer", {
          newRecordId: nu.id, newHash: nu.docHash, newAssigneeName: nu.party || "",
          reasonHash: isHash(rec.supersededDoc) ? rec.supersededDoc : fp("reason", [rec.id, "replaced"]) });
        await setRef(pool, nu.id, "AssignmentOffer", createdOf(tx, "AssignmentOffer").contractId);
        await setRef(pool, rec.id, "Closed", "-");
        continue;
      }
    }
    if (now?.template === "AssignmentOffer" && rec.status === "Cancelled" && rec.cancelledBy === "issuer" && rec.origin === "AssignOut") {
      const tx = await act("IssuerCancel", { reason: rec.cancelReason || "Cancelled by the issuer" });
      await setRef(pool, rec.id, "UnitsReturned", createdOf(tx, "UnitsReturned").contractId); // its assignor takes the units back
      continue;
    }
    await refresh(pool, issuer, rec.id);
  }
}

/** The response period passed with no authenticated answer: brought onto the offer with everything else it waits on. */
export async function recordNoResponse(pool, recordId) {
  const rec = (await pool.query("select data from assignments where id = $1", [recordId])).rows[0]?.data;
  if (rec) await syncIssuerFacts(pool, [rec]);
}

/** A safety net, run with the 30-day job: offers whose no-response note hasn't reached Canton yet. */
export async function catchUpNoResponse(pool) {
  const recs = (await pool.query(`select a.data from assignments a join canton_refs r on r.ref = a.id
    where a.data->>'status' = 'Issued' and a.data->>'noResponseAsOf' is not null and r.template = 'AssignmentOffer' limit 50`)).rows.map((x) => x.data);
  if (recs.length) await syncIssuerFacts(pool, recs);
}

// ------------------------------------------------------------------ prior instruments

const fp = (kind, values) => "0x" + crypto.createHash("sha256").update(JSON.stringify(["BondInterestRegistry/" + kind + "/v2", ...values.map(String)])).digest("hex");
// A prior instrument's identifier as a fingerprint; who holds it stays in the register.
const priorFp = (bondId, ref) => fp("prior", [bondId, String(ref).trim().toUpperCase()]);

/**
 * A bond's prior instruments, after the issuer saves it: each one the register has goes on Canton
 * (its amount off what's left to assign), and each one reversed in the register is reversed there,
 * with its reason's fingerprint. Compared with what Canton holds, so each happens once.
 */
export const syncBond = (pool, bondId) => onBond(bondId, () => syncBondNow(pool, bondId));
async function syncBondNow(pool, bondId) {
  let bond = await refOf(pool, bondId);
  if (bond?.template !== "Bond") return;
  const data = (await pool.query("select data from bonds where id = $1", [bondId])).rows[0]?.data;
  if (!data) return;
  const issuer = await issuerPartyOf(pool, bondId);
  const all = await activeFor(issuer);
  const live = new Map(all.filter((e) => e.templateId.endsWith(":Registry:PriorInstrument") && e.createArgument.bondId === bondId).map((e) => [e.createArgument.entryId, e]));
  const reversed = new Set(all.filter((e) => e.templateId.endsWith(":Registry:PriorReversed") && e.createArgument.bondId === bondId).map((e) => e.createArgument.entryId));
  for (const p of data.prior || []) {
    let tx = null;
    if (!p.reversed && !live.has(p.id) && !reversed.has(p.id))
      tx = await submit([issuer], [{ ExerciseCommand: { templateId: tpl("Bond"), contractId: bond.cid, choice: "RecordPrior",
        choiceArgument: { entryId: p.id, identifierHash: priorFp(bondId, p.ref), units: String(p.units) } } }]);
    else if (p.reversed && live.has(p.id))
      tx = await submit([issuer], [{ ExerciseCommand: { templateId: tpl("Bond"), contractId: bond.cid, choice: "ReversePrior",
        choiceArgument: { priorCid: live.get(p.id).contractId, reasonHash: fp("reason", [bondId, p.id, p.reversedReason || ""]) } } }]);
    if (tx) { bond = { cid: createdOf(tx, "Bond").contractId }; await setRef(pool, bondId, "Bond", bond.cid); }
  }
}

// ------------------------------------------------------------------ the assignee's keys

const jsonKey = (spki) => ({ format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO", keyData: spki, keySpec: "SIGNING_KEY_SPEC_EC_P256" });
async function topologyFor(spki, hint) {
  return json("POST", "/v2/parties/external/generate-topology", { synchronizer: await sync(), partyHint: hint,
    localParticipantObservationOnly: false, confirmationThreshold: 1, publicKey: jsonKey(spki) });
}
// A key's fingerprint, as Canton computes it (asking the node is the one sure way).
const fingerprintOf = async (spki) => (await topologyFor(spki, "fp-" + crypto.randomUUID().slice(0, 8))).publicKeyFingerprint;

const STORE = () => ({ synchronizer: { id: syncId } });
const PROTOCOL_USAGE = ["SIGNING_KEY_USAGE_NAMESPACE", "SIGNING_KEY_USAGE_PROOF_OF_OWNERSHIP", "SIGNING_KEY_USAGE_PROTOCOL"];
const protoKey = (spki, usage) => ({ format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO", public_key: Buffer.from(spki, "base64"),
  scheme: "SIGNING_KEY_SCHEME_UNSPECIFIED", usage, key_spec: "SIGNING_KEY_SPEC_EC_P256" });
const delegation = (ns, spki) => ({ namespace_delegation: { namespace: ns, target_key: protoKey(spki, ["SIGNING_KEY_USAGE_NAMESPACE"]), can_sign_all_mappings: {} } });
const keyMapping = (party, keys) => ({ party_to_key_mapping: { party, threshold: 1, signing_keys: keys.map((k) => protoKey(k.spki, PROTOCOL_USAGE)) } });

/** Asks the node to build topology changes; returns their hashes, to be signed in the browser. */
async function generate(proposals) {
  const { rpc } = await adminApi();
  await sync();
  const g = await rpc("GenerateTransactions", { proposals: proposals.map(([operation, mapping]) => ({ operation, serial: 0, mapping, store: STORE() })) });
  return g.generated_transactions.map((t) => ({ tx: t.serialized_transaction, hash: t.transaction_hash }));
}
async function addSigned(generated, signatures) {
  const { rpc } = await adminApi();
  await rpc("AddTransactions", { store: STORE(), force_changes: [], wait_to_become_effective: { seconds: 15 },
    transactions: generated.map((g, i) => ({ transaction: g.tx, proposal: false,
      signatures: (signatures[i] || []).map((s) => ({ format: "SIGNATURE_FORMAT_DER", signature: Buffer.from(s.signature, "base64"),
        signed_by: s.signedBy, signing_algorithm_spec: ALGO })) })) });
}

// Steps of a key setup or change wait here between the server and the browser (a few minutes at most).
const steps = new Map();
const step = (id, v) => { steps.set(id, { ...v, exp: Date.now() + 10 * 60_000 }); };
const stepOf = (id, kind) => {
  const s = steps.get(id);
  if (!s || s.kind !== kind || s.exp < Date.now()) throw new CantonError("That step took too long or was already used. Start again.", 409);
  return s;
};

export const holderOf = async (pool, recordId) => (await pool.query("select party, keys from canton_holders where record = $1", [recordId])).rows[0] || null;

/**
 * What the assignee's page shows: whether this record is on Canton, its party and keys, and what's
 * waiting for their key: acts already made in the register that Canton doesn't have yet.
 */
export async function status(pool, rec) {
  const ref = await refOf(pool, rec.id), holder = await holderOf(pool, rec.id);
  return { enabled: true, onCanton: !!ref, contract: ref?.template || null, party: holder?.party || null,
    keys: (holder?.keys || []).map(({ fp, role, label, added }) => ({ fp, role, label, added })),
    toSign: holder ? await waiting(pool, rec, ref) : [] };
}

// The register's acts on this record (and the assign-outs it made) not yet on Canton, in order:
// compared with what Canton itself holds, so nothing is signed twice or missed.
async function waiting(pool, rec, ref) {
  const out = [];
  const held = await heldOnCanton(pool, rec.bond);
  const mine = held.get(rec.id);
  const live = ref?.template === "AssignmentOffer" || ref?.template === "Assignment";
  if (live && rec.receiptRef && mine && mine.receiptRef == null && rec.status !== "Rejected") out.push({ kind: "receipt" });
  if (ref?.template === "AssignmentOffer" && (rec.status === "Accepted" || rec.status === "Locked")) out.push({ kind: "accept" });
  if (ref?.template === "AssignmentOffer" && rec.status === "Rejected") out.push({ kind: "reject" });
  if (ref?.template === "Assignment") {
    const kids = (await pool.query(`select data from assignments where data->>'parent' = $1 and data->>'origin' = 'AssignOut' order by created_at`, [rec.id])).rows.map((r) => r.data);
    for (const c of kids) {
      const cref = await refOf(pool, c.id), on = held.get(c.id);
      if (!cref) { if (LIVE.includes(c.status)) out.push({ kind: "assignOut", child: c.id }); continue; }
      if (cref.template === "UnitsReturned") { out.push({ kind: "reclaim", child: c.id }); continue; }
      if (cref.template === "AssignmentOffer" && c.status === "Cancelled" && c.cancelledBy === "assignor") { out.push({ kind: "cancelOut", child: c.id }); continue; }
      if (cref.template === "AssignmentOffer" && c.deliveryRef && on && on.deliveryRef == null) out.push({ kind: "mailing", child: c.id });
      if ((cref.template === "AssignmentOffer" || cref.template === "Assignment") && isHash(c.filingDoc) && on && on.ucc3Hash == null)
        out.push({ kind: "ucc3", child: c.id });
    }
  }
  // The assignee's own lock comes last: assign-outs made before it are replayed first.
  if (ref?.template === "Assignment" && rec.status === "Locked" && mine && mine.locked == null) out.push({ kind: "lock" });
  return out;
}
// Each record's live offer or assignment on Canton, as the bond's issuer sees it: recordId → arguments.
async function heldOnCanton(pool, bondId) {
  const issuer = await issuerPartyOf(pool, bondId);
  const all = await activeFor(issuer);
  const m = new Map();
  for (const e of all) if (/:Registry:(AssignmentOffer|Assignment)$/.test(e.templateId) && e.createArgument?.bondId === bondId)
    m.set(e.createArgument.recordId, { ...e.createArgument, template: e.templateId.split(":").pop(), cid: e.contractId });
  return m;
}
// A register date (YYYY-MM-DD, or a full timestamp) as Canton's Time and Date.
const asTime = (d) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? d + "T00:00:00Z" : d).toISOString().replace(/\.\d{3}Z$/, "Z");
const asDate = (d) => asTime(d).slice(0, 10);
const child = async (pool, rec, id) => {
  const c = (await pool.query("select data from assignments where id = $1", [id])).rows[0]?.data;
  if (!c || c.parent !== rec.id || c.origin !== "AssignOut") throw new CantonError("That isn't one of your assign-outs.", 403);
  return c;
};

// 1. The browser sends the public halves of its new recovery and device keys.
export async function onboardStart(pool, rec, { recoverySpki, deviceSpki, deviceLabel }) {
  if (await holderOf(pool, rec.id)) throw new CantonError("This assignment already has its keys on Canton.", 409);
  const ref = await refOf(pool, rec.id);
  if (ref?.template !== "AssignmentOffer") throw new CantonError("This assignment isn't on Canton.", 409);
  const topo = await topologyFor(recoverySpki, rec.id.replace(/[^A-Za-z0-9-]/g, "-") + "-" + crypto.randomUUID().slice(0, 8));
  const deviceFp = await fingerprintOf(deviceSpki);
  step(rec.id, { kind: "onboard", topo, recoverySpki, deviceSpki, deviceFp, deviceLabel });
  return { party: topo.partyId, recoveryFp: topo.publicKeyFingerprint, deviceFp, multiHash: topo.multiHash };
}

// 2. The recovery key signs the party into existence; the node builds the device key's two changes.
export async function onboardAllocate(pool, rec, { recoverySignature }) {
  const s = stepOf(rec.id, "onboard");
  await json("POST", "/v2/parties/external/allocate", { synchronizer: await sync(), identityProviderId: "",
    onboardingTransactions: s.topo.topologyTransactions.map((t) => ({ transaction: t })),
    multiHashSignatures: [{ format: "SIGNATURE_FORMAT_DER", signature: recoverySignature, signedBy: s.topo.publicKeyFingerprint, signingAlgorithmSpec: ALGO }] });
  const ns = s.topo.partyId.split("::")[1];
  s.generated = await generate([["TOPOLOGY_CHANGE_OP_ADD_REPLACE", delegation(ns, s.deviceSpki)],
    ["TOPOLOGY_CHANGE_OP_ADD_REPLACE", keyMapping(s.topo.partyId, [{ spki: s.recoverySpki }, { spki: s.deviceSpki }])]]);
  return { hashes: s.generated.map((g) => Buffer.from(g.hash).toString("base64")) };
}

// 3. Recovery and device key both sign both changes; then the offer is bound to the new party.
export async function onboardFinish(pool, rec, { signatures }) {
  const s = stepOf(rec.id, "onboard");
  await addSigned(s.generated, signatures);
  const platform = await localParty(pool, "platform");
  const ref = await refOf(pool, rec.id);
  const tx = await submit([platform], [{ ExerciseCommand: { templateId: tpl("AssignmentOffer"), contractId: ref.cid, choice: "Bind",
    choiceArgument: { party: s.topo.partyId } } }]);
  await setRef(pool, rec.id, "AssignmentOffer", createdOf(tx, "AssignmentOffer").contractId);
  const now = new Date().toISOString();
  const keys = [{ fp: s.topo.publicKeyFingerprint, spki: s.recoverySpki, role: "recovery", label: "Recovery key", added: now },
    { fp: s.deviceFp, spki: s.deviceSpki, role: "device", label: s.deviceLabel || "This device", added: now }];
  await pool.query("insert into canton_holders (record, party, keys) values ($1, $2, $3)", [rec.id, s.topo.partyId, JSON.stringify(keys)]);
  steps.delete(rec.id);
  return { party: s.topo.partyId, keys: keys.map(({ fp, role, label, added }) => ({ fp, role, label, added })) };
}

// ------------------------------------------------------------------ the assignee's acts

// The issuer's party sees every contract on its bonds: the place to look for what an act created.
async function issuerPartyOf(pool, bondId) {
  const code = (await pool.query("select i.code from bonds b join issuers i on i.id = b.issuer_id where b.id = $1", [bondId])).rows[0]?.code;
  return localParty(pool, "issuer-" + code);
}
async function activeFor(party) {
  const end = (await json("GET", "/v2/state/ledger-end")).offset;
  const acs = await json("POST", "/v2/state/active-contracts", { activeAtOffset: end, eventFormat: { verbose: false,
    filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } } });
  return (Array.isArray(acs) ? acs : []).map((x) => x.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean);
}
async function findContract(party, template, recordId) {
  return (await activeFor(party)).find((e) => e.templateId.endsWith(":Registry:" + template) && e.createArgument?.recordId === recordId) || null;
}

/**
 * The node prepares one of the assignee's acts, each matching what the register already holds:
 *   accept / reject   their offer (an assignment they were given)
 *   assignOut         a portion of their assignment, to the assign-out saved in the register
 *   reclaim           units back from an assign-out of theirs that was rejected
 * The page gets the transaction itself as well as its hash, so it can check one against the other.
 */
// Points the register's record at its live contract on Canton, after an act replaced it.
async function refresh(pool, issuer, recordId) {
  const asg = await findContract(issuer, "Assignment", recordId) || await findContract(issuer, "AssignmentOffer", recordId);
  if (asg) await setRef(pool, recordId, asg.templateId.split(":").pop(), asg.contractId);
}

export async function prepareAct(pool, rec, { kind, child: childId }) {
  const holder = await holderOf(pool, rec.id);
  // Act on the contracts as Canton holds them now, not as last noted: something may have changed them since.
  const live = await heldOnCanton(pool, rec.bond);
  const liveRef = async (id) => {
    const r = await refOf(pool, id), l = live.get(id);
    return r && l && (r.template === "AssignmentOffer" || r.template === "Assignment") ? { template: l.template, cid: l.cid } : r;
  };
  const ref = await liveRef(rec.id);
  if (!holder) throw new CantonError("This assignment has no keys on Canton yet.", 409);
  const due = await waiting(pool, rec, ref);
  if (!due.some((d) => d.kind === kind && (d.child || null) === (childId || null))) throw new CantonError("There's nothing like that to sign on Canton for this assignment.", 409);
  let command;
  if (kind === "accept") command = { templateId: tpl("AssignmentOffer"), contractId: ref.cid, choice: "Accept", choiceArgument: {} };
  if (kind === "reject") command = { templateId: tpl("AssignmentOffer"), contractId: ref.cid, choice: "Reject", choiceArgument: { reason: rec.rejectionReason || "" } };
  if (kind === "assignOut") {
    const c = await child(pool, rec, childId);
    command = { templateId: tpl("Assignment"), contractId: ref.cid, choice: "AssignOut", choiceArgument: {
      childId: c.id, childUnits: String(await replayedUnits(pool, c)), childHash: c.docHash, childName: c.party || "", childParty: null } };
  }
  if (kind === "receipt") {
    const onAsg = ref.template === "Assignment";
    command = { templateId: tpl(ref.template), contractId: ref.cid, choice: onAsg ? "RecordReceiptOnAssignment" : "RecordReceipt",
      choiceArgument: { received: asDate(rec.receivedOn), ref: rec.receiptRef } };
  }
  if (kind === "mailing" || kind === "ucc3") {
    const c = await child(pool, rec, childId), cref = await liveRef(childId);
    command = kind === "mailing"
      ? { templateId: tpl("AssignmentOffer"), contractId: cref.cid, choice: "RecordMailing", choiceArgument: { sentOn: asTime(c.mailedOn || c.deliveredAt), mailingRef: c.deliveryRef } }
      : { templateId: tpl(cref.template), contractId: cref.cid, choice: cref.template === "Assignment" ? "RecordUcc3OnAssignment" : "RecordUcc3",
          choiceArgument: { filedHash: c.filingDoc } };
  }
  if (kind === "lock") command = { templateId: tpl("Assignment"), contractId: ref.cid, choice: "Lock",
    choiceArgument: { kind: rec.lockKind || "other", reason: rec.lockReason || "Locked by the assignee" } };
  if (kind === "cancelOut") {
    await child(pool, rec, childId);
    command = { templateId: tpl("Assignment"), contractId: ref.cid, choice: "CancelAssignOut", choiceArgument: { offerCid: (await liveRef(childId)).cid } };
  }
  if (kind === "reclaim") {
    await child(pool, rec, childId);
    command = { templateId: tpl("Assignment"), contractId: ref.cid, choice: "ReclaimToAssignment", choiceArgument: { returnedCid: (await refOf(pool, childId)).cid } };
  }
  const p = await json("POST", "/v2/interactive-submission/prepare", { userId: USER, commandId: crypto.randomUUID(), actAs: [holder.party], readAs: [],
    synchronizerId: await sync(), verboseHashing: false, packageIdSelectionPreference: [], commands: [{ ExerciseCommand: command }] });
  step(rec.id + ":act", { kind: "act", act: kind, child: childId || null, p, party: holder.party });
  return { kind, child: childId || null, hash: p.preparedTransactionHash, prepared: p.preparedTransaction };
}

export async function executeAct(pool, rec, { signature, signedBy }) {
  const s = stepOf(rec.id + ":act", "act");
  const holder = await holderOf(pool, rec.id);
  if (!holder.keys.some((k) => k.fp === signedBy)) throw new CantonError("That key isn't one of this assignment's keys.", 403);
  await json("POST", "/v2/interactive-submission/executeAndWait", { preparedTransaction: s.p.preparedTransaction, hashingSchemeVersion: s.p.hashingSchemeVersion,
    userId: USER, submissionId: crypto.randomUUID(), deduplicationPeriod: { Empty: {} },
    partySignatures: { signatures: [{ party: s.party, signatures: [{ format: "SIGNATURE_FORMAT_DER", signature, signedBy, signingAlgorithmSpec: ALGO }] }] } });
  steps.delete(rec.id + ":act");
  // What the act created, as the issuer's party sees it, so the register knows where each record now is.
  const issuer = await issuerPartyOf(pool, rec.bond);
  if (s.act === "accept" || s.act === "assignOut" || s.act === "reclaim" || s.act === "lock" || s.act === "cancelOut") {
    const mine = await findContract(issuer, "Assignment", rec.id);
    if (mine) await setRef(pool, rec.id, "Assignment", mine.contractId);
  }
  if (s.act === "assignOut") {
    const offer = await findContract(issuer, "AssignmentOffer", s.child);
    if (offer) await setRef(pool, s.child, "AssignmentOffer", offer.contractId);
  }
  if (s.act === "reclaim" || s.act === "cancelOut") await setRef(pool, s.child, "Closed", "-");
  if (s.act === "receipt") await refresh(pool, issuer, rec.id);
  if (s.act === "mailing" || s.act === "ucc3") await refresh(pool, issuer, s.child);
  if (s.act === "reject") {
    const back = await findContract(issuer, "UnitsReturned", rec.id);
    if (back && back.createArgument.parentId == null) {
      // An issuer-made assignment: its units go straight back to the bond (the issuer's own act).
      const bond = await refOf(pool, rec.bond);
      const tx = await submit([issuer], [{ ExerciseCommand: { templateId: tpl("Bond"), contractId: bond.cid, choice: "ReclaimToBond", choiceArgument: { returnedCid: back.contractId } } }]);
      await setRef(pool, rec.bond, "Bond", createdOf(tx, "Bond").contractId);
      await setRef(pool, rec.id, "Closed", "-");
    } else if (back) await setRef(pool, rec.id, "UnitsReturned", back.contractId); // its assignor reclaims them
  }
  return { done: s.act };
}

// ------------------------------------------------------------------ recovery and a second device

/**
 * mode "add": a new device joins (the existing ones stay). mode "recover": a new device replaces
 * every device key, so a lost one stops working. Either way the recovery key signs.
 */
export async function keysStart(pool, rec, { mode, newSpki, label }) {
  const holder = await holderOf(pool, rec.id);
  if (!holder) throw new CantonError("This assignment has no keys on Canton yet.", 409);
  if (!["add", "recover"].includes(mode)) throw new CantonError("Unknown key change.", 400);
  const newFp = await fingerprintOf(newSpki);
  if (holder.keys.some((k) => k.fp === newFp)) throw new CantonError("That key is already registered.", 409);
  const recovery = holder.keys.find((k) => k.role === "recovery");
  const kept = mode === "add" ? holder.keys.filter((k) => k.role === "device") : [];
  const dropped = mode === "recover" ? holder.keys.filter((k) => k.role === "device") : [];
  const ns = holder.party.split("::")[1];
  const generated = await generate([
    ["TOPOLOGY_CHANGE_OP_ADD_REPLACE", delegation(ns, newSpki)],
    ["TOPOLOGY_CHANGE_OP_ADD_REPLACE", keyMapping(holder.party, [recovery, ...kept, { spki: newSpki }])],
    ...dropped.map((k) => ["TOPOLOGY_CHANGE_OP_REMOVE", delegation(ns, k.spki)]),
  ]);
  step(rec.id + ":keys", { kind: "keys", mode, generated, newFp, newSpki, label, kept, recovery });
  // The new key proves it's held by signing its own two changes; the recovery key authorizes all of them.
  return { recoveryFp: recovery.fp, newFp, hashes: generated.map((g, i) => ({ hash: Buffer.from(g.hash).toString("base64"), newKeySigns: i < 2 })) };
}

export async function keysFinish(pool, rec, { signatures }) {
  const s = stepOf(rec.id + ":keys", "keys");
  await addSigned(s.generated, signatures);
  const keys = [s.recovery, ...s.kept, { fp: s.newFp, spki: s.newSpki, role: "device", label: s.label || "New device", added: new Date().toISOString() }];
  await pool.query("update canton_holders set keys = $2, updated_at = now() where record = $1", [rec.id, JSON.stringify(keys)]);
  steps.delete(rec.id + ":keys");
  return { keys: keys.map(({ fp, role, label, added }) => ({ fp, role, label, added })) };
}
