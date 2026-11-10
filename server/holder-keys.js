// Holder device keys: passkeys (WebAuthn, P-256) that sign holder actions.
//
// The contract checks each holder action against the record's device key, over a challenge it
// rebuilds itself. The server builds the same challenge so the holder's device can sign it,
// checks the signature before saving (so a bad one never reaches the queue), and turns the
// browser's WebAuthn response into the HolderAuth tuple the contract takes.
import crypto from "node:crypto";
import { ethers } from "ethers";

const coder = ethers.AbiCoder.defaultAbiCoder();
const HOLDER_TAG = ethers.keccak256(ethers.toUtf8Bytes("BondInterestRegistry/holder/v1"));
const id32 = (s) => ethers.keccak256(ethers.toUtf8Bytes(String(s)));

/** An unsigned HolderAuth, for the one holder-side call that may go without it. */
export const NOAUTH = ["0x", "", "0", "0", "0", "0"];

// Each signed function: which record's key signs it, and the arguments hash the contract uses.
const B3 = ["bytes32", "bytes32", "bytes32"];
export const SIGNED = {
  accept: { types: B3 },
  rejectAssignment: { types: B3 },
  lock: { types: B3 },
  requestRedemption: { types: B3 },
  cancelAssignOut: { types: B3 },
  assignOut: { types: ["bytes32", "bytes32", "bytes32", "uint128", "bytes32"] },
  registerHolderKey: { types: ["bytes32", "bytes32", "uint256", "uint256", "bytes32"] },
  rotateHolderKey: { types: ["bytes32", "bytes32", "uint256", "uint256", "bytes32"] },
};

let fnSelectors = null;
function selector(iface, fn) {
  fnSelectors ||= new Map();
  if (!fnSelectors.has(fn)) fnSelectors.set(fn, iface.getFunction(fn).selector);
  return fnSelectors.get(fn);
}

/** The challenge the record `signerId` (a display ID) signs for `fn` with these arguments (no auth). */
export function challengeFor({ iface, chainId, contract, signerId, nonce, fn, args }) {
  const spec = SIGNED[fn];
  if (!spec) throw new Error(fn + " isn't signed by a holder.");
  const argsHash = ethers.keccak256(coder.encode(spec.types, args.slice(0, spec.types.length)));
  return ethers.keccak256(coder.encode(
    ["bytes32", "uint256", "address", "bytes32", "uint64", "bytes4", "bytes32"],
    [HOLDER_TAG, BigInt(chainId), contract, id32(signerId), BigInt(nonce), selector(iface, fn), argsHash]));
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s || ""), "base64url");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

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

/** DER ECDSA signature → r, s. */
function derToRS(der) {
  let i = 2;
  const read = () => { if (der[i++] !== 0x02) throw new Error("bad signature"); const len = der[i++]; const v = der.subarray(i, i + len); i += len; return BigInt("0x" + v.toString("hex")); };
  if (der[0] !== 0x30) throw new Error("bad signature");
  return { r: read(), s: read() };
}

/**
 * Checks a WebAuthn assertion against a challenge and key, the way the contract will, plus what
 * only the server can check (the site it was made for). Returns the HolderAuth tuple.
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
  let { r, s } = derToRS(sig);
  if (s > N / 2n) s = N - s; // either form verifies; keep one
  const challengeIndex = cdText.indexOf('"challenge":"'), typeIndex = cdText.indexOf('"type":"webauthn.get"');
  if (challengeIndex < 0 || typeIndex < 0) fail("The device's response is missing its challenge.");
  return ["0x" + ad.toString("hex"), cdText, String(challengeIndex), String(typeIndex), r.toString(), s.toString()];
}

/** A registration's clientData: made on this site, as a passkey creation. */
export function checkCreation({ clientDataJSON, origins }) {
  let cd; try { cd = JSON.parse(fromB64u(clientDataJSON).toString("utf8")); } catch { cd = null; }
  if (!cd || cd.type !== "webauthn.create" || !origins.includes(cd.origin)) {
    const e = new Error("The passkey wasn't created on this site."); e.status = 422; throw e;
  }
}

/** A short code a holder can compare with what Polygonscan shows: the key's first and last bytes. */
export const fingerprint = (x) => { const h = BigInt(x).toString(16).padStart(64, "0"); return (h.slice(0, 4) + "·" + h.slice(-4)).toUpperCase(); };
