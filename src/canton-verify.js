// Checking a Canton transaction before the assignee signs it, without taking the server's word.
//
// The node prepares a transaction and the hash to sign. The page decodes the transaction itself,
// rebuilds the hash from it (Canton's hashing scheme V2: a fixed encoding of every node and of the
// metadata, SHA-256'd in a tree), and only lets the key sign if the two match. Then it says in plain
// words what the transaction does, from the same decoded transaction.
//
// Value kinds and node kinds this registry's contracts don't produce yet aren't encoded here; a
// transaction holding one fails the check (it can't be shown, so it isn't signed).
import protobuf from "protobufjs";
import { sha256 } from "@noble/hashes/sha256";

// The parts of Canton's PreparedTransaction (com.daml.ledger.api.v2.interactive) that are hashed.
// Field numbers are Canton's; a few names differ ("ctor" for "constructor", which protobufjs reserves).
const PROTO = `syntax = "proto3"; package p;
message Empty {}
message Identifier { string package_id = 1; string module_name = 2; string entity_name = 3; }
message Value { oneof sum { Empty unit = 1; bool bool = 2; sint64 int64 = 3; int32 date = 4; sfixed64 timestamp = 5; string numeric = 6;
  string party = 7; string text = 8; string contract_id = 9; Optional optional = 10; List list = 11; TextMap text_map = 12;
  GenMap gen_map = 13; Record record = 14; Variant variant = 15; Enum enum = 16; } }
message Record { Identifier record_id = 1; repeated RecordField fields = 2; }
message RecordField { string label = 1; Value value = 2; }
message Variant { Identifier variant_id = 1; string ctor = 2; Value value = 3; }
message Enum { Identifier enum_id = 1; string ctor = 2; }
message List { repeated Value elements = 1; }
message Optional { Value value = 1; }
message TextMap { message Entry { string key = 1; Value value = 2; } repeated Entry entries = 1; }
message GenMap { message Entry { Value key = 1; Value value = 2; } repeated Entry entries = 1; }
message Fetch { string lf_version = 1; string contract_id = 2; string package_name = 3; Identifier template_id = 4;
  repeated string signatories = 5; repeated string stakeholders = 6; repeated string acting_parties = 7; Identifier interface_id = 8; }
message Exercise { string lf_version = 1; string contract_id = 2; string package_name = 3; Identifier template_id = 4;
  repeated string signatories = 5; repeated string stakeholders = 6; repeated string acting_parties = 7; Identifier interface_id = 8;
  string choice_id = 9; Value chosen_value = 10; bool consuming = 11; repeated string children = 12; Value exercise_result = 13;
  repeated string choice_observers = 14; }
message Create { string lf_version = 1; string contract_id = 2; string package_name = 3; Identifier template_id = 4; Value argument = 5;
  repeated string signatories = 6; repeated string stakeholders = 7; }
message Rollback { repeated string children = 1; }
message Node { oneof node_type { Create create = 1; Fetch fetch = 2; Exercise exercise = 3; Rollback rollback = 4; } }
message TxNode { string node_id = 1; Node v1 = 1000; }
message NodeSeed { int32 node_id = 1; bytes seed = 2; }
message DamlTransaction { string version = 1; repeated string roots = 2; repeated TxNode nodes = 3; repeated NodeSeed node_seeds = 4; }
message SubmitterInfo { repeated string act_as = 1; string command_id = 2; }
message InputContract { Create v1 = 1; uint64 created_at = 1000; bytes event_blob = 1002; }
message Metadata { SubmitterInfo submitter_info = 2; string synchronizer_id = 3; uint32 mediator_group = 4; string transaction_uuid = 5;
  uint64 preparation_time = 6; repeated InputContract input_contracts = 7; optional uint64 min_ledger_effective_time = 9;
  optional uint64 max_ledger_effective_time = 10; }
message PreparedTransaction { DamlTransaction transaction = 1; Metadata metadata = 2; }`;
let Prepared = null;
const type = () => (Prepared ||= protobuf.parse(PROTO, { keepCase: true }).root.lookupType("p.PreparedTransaction"));

const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from((h.match(/../g) || []).map((x) => parseInt(x, 16)));
const PURPOSE = new Uint8Array([0, 0, 0, 0x30]);

