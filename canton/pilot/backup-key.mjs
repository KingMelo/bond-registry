// Pilot: a backup key, so a lost browser key isn't a lost assignment.
//
// On a local Canton sandbox (daml sandbox --json-api-port 7575 --dar <the registry DAR>):
//   1. The assignee is set up as an external party with key A (their browser key).
//   2. Backup key B is added: B may sign the party's transactions (party-to-key mapping, threshold 1)
//      and may change its keys (a namespace delegation). A signs both; B signs to prove it's held.
//   3. A is "lost": B alone accepts an assignment; then B adds a fresh key C and drops A.
//   4. A no longer works, C does, and a key that was never registered never does.
// The node holds none of these keys throughout.
//
// Run from canton/pilot after npm install: node backup-key.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import protobuf from "protobufjs";
import grpc from "@grpc/grpc-js";
import loader from "@grpc/proto-loader";

const API = process.env.CANTON_JSON || "http://localhost:7575";
const ADMIN = process.env.CANTON_ADMIN || "localhost:6866";
const JAR = process.env.CANTON_JAR || path.join(os.homedir(), ".daml/sdk/3.4.0-rc2/canton/canton.jar");
const USER = "participant_admin", PKG = "#bond-registry";
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const b64 = (b) => Buffer.from(b).toString("base64");
const hash = (s) => "0x" + crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the admin API's definitions, straight from canton.jar
const PROTOS = fs.mkdtempSync(path.join(os.tmpdir(), "canton-protos-"));
execSync(`unzip -q -o "${JAR}" '*.proto' -d "${PROTOS}"`);
const WRITE = "com/digitalasset/canton/topology/admin/v30/topology_manager_write_service.proto";
const def = loader.loadSync(WRITE, { includeDirs: [PROTOS], keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const svc = grpc.loadPackageDefinition(def).com.digitalasset.canton.topology.admin.v30.TopologyManagerWriteService;
const writer = new svc(ADMIN, grpc.credentials.createInsecure());
const rpc = (m, req) => new Promise((res, rej) => writer[m](req, (e, r) => (e ? rej(e) : res(r))));
const root = new protobuf.Root();
root.resolvePath = (_, target) => path.join(PROTOS, target);
root.loadSync("com/digitalasset/canton/protocol/v30/topology.proto", { keepCase: true });
const TopologyTransaction = root.lookupType("com.digitalasset.canton.protocol.v30.TopologyTransaction");

// ---- JSON Ledger API
async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { ok: r.ok, status: r.status, body: j };
}
const must = async (m, p, b) => { const r = await call(m, p, b); if (!r.ok) throw new Error(p + " " + r.status + " " + JSON.stringify(r.body).slice(0, 500)); return r.body; };
const why = (r) => String(r.body?.cause || JSON.stringify(r.body)).slice(0, 160);

// ---- keys: A (the browser key), B (the backup), C (the replacement), X (never registered)
const newKey = () => {
  const k = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { ...k, spki: k.publicKey.export({ type: "spki", format: "der" }) };
};
const A = newKey(), B = newKey(), C = newKey(), X = newKey();
const sign = (key, bytes) => crypto.sign("sha256", bytes, { key: key.privateKey, dsaEncoding: "der" });
const sig = (key, bytes) => ({ format: "SIGNATURE_FORMAT_DER", signature: sign(key, bytes), signed_by: key.fp,
  signing_algorithm_spec: "SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256" });

// A freshly started node answers before it has joined its synchronizer: wait for it.
let sync;
for (let i = 0; i < 60 && !sync; i++) {
  sync = (await call("GET", "/v2/state/connected-synchronizers")).body?.connectedSynchronizers?.[0]?.synchronizerId;
  if (!sync) await new Promise((r) => setTimeout(r, 1000));
}
if (!sync) throw new Error("The Canton node isn't connected to a synchronizer.");
const jsonKey = (k) => ({ format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO", keyData: b64(k.spki), keySpec: "SIGNING_KEY_SPEC_EC_P256" });
const topologyFor = (k) => must("POST", "/v2/parties/external/generate-topology", {
  synchronizer: sync, partyHint: "CompanyA-" + crypto.randomUUID().slice(0, 8), localParticipantObservationOnly: false, confirmationThreshold: 1, publicKey: jsonKey(k) });

// 1. The assignee with key A.
const topo = await topologyFor(A);
A.fp = topo.publicKeyFingerprint;
for (const k of [B, C, X]) k.fp = (await topologyFor(k)).publicKeyFingerprint; // only to learn each key's fingerprint
await must("POST", "/v2/parties/external/allocate", { synchronizer: sync, identityProviderId: "",
  onboardingTransactions: topo.topologyTransactions.map((t) => ({ transaction: t })),
  multiHashSignatures: [{ format: "SIGNATURE_FORMAT_DER", signature: b64(sign(A, Buffer.from(topo.multiHash, "base64"))), signedBy: A.fp,
    signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256" }] });
const party = topo.partyId, namespace = party.split("::")[1];
// How Canton itself lists key A in the party's key mapping: reuse its shape for B and C.
const mapping = topo.topologyTransactions.map((t) => TopologyTransaction.toObject(TopologyTransaction.decode(Buffer.from(t, "base64")), { enums: String }))
  .find((t) => t.mapping?.party_to_key_mapping)?.mapping.party_to_key_mapping;
const keyA = mapping.signing_keys[0];
const protoKey = (k, usage) => ({ ...keyA, public_key: k.spki, usage });
ok(mapping.threshold === 1 && mapping.signing_keys.length === 1, "the assignee's party starts with one key, A (" + keyA.usage.join(", ") + ")");

// Topology changes: Canton builds the transaction, the keys sign its hash, the node only carries it.
const STORE = { synchronizer: { id: sync } };
async function change(mappingObj, signers, serial = 0) {
  const g = await rpc("GenerateTransactions", { proposals: [{ operation: "TOPOLOGY_CHANGE_OP_ADD_REPLACE", serial, mapping: mappingObj, store: STORE }] });
  const t = g.generated_transactions[0];
  await rpc("AddTransactions", { transactions: [{ transaction: t.serialized_transaction, signatures: signers.map((k) => sig(k, t.transaction_hash)), proposal: false }],
    force_changes: [], store: STORE, wait_to_become_effective: { seconds: 10 } });
}
const tryChange = (m, s) => change(m, s).then(() => null, (e) => e);

// ---- an issuer, a bond, and offers to the assignee
const local = async (hint) => (await must("POST", "/v2/parties", { partyIdHint: hint + "-" + crypto.randomUUID().slice(0, 8), identityProviderId: "" })).partyDetails.party;
const issuer = await local("Issuer"), platform = await local("Platform");
await must("POST", "/v2/users/" + USER + "/rights", { userId: USER, identityProviderId: "", rights: [issuer, platform].map((p) => ({ kind: { CanActAs: { value: { party: p } } } })) });
const submit = (actAs, commands) => must("POST", "/v2/commands/submit-and-wait-for-transaction", { commands: { commands, commandId: crypto.randomUUID(), userId: USER, actAs, synchronizerId: sync } });
const created = (tx, tpl) => tx.transaction.events.map((e) => e.CreatedEvent).filter(Boolean).find((e) => e.templateId.endsWith(":" + tpl));
let bond = created(await submit([issuer, platform], [{ CreateCommand: { templateId: PKG + ":Registry:Bond", createArguments: {
  issuer, platform, bondId: "PENS-0001-BD", total: "10000000000", unassigned: "10000000000", redeemed: "0",
  instrumentHash: hash("bond"), ucc1Hash: hash("ucc1"), observers: [] } } }]), "Bond").contractId;
let issued = 0;
async function offer() {
  const t = await submit([issuer], [{ ExerciseCommand: { templateId: PKG + ":Registry:Bond", contractId: bond, choice: "Issue",
    choiceArgument: { recordId: "PENS-0001-BD-A" + String(++issued).padStart(5, "0"), units: "1000", docHash: hash(crypto.randomUUID()), ucc3Hash: null, assigneeName: "Company A", assignee: party } } }]);
  bond = created(t, "Bond").contractId;
  return created(t, "AssignmentOffer").contractId;
}
// The assignee accepts an offer, signing with the given key.
async function accept(offerCid, key) {
  const p = await must("POST", "/v2/interactive-submission/prepare", { userId: USER, commandId: crypto.randomUUID(), actAs: [party], readAs: [],
    synchronizerId: sync, verboseHashing: false, packageIdSelectionPreference: [],
    commands: [{ ExerciseCommand: { templateId: PKG + ":Registry:AssignmentOffer", contractId: offerCid, choice: "Accept", choiceArgument: {} } }] });
  return call("POST", "/v2/interactive-submission/executeAndWait", { preparedTransaction: p.preparedTransaction, hashingSchemeVersion: p.hashingSchemeVersion,
    userId: USER, submissionId: crypto.randomUUID(), deduplicationPeriod: { Empty: {} },
    partySignatures: { signatures: [{ party, signatures: [{ format: "SIGNATURE_FORMAT_DER", signature: b64(sign(key, Buffer.from(p.preparedTransactionHash, "base64"))),
      signedBy: key.fp, signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256" }] }] } });
}

let r = await accept(await offer(), B);
ok(!r.ok, "before it's added, the backup key B can't act for the assignee (" + r.status + ")");

// 2. Add B. It has to sign as well: nobody can name a key they don't hold.
const keysAB = { party_to_key_mapping: { party, threshold: 1, signing_keys: [keyA, protoKey(B, keyA.usage)] } };
let e = await tryChange(keysAB, [A]);
ok(!!e, "adding B without B's own signature is refused (" + (e?.details || e?.message || "").slice(0, 110) + ")");
await change({ namespace_delegation: { namespace, target_key: protoKey(B, ["SIGNING_KEY_USAGE_NAMESPACE"]), can_sign_all_mappings: {} } }, [A, B]);
await change(keysAB, [A, B]);
ok(true, "A and B together add B as a backup: it may sign the party's transactions and change its keys");
r = await accept(await offer(), A);
ok(r.ok, "A still works (" + r.status + (r.ok ? "" : " " + why(r)) + ")");

// 3. A is lost. B alone acts, then replaces A with a fresh key C.
r = await accept(await offer(), B);
ok(r.ok, "with A lost, the backup key B alone accepts an assignment (" + r.status + (r.ok ? "" : " " + why(r)) + ")");
await change({ party_to_key_mapping: { party, threshold: 1, signing_keys: [protoKey(B, keyA.usage), protoKey(C, keyA.usage)] } }, [B, C]);
ok(true, "B alone (with C proving it holds the new key) replaces lost key A with a new key C");
r = await accept(await offer(), A);
ok(!r.ok, "the lost key A no longer works, whoever has it now (" + r.status + ")");
r = await accept(await offer(), C);
ok(r.ok, "the new key C does (" + r.status + (r.ok ? "" : " " + why(r)) + ")");
r = await accept(await offer(), X);
ok(!r.ok, "a key that was never registered never works (" + r.status + ")");
e = await tryChange({ party_to_key_mapping: { party, threshold: 1, signing_keys: [protoKey(X, keyA.usage)] } }, [X]);
ok(!!e, "and it can't add itself to the party (" + (e?.details || e?.message || "").slice(0, 110) + ")");

writer.close();
fs.rmSync(PROTOS, { recursive: true, force: true });
console.log(fails ? fails + " FAILED" : "ALL PASSED");
process.exit(fails ? 1 : 0);
