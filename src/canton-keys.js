// The assignee's own keys for Canton (pilot), made and used in their browser.
//
// Device key: WebCrypto ECDSA P-256, made non-extractable, kept in this browser's IndexedDB. No
// script, ours included, can read it out; it can only sign, here.
// Recovery key: P-256 too, made once at setup and shown as a recovery code to print and keep
// offline, then forgotten by the page. Typing the code back in (on any browser) signs with it again.
//
// Canton checks an ECDSA P-256 / SHA-256 signature over the hash it gives, DER-encoded.
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

const fromB64 = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const toB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };

// r||s (64 bytes) → DER.
function toDer(rs) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? concat(new Uint8Array([0]), b) : b; };
  const r = int(rs.subarray(0, 32)), s = int(rs.subarray(32));
  const body = concat(new Uint8Array([2, r.length]), r, new Uint8Array([2, s.length]), s);
  return concat(new Uint8Array([0x30, body.length]), body);
}

// ---- the device key, in IndexedDB
const DB = "bond-registry-keys", STORE = "keys";
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const idb = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(STORE, mode); const q = fn(t.objectStore(STORE)); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); };

/** This browser's device key for a record, if it has one: { spki, fp? }. */
export const deviceKey = async (recordId) => (await idb("readonly", (s) => s.get(recordId))) || null;

/** Makes this browser's device key for a record (replacing any it had). Returns its public half. */
export async function newDeviceKey(recordId) {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const spki = toB64(await crypto.subtle.exportKey("spki", k.publicKey));
  await idb("readwrite", (s) => s.put({ privateKey: k.privateKey, spki }, recordId));
  return { spki };
}
export const rememberFingerprint = async (recordId, fp) => {
  const k = await deviceKey(recordId);
  if (k) await idb("readwrite", (s) => s.put({ ...k, fp }, recordId));
};

/** Signs a Canton hash (base64) with this browser's device key. */
export async function signWithDeviceKey(recordId, hashB64) {
  const k = await deviceKey(recordId);
  if (!k) throw new Error("This browser has no key for this assignment. Add it with your recovery code.");
  const rs = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, fromB64(hashB64)));
  return toB64(toDer(rs));
}

// ---- the recovery key, as a code
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
const SPKI_P256 = Uint8Array.from("3059301306072a8648ce3d020106082a8648ce3d030107034200".match(/../g).map((h) => parseInt(h, 16)));
function base32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(text) {
  let bits = 0, value = 0; const out = [];
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("That recovery code has a character it can't contain: " + ch + ".");
    value = (value << 5) | v; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
// 32-byte key + 3-byte check → 56 characters, in 14 groups of four.
const encode = (priv) => base32(concat(priv, sha256(priv).subarray(0, 3))).match(/.{4}/g).join("-");
function decode(code) {
  const clean = String(code).toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (clean.length !== 56) throw new Error("A recovery code has 56 characters, in 14 groups of four.");
  const bytes = unbase32(clean).subarray(0, 35), priv = bytes.subarray(0, 32), check = bytes.subarray(32);
  if (sha256(priv).subarray(0, 3).some((b, i) => b !== check[i])) throw new Error("That recovery code doesn't check out. Look for a mistyped character.");
  return priv;
}
const recoveryFrom = (priv) => ({
  spki: toB64(concat(SPKI_P256, p256.getPublicKey(priv, false))),
  sign: (hashB64) => toB64(p256.sign(sha256(fromB64(hashB64)), priv, { lowS: true }).toDERRawBytes()),
});

/** A new recovery key: its code (to print, once) and a signer. The page drops both after setup. */
export function newRecoveryKey() {
  const priv = p256.utils.randomPrivateKey();
  return { code: encode(priv), ...recoveryFrom(priv) };
}
/** The recovery key again, from its code. */
export const recoveryFromCode = (code) => recoveryFrom(decode(code));