// ---- the byte encoding
class Out {
  constructor() { this.parts = []; }
  raw(b) { this.parts.push(b); return this; }
  byte(x) { return this.raw(new Uint8Array([x])); }
  int(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return this.raw(b); }
  long(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(v))); return this.raw(b); }
  str(s) { const u = new TextEncoder().encode(String(s ?? "")); return this.int(u.length).raw(u); }
  bytes(b) { return this.int(b.length).raw(b); }
  bool(b) { return this.byte(b ? 1 : 0); }
  list(items, f) { this.int((items || []).length); for (const x of items || []) f(x); return this; }
  opt(v, f) { if (v == null) return this.byte(0); this.byte(1); f(v); return this; }
  done() { const n = this.parts.reduce((t, p) => t + p.length, 0), o = new Uint8Array(n); let i = 0; for (const p of this.parts) { o.set(p, i); i += p.length; } return o; }
  hash() { return sha256(this.done()); }
}
const unsupported = (what) => { throw new Error("This transaction holds " + what + ", which this page can't check yet, so it won't sign it."); };

function identifier(o, id) {
  o.str(id.package_id).list(String(id.module_name).split("."), (s) => o.str(s)).list(String(id.entity_name).split("."), (s) => o.str(s));
}
function value(o, v) {
  const k = v?.sum;
  switch (k) {
    case "unit": return o.byte(0x00);
    case "bool": return o.byte(0x01).bool(v.bool);
    case "int64": return o.byte(0x02).long(v.int64);
    case "numeric": return o.byte(0x03).str(v.numeric);
    case "timestamp": return o.byte(0x04).long(v.timestamp);
    case "date": return o.byte(0x05).int(v.date);
    case "party": return o.byte(0x06).str(v.party);
    case "text": return o.byte(0x07).str(v.text);
    case "contract_id": return o.byte(0x08).bytes(fromHex(v.contract_id));
    case "optional": return o.byte(0x09).opt(v.optional.value, (x) => value(o, x));
    case "list": return o.byte(0x0a).list(v.list.elements, (x) => value(o, x));
    case "record": return o.byte(0x0c).opt(v.record.record_id, (id) => identifier(o, id))
      .list(v.record.fields, (f) => { o.opt(f.label || null, (l) => o.str(l)); value(o, f.value); });
    case "variant": o.byte(0x0d).opt(v.variant.variant_id, (id) => identifier(o, id)).str(v.variant.ctor); return value(o, v.variant.value);
    case "enum": return o.byte(0x0e).opt(v.enum.enum_id, (id) => identifier(o, id)).str(v.enum.ctor);
    default: return unsupported("a value of kind " + (k || "unknown"));
  }
}

function hashNode(tx, id, seeds) {
  const node = tx.nodes.find((n) => n.node_id === id)?.v1;
  if (!node) throw new Error("The transaction refers to a node it doesn't contain.");
  const o = new Out().byte(0x01);
  if (node.create) {
    const c = node.create;
    o.str(c.lf_version).byte(0x00).opt(seeds.get(id), (s) => o.raw(s));
    return createBody(o, c).hash();
  }
  if (node.exercise) {
    const e = node.exercise, seed = seeds.get(id);
    if (!seed) throw new Error("The transaction is missing a node seed.");
    o.str(e.lf_version).byte(0x01).raw(seed).bytes(fromHex(e.contract_id)).str(e.package_name);
    identifier(o, e.template_id);
    o.list(e.signatories, (p) => o.str(p)).list(e.stakeholders, (p) => o.str(p)).list(e.acting_parties, (p) => o.str(p))
      .opt(e.interface_id, (i) => identifier(o, i)).str(e.choice_id);
    value(o, e.chosen_value);
    o.bool(e.consuming).opt(e.exercise_result, (r) => value(o, r)).list(e.choice_observers, (p) => o.str(p))
      .list(e.children, (c) => o.raw(hashNode(tx, c, seeds)));
    return o.hash();
  }
  if (node.fetch) {
    const f = node.fetch;
    o.str(f.lf_version).byte(0x02).bytes(fromHex(f.contract_id)).str(f.package_name);
    identifier(o, f.template_id);
    o.list(f.signatories, (p) => o.str(p)).list(f.stakeholders, (p) => o.str(p))
      .opt(f.interface_id, (i) => identifier(o, i)).list(f.acting_parties, (p) => o.str(p));
    return o.hash();
  }
  return unsupported("a rollback");
}
function createBody(o, c) {
  o.bytes(fromHex(c.contract_id)).str(c.package_name);
  identifier(o, c.template_id);
  value(o, c.argument);
  return o.list(c.signatories, (p) => o.str(p)).list(c.stakeholders, (p) => o.str(p));
}

