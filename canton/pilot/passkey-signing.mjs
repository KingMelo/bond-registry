// Pilot: can an assignee's own key act for them on Canton, with the node unable to sign for them?
//
// Against a local Canton sandbox (daml sandbox --json-api-port 7575 --dar <the registry DAR>):
//   1. The issuer and platform are ordinary parties on the node.
//   2. The assignee becomes an EXTERNAL party: its ID comes from a P-256 key the node never holds.
//   3. The issuer issues them an offer; the assignee's Accept is prepared by the node and signed
//      by the assignee's key in three ways:
//        a. as a WebAuthn passkey signs (over authenticatorData + SHA-256 of clientDataJSON),
//        b. as a browser's WebCrypto key signs (ECDSA P-256 / SHA-256 over the hash itself),
//        c. by the node alone, with no signature from the assignee.
//
// Run: node canton/pilot/passkey-signing.mjs   (prints PASS/FAIL lines and what Canton answered)
//      BROWSER=1 node canton/pilot/passkey-signing.mjs   the assignee's key is made and used inside
//      Chromium with WebCrypto, non-extractable: nothing outside the page can read it.
import crypto from "node:crypto";
import { createRequire } from "node:module";

const API = process.env.CANTON_JSON || "http://localhost:7575";
const USER = "participant_admin";
const PKG = "#bond-registry";
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const b64 = (b) => Buffer.from(b).toString("base64");
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const hash = (s) => "0x" + sha256(s).toString("hex");

async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  return { ok: r.ok, status: r.status, body: j };
}
const must = async (method, path, body) => {
  const r = await call(method, path, body);
  if (!r.ok) throw new Error(path + " " + r.status + " " + JSON.stringify(r.body).slice(0, 600));
  return r.body;
};

// ---- the node, its synchronizer, the issuer and platform
// A freshly started node answers before it has joined its synchronizer: wait for it.
let sync;
for (let i = 0; i < 60 && !sync; i++) {
  sync = (await call("GET", "/v2/state/connected-synchronizers")).body?.connectedSynchronizers?.[0]?.synchronizerId;
  if (!sync) await new Promise((r) => setTimeout(r, 1000));
}
if (!sync) throw new Error("The Canton node isn't connected to a synchronizer.");
const local = async (hint) => (await must("POST", "/v2/parties", { partyIdHint: hint + "-" + Date.now(), identityProviderId: "" })).partyDetails.party;
const issuer = await local("Issuer"), platform = await local("Platform");
await must("POST", "/v2/users/" + USER + "/rights", { userId: USER, identityProviderId: "",
  rights: [issuer, platform].map((p) => ({ kind: { CanActAs: { value: { party: p } } } })) });

// ---- the assignee's key, made on "their device", and their external party
// r||s (64 bytes) → DER, as the page would convert a WebCrypto signature.
const toDer = (rs) => {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const r = int(rs.subarray(0, 32)), s = int(rs.subarray(32));
  const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, s.length]), s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};
