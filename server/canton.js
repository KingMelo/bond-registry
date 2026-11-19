// The register's mirror on Canton (pilot). Off unless CANTON_JSON_URL is set.
//
// The register stays in control; Canton gets one contract per assignment, seen only by its parties:
//   - an issuer-made assignment becomes an AssignmentOffer from the issuer's party (issuer service);
//   - when the assignee sets up, their browser makes a device key (non-extractable) and a recovery
//     key (shown once as a code, then forgotten). The assignee's Canton party is rooted in the
//     recovery key; the device key may sign and manage the party's keys. The node holds neither.
//   - the assignee's acceptance in the register is then signed on Canton by their device key;
//   - with the recovery code, a new device can be added, or a lost one replaced.
//
// Every topology change and transaction is built by the node and signed in the browser; this
// module only carries hashes and signatures. Settings:
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
  for (const rec of records) {
    if (await refOf(pool, rec.id)) continue;
    const b = (await pool.query("select b.data, i.code from bonds b join issuers i on i.id = b.issuer_id where b.id = $1", [rec.bond])).rows[0];
    if (!b) continue;
    const issuer = await localParty(pool, "issuer-" + b.code), platform = await localParty(pool, "platform");
    let bond = await refOf(pool, rec.bond);
    if (!bond) {
      const pending = records.filter((r) => r.bond === rec.bond).reduce((t, r) => t + Number(r.units), 0);
      const tx = await submit([issuer, platform], [{ CreateCommand: { templateId: tpl("Bond"), createArguments: {
        issuer, platform, bondId: rec.bond, total: String(b.data.total), unassigned: String(Number(b.data.unassigned) + pending),
        redeemed: String(b.data.redeemed || 0), instrumentHash: b.data.instrumentHash, ucc1Hash: b.data.ucc1?.hash, observers: [] } } }]);
      bond = { cid: createdOf(tx, "Bond").contractId };
      await setRef(pool, rec.bond, "Bond", bond.cid);
    }
    const tx = await submit([issuer], [{ ExerciseCommand: { templateId: tpl("Bond"), contractId: bond.cid, choice: "Issue", choiceArgument: {
      recordId: rec.id, units: String(rec.units), docHash: rec.docHash, ucc3Hash: isHash(rec.filingDoc) ? rec.filingDoc : null,
      assigneeName: rec.party || "", assignee: null } } }]);
    await setRef(pool, rec.bond, "Bond", createdOf(tx, "Bond").contractId);
    await setRef(pool, rec.id, "AssignmentOffer", createdOf(tx, "AssignmentOffer").contractId);
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

/** What the assignee's page shows: whether this record is on Canton, its party and keys, and anything to sign. */
export async function status(pool, rec) {
  const ref = await refOf(pool, rec.id), holder = await holderOf(pool, rec.id);
  return { enabled: true, onCanton: !!ref, contract: ref?.template || null, party: holder?.party || null,
    keys: (holder?.keys || []).map(({ fp, role, label, added }) => ({ fp, role, label, added })),
    toSign: ref?.template === "AssignmentOffer" && holder && rec.status === "Accepted" ? ["accept"] : [] };
}

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

/** The node prepares the assignee's acceptance; their device key signs its hash. */
export async function prepareAccept(pool, rec) {
  const ref = await refOf(pool, rec.id), holder = await holderOf(pool, rec.id);
  if (ref?.template !== "AssignmentOffer" || !holder) throw new CantonError("There's nothing to sign on Canton for this assignment.", 409);
  if (rec.status !== "Accepted") throw new CantonError("Accept it in the register first.", 409);
  const p = await json("POST", "/v2/interactive-submission/prepare", { userId: USER, commandId: crypto.randomUUID(), actAs: [holder.party], readAs: [],
    synchronizerId: await sync(), verboseHashing: false, packageIdSelectionPreference: [],
    commands: [{ ExerciseCommand: { templateId: tpl("AssignmentOffer"), contractId: ref.cid, choice: "Accept", choiceArgument: {} } }] });
  step(rec.id + ":accept", { kind: "accept", p, party: holder.party });
  return { hash: p.preparedTransactionHash };
}

export async function executeAccept(pool, rec, { signature, signedBy }) {
  const s = stepOf(rec.id + ":accept", "accept");
  const holder = await holderOf(pool, rec.id);
  if (!holder.keys.some((k) => k.fp === signedBy)) throw new CantonError("That key isn't one of this assignment's keys.", 403);
  await json("POST", "/v2/interactive-submission/executeAndWait", { preparedTransaction: s.p.preparedTransaction, hashingSchemeVersion: s.p.hashingSchemeVersion,
    userId: USER, submissionId: crypto.randomUUID(), deduplicationPeriod: { Empty: {} },
    partySignatures: { signatures: [{ party: s.party, signatures: [{ format: "SIGNATURE_FORMAT_DER", signature, signedBy, signingAlgorithmSpec: ALGO }] }] } });
  steps.delete(rec.id + ":accept");
  // The new Assignment's contract, as the assignee's party sees it.
  const end = (await json("GET", "/v2/state/ledger-end")).offset;
  const acs = await json("POST", "/v2/state/active-contracts", { activeAtOffset: end, eventFormat: { verbose: false,
    filtersByParty: { [s.party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } } });
  const mine = (Array.isArray(acs) ? acs : []).map((x) => x.contractEntry?.JsActiveContract?.createdEvent)
    .find((e) => e?.templateId.endsWith(":Registry:Assignment") && e.createArgument?.recordId === rec.id);
  if (mine) await setRef(pool, rec.id, "Assignment", mine.contractId);
  return { contract: mine ? "Assignment" : null };
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