/** Decodes a prepared transaction (base64) and rebuilds the hash Canton asks to be signed. */
export function hashOf(preparedB64) {
  const p = type().toObject(type().decode(fromB64(preparedB64)), { longs: String, bytes: Uint8Array, oneofs: true, defaults: false });
  const tx = p.transaction, m = p.metadata;
  for (const n of tx.nodes || []) if (!n.v1) unsupported("a node of an unknown version");
  const seeds = new Map((tx.node_seeds || []).map((s) => [String(s.node_id ?? 0), s.seed])); // node 0 decodes as absent
  const txo = new Out();
  txo.raw(PURPOSE).str(tx.version).list(tx.roots, (r) => txo.raw(hashNode(tx, r, seeds)));
  const mo = new Out();
  mo.raw(PURPOSE).byte(0x01).list(m.submitter_info?.act_as, (p2) => mo.str(p2)).str(m.submitter_info?.command_id)
    .str(m.transaction_uuid).int(m.mediator_group || 0).str(m.synchronizer_id)
    .opt(m.min_ledger_effective_time, (t) => mo.long(t)).opt(m.max_ledger_effective_time, (t) => mo.long(t))
    .long(m.preparation_time || 0)
    .list(m.input_contracts, (ic) => { mo.long(ic.created_at || 0).raw(createBody(new Out().byte(0x01).str(ic.v1.lf_version).byte(0x00).byte(0x00), ic.v1).hash()); });
  const hash = new Out().raw(PURPOSE).byte(0x02).raw(txo.hash()).raw(mo.hash()).hash();
  return { hash, prepared: p };
}

// ---- in plain words
// A party by the name the registry gave it: issuer-PENS-1a2b3c4d → "issuer PENS".
export const partyName = (p) => {
  const hint = String(p).split("::")[0];
  const m = hint.match(/^(issuer|platform)-?(.*?)(-[0-9a-f]{8})?$/);
  if (m && m[1] === "issuer") return "issuer " + m[2];
  if (m && m[1] === "platform") return "the platform";
  return hint.replace(/-[0-9a-f]{8}$/, "");
};
const plain = (v) => {
  switch (v?.sum) {
    case "party": return partyName(v.party);
    case "text": return v.text;
    case "int64": return v.int64;
    case "bool": return v.bool ? "yes" : "no";
    case "optional": return v.optional.value ? plain(v.optional.value) : "none";
    case "list": return v.list.elements?.length ? v.list.elements.map(plain).join(", ") : "none";
    case "contract_id": return "contract " + v.contract_id.slice(0, 10) + "…";
    case "record": return Object.fromEntries((v.record.fields || []).map((f) => [f.label, plain(f.value)]));
    default: return String(v?.[v?.sum] ?? "");
  }
};
const fields = (v) => (v?.sum === "record" ? plain(v) : {});

/**
 * Checks the server's hash against the transaction itself. Returns { ok, summary } where summary
 * lists what it does: the choice exercised, by whom, and the contracts it creates and archives.
 */
export function check(preparedB64, hashB64) {
  let built;
  try { built = hashOf(preparedB64); } catch (e) { return { ok: false, reason: e.message }; }
  const expected = fromB64(hashB64);
  if (toHex(built.hash) !== toHex(expected)) return { ok: false, reason: "The hash the server asked this page to sign isn't this transaction's. Nothing was signed." };
  const tx = built.prepared.transaction, byId = new Map(tx.nodes.map((n) => [n.node_id, n.v1]));
  const acts = [];
  const walk = (id) => {
    const n = byId.get(id);
    if (n?.exercise) {
      const e = n.exercise;
      acts.push({ kind: "exercise", template: e.template_id.entity_name, choice: e.choice_id, by: (e.acting_parties || []).map(partyName),
        args: fields(e.chosen_value), consuming: !!e.consuming });
      (e.children || []).forEach(walk);
    } else if (n?.create) acts.push({ kind: "create", template: n.create.template_id.entity_name, args: fields(n.create.argument) });
    else if (n?.fetch) acts.push({ kind: "fetch", template: n.fetch.template_id.entity_name });
  };
  (tx.roots || []).forEach(walk);
  return { ok: true, actAs: (built.prepared.metadata.submitter_info?.act_as || []).map(partyName), acts };
}