let spki, sigOf, browser;
if (process.env.BROWSER) {
  const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("playwright");
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(API + "/livez"); // localhost: a secure context, so WebCrypto is available
  spki = Buffer.from(await page.evaluate(async () => {
    window.k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const pub = new Uint8Array(await crypto.subtle.exportKey("spki", window.k.publicKey));
    return btoa(String.fromCharCode(...pub));
  }), "base64");
  ok(await page.evaluate(() => window.k.privateKey.extractable === false), "the assignee's key is made in the browser and can't be exported");
  sigOf = async (bytes, enc = "der") => {
    const rs = Buffer.from(await page.evaluate(async (b) => {
      const data = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, window.k.privateKey, data));
      return btoa(String.fromCharCode(...sig));
    }, b64(bytes)), "base64");
    return enc === "der" ? toDer(rs) : rs;
  };
} else {
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  spki = device.publicKey.export({ type: "spki", format: "der" });
  sigOf = async (bytes, enc = "der") => crypto.sign("sha256", bytes, { key: device.privateKey, dsaEncoding: enc });
}
const topo = await must("POST", "/v2/parties/external/generate-topology", {
  synchronizer: sync, partyHint: "CompanyA-" + Date.now(), localParticipantObservationOnly: false, confirmationThreshold: 1,
  publicKey: { format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO", keyData: b64(spki), keySpec: "SIGNING_KEY_SPEC_EC_P256" } });
const assignee = topo.partyId, fingerprint = topo.publicKeyFingerprint;
console.log("external party", assignee);
await must("POST", "/v2/parties/external/allocate", {
  synchronizer: sync, identityProviderId: "",
  onboardingTransactions: topo.topologyTransactions.map((t) => ({ transaction: t })),
  multiHashSignatures: [{ format: "SIGNATURE_FORMAT_DER", signature: b64(await sigOf(Buffer.from(topo.multiHash, "base64"))), signedBy: fingerprint,
    signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256" }] });
ok(assignee.includes("::"), "the assignee's party is made from their own key (" + assignee.split("::")[0] + "::" + fingerprint.slice(0, 12) + "…)");

// ---- the issuer's bond and an offer to the assignee (ordinary submissions by the node's own parties)
const submit = async (actAs, commands) => must("POST", "/v2/commands/submit-and-wait-for-transaction", {
  commands: { commands, commandId: crypto.randomUUID(), userId: USER, actAs, synchronizerId: sync } });
const created = (tx, tpl) => tx.transaction.events.map((e) => e.CreatedEvent).filter(Boolean).find((e) => e.templateId.endsWith(":" + tpl));
let tx = await submit([issuer, platform], [{ CreateCommand: { templateId: PKG + ":Registry:Bond", createArguments: {
  issuer, platform, bondId: "PENS-0001-BD", total: "10000000000", unassigned: "10000000000", redeemed: "0", prior: "0",
  instrumentHash: hash("bond"), ucc1Hash: hash("ucc1"), observers: [], issuerName: "Penson Trust" } } }]);
const bond = created(tx, "Bond").contractId;
const issue = async (n) => {
  const t = await submit([issuer], [{ ExerciseCommand: { templateId: PKG + ":Registry:Bond", contractId: n.bond, choice: "Issue",
    choiceArgument: { recordId: "PENS-0001-BD-A" + String(n.i).padStart(5, "0"), units: "1000000", docHash: hash("a" + n.i), ucc3Hash: null, assigneeName: "Company A", assignee } } }]);
  return { offer: created(t, "AssignmentOffer").contractId, bond: created(t, "Bond").contractId };
};
let st = await issue({ bond, i: 1 });

// ---- the assignee's Accept, prepared by the node; only the assignee's key may sign it
const prepare = async (offer) => must("POST", "/v2/interactive-submission/prepare", {
  userId: USER, commandId: crypto.randomUUID(), actAs: [assignee], readAs: [], synchronizerId: sync, verboseHashing: false,
  packageIdSelectionPreference: [],
  commands: [{ ExerciseCommand: { templateId: PKG + ":Registry:AssignmentOffer", contractId: offer, choice: "Accept", choiceArgument: {} } }] });
const execute = async (p, signature, format) => call("POST", "/v2/interactive-submission/executeAndWait", {
  preparedTransaction: p.preparedTransaction, hashingSchemeVersion: p.hashingSchemeVersion,
  userId: USER, submissionId: crypto.randomUUID(), deduplicationPeriod: { Empty: {} },
  partySignatures: { signatures: [{ party: assignee, signatures: [{ format, signature: b64(signature), signedBy: fingerprint,
    signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256" }] }] } });
const why = (r) => (r.body?.cause || r.body?.code || JSON.stringify(r.body)).toString().slice(0, 220);

// a. A WebAuthn passkey: it never signs the hash itself, only authenticatorData + SHA-256(clientDataJSON
//    with the hash as its challenge). The same P-256 key, the way a browser's passkey uses it.
{
  const p = await prepare(st.offer);
  const h = Buffer.from(p.preparedTransactionHash, "base64");
  const authData = Buffer.concat([sha256("registry.omni-stance.com"), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64u(h), origin: "https://registry.omni-stance.com", crossOrigin: false }));
  const r = await execute(p, await sigOf(Buffer.concat([authData, sha256(clientData)])), "SIGNATURE_FORMAT_DER");
  ok(!r.ok, "a. a WebAuthn passkey signature is refused: Canton checks the key's signature over the transaction hash itself (" + r.status + " " + why(r) + ")");
}

// c. The node alone: no signature from the assignee.
{
  const p = await prepare(st.offer);
  const r = await call("POST", "/v2/interactive-submission/executeAndWait", {
    preparedTransaction: p.preparedTransaction, hashingSchemeVersion: p.hashingSchemeVersion, userId: USER,
    submissionId: crypto.randomUUID(), deduplicationPeriod: { Empty: {} }, partySignatures: { signatures: [] } });
  ok(!r.ok, "c. the node can't act for the assignee without their key (" + r.status + " " + why(r) + ")");
  const direct = await call("POST", "/v2/commands/submit-and-wait-for-transaction", { commands: {
    commands: [{ ExerciseCommand: { templateId: PKG + ":Registry:AssignmentOffer", contractId: st.offer, choice: "Accept", choiceArgument: {} } }],
    commandId: crypto.randomUUID(), userId: USER, actAs: [assignee], synchronizerId: sync } });
  ok(!direct.ok, "   nor by an ordinary submission as the assignee (" + direct.status + " " + why(direct) + ")");
}

// b. A WebCrypto key (crypto.subtle.sign ECDSA P-256, SHA-256) signs the hash itself. The browser
//    returns r||s; Canton wants it as DER, a few lines of conversion in the page.
{
  let p = await prepare(st.offer);
  let r = await execute(p, await sigOf(Buffer.from(p.preparedTransactionHash, "base64"), "ieee-p1363"), "SIGNATURE_FORMAT_CONCAT");
  ok(!r.ok, "b. the browser's raw r||s form is refused as is (" + r.status + ")");
  p = await prepare(st.offer);
  r = await execute(p, await sigOf(Buffer.from(p.preparedTransactionHash, "base64"), "der"), "SIGNATURE_FORMAT_DER");
  ok(r.ok, "   the same signature in DER is accepted: the assignee's own key accepts the assignment (" + r.status + (r.ok ? "" : " " + why(r)) + ")");
}
const mine = await must("POST", "/v2/state/active-contracts", { activeAtOffset: (await must("GET", "/v2/state/ledger-end")).offset,
  eventFormat: { filtersByParty: { [assignee]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } }, verbose: false } });
const held = (Array.isArray(mine) ? mine : []).map((x) => x.contractEntry?.JsActiveContract?.createdEvent).filter((e) => e?.templateId.endsWith(":Assignment"));
ok(held.length === 1 && held[0].signatories.includes(assignee), "the Assignment exists, signed by the assignee's own key, seen on the node (" + held.length + ")");

if (browser) await browser.close();
console.log(fails ? fails + " FAILED" : "ALL PASSED");
process.exit(fails ? 1 : 0);
