// Holder device keys: passkeys (WebAuthn, P-256) that sign holder actions.
//
// Each holder action is signed over a challenge the server builds from what is being done: the
// signer, a counter that only goes up (so a signature can't be replayed), the act and its details.
// The server checks the signature before saving and keeps it (see records.js).
import crypto from "node:crypto";

// The acts a holder signs. Anything else isn't theirs to sign.
export const SIGNED = new Set(["accept", "rejectAssignment", "lock", "cancelAssignOut", "assignOut",
  "registerHolderKey", "recordFiling", "recordMailing", "recordReceipt",
  // Lifting their own lock; answering a proposed replacement; a pledge's lender claiming and releasing it.
  "unlock", "consentReplacement", "declineReplacement", "claimPledge", "releasePledge"]);

/** The challenge the record `signerId` (a display ID) signs for `fn` with these details, at this count. */
export function challengeFor({ signerId, nonce, fn, args }) {
  if (!SIGNED.has(fn)) throw new Error(fn + " isn't signed by a holder.");
  return "0x" + crypto.createHash("sha256")
    .update(JSON.stringify(["BondInterestRegistry/holder/v2", String(signerId), Number(nonce), fn, args.map(String)])).digest("hex");
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s || ""), "base64url");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

/** A P-256 public key (x, y as 0x-hex or bigint) as a Node key object. */
function keyObject(x, y) {
  const hex32 = (v) => BigInt(v).toString(16).padStart(64, "0");
  return crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(Buffer.from(hex32(x), "hex")), y: b64u(Buffer.from(hex32(y), "hex")) }, format: "jwk" });
}

/** The public key out of a WebAuthn registration's SPKI (getPublicKey()). */
export function keyFromSpki(spkiB64u) {
  const k = crypto.createPublicKey({ key: fromB64u(spkiB64u), format: "der", type: "spki" });
  const jwk = k.export({ format: "jwk" });
  if (jwk.crv !== "P-256") throw new Error("The device made a key of a kind the registry can't check. Use a passkey (P-256).");
  return { x: "0x" + Buffer.from(jwk.x, "base64url").toString("hex"), y: "0x" + Buffer.from(jwk.y, "base64url").toString("hex") };
}

/**
 * Checks a WebAuthn assertion against a challenge and key, and that it was made on this site.
 * Returns the response, to keep as evidence.
 * `assertion` is what the browser gave: authenticatorData, clientDataJSON, signature (base64url).
 */
export function checkAssertion({ assertion, challenge, x, y, rpId, origins }) {
  const fail = (why) => { const e = new Error(why); e.status = 422; throw e; };
  const ad = fromB64u(assertion?.authenticatorData), cdBytes = fromB64u(assertion?.clientDataJSON), sig = fromB64u(assertion?.signature);
  if (ad.length < 37) fail("The device's response is incomplete.");
  if (!sha256(Buffer.from(rpId)).equals(ad.subarray(0, 32))) fail("That passkey belongs to a different site.");
  if ((ad[32] & 0x05) !== 0x05) fail("The device didn't confirm it was you (no fingerprint, face or PIN check).");
  const cdText = cdBytes.toString("utf8");
  let cd; try { cd = JSON.parse(cdText); } catch { fail("The device's response is unreadable."); }
  if (cd.type !== "webauthn.get") fail("The device's response isn't a signature.");
  if (!origins.includes(cd.origin)) fail("The signature was made on another site (" + cd.origin + ").");
  if (cd.challenge !== b64u(Buffer.from(challenge.slice(2), "hex"))) fail("The device signed something else. Try again.");
  const ok = crypto.verify("sha256", Buffer.concat([ad, sha256(cdBytes)]), { key: keyObject(x, y), dsaEncoding: "der" }, sig);
  if (!ok) fail("The signature doesn't match this record's device key.");
  return { authenticatorData: b64u(ad), clientDataJSON: b64u(cdBytes), signature: b64u(sig) };
}

/** A registration's clientData: made on this site, as a passkey creation. */
export function checkCreation({ clientDataJSON, origins }) {
  let cd; try { cd = JSON.parse(fromB64u(clientDataJSON).toString("utf8")); } catch { cd = null; }
  if (!cd || cd.type !== "webauthn.create" || !origins.includes(cd.origin)) {
    const e = new Error("The passkey wasn't created on this site."); e.status = 422; throw e;
  }
}

/** A short code a holder can recognise their key by: its first and last bytes. */
export const fingerprint = (x) => { const h = BigInt(x).toString(16).padStart(64, "0"); return (h.slice(0, 4) + "·" + h.slice(-4)).toUpperCase(); };
