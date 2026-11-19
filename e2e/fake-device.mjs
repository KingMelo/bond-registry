// A stand-in for a holder's phone in the end-to-end tests: P-256 passkeys that answer like a
// browser's WebAuthn (navigator.credentials.create / get).
import crypto from "node:crypto";

export const RP_ID = "holder.test", ORIGIN = "https://holder.test";
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha = (b) => crypto.createHash("sha256").update(b).digest();

export function newDevice() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, credId: b64u(crypto.randomBytes(20)), spki: b64u(publicKey.export({ type: "spki", format: "der" })), counter: 0 };
}
export const created = (dev, enroll, origin = ORIGIN) => ({ credId: dev.credId, spki: dev.spki,
  clientDataJSON: b64u(JSON.stringify({ type: "webauthn.create", challenge: enroll.challenge, origin, crossOrigin: false })) });
export function signs(dev, challengeHex, o = {}) {
  const ad = Buffer.concat([sha(o.rpId || RP_ID), Buffer.from([o.flags ?? 0x05]), Buffer.from([0, 0, 0, ++dev.counter])]);
  const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64u(Buffer.from(challengeHex.slice(2), "hex")), origin: o.origin || ORIGIN, crossOrigin: false }));
  const sig = crypto.sign("sha256", Buffer.concat([ad, sha(cd)]), { key: (o.signWith || dev).privateKey, dsaEncoding: "der" });
  return { authenticatorData: b64u(ad), clientDataJSON: b64u(cd), signature: b64u(sig) };
}

/** Signs in with the mailed code; registers `dev` if the record has no device key yet. */
export async function holderSignIn(call, H, id, code, dev) {
  const r = await call(H, "POST", "/api/holder/signin", { id, passkey: code });
  if (!r.ok) throw new Error("sign-in failed: " + r.code);
  if (r.enroll && dev) {
    const c = created(dev, r.enroll);
    const p = await call(H, "POST", "/api/holder/key/prepare", { token: r.token, ...c });
    const k = await call(H, "POST", "/api/holder/key", { token: r.token, ...c, assertion: signs(dev, p.challenge) });
    r.since = k.since; // the transfer code is used up now; the passkey opens the record from here on
  }
  return r;
}

/** Holder access once a passkey is set up: the assignment ID, then the passkey's signature. */
export async function holderPasskeySignIn(call, H, id, dev, o = {}) {
  const st = await call(H, "POST", "/api/holder/start", { id });
  if (st.mode !== "passkey") throw Object.assign(new Error("expected a passkey sign-in, got " + st.mode), { start: st });
  const r = await call(H, "POST", "/api/holder/signin-passkey", { id, challenge: st.challenge, exp: st.exp, ticket: st.ticket, assertion: signs(dev, st.challenge, o) });
  return { ...r, start: st };
}

/** A holder save: ask what the device must sign, sign it, save. */
export async function holderSave(call, H, token, dev, body, o = {}) {
  const full = { base: (await call(H, "GET", "/api/state")).version, bonds: [], events: [], ...body, token };
  const { sign } = await call(H, "POST", "/api/holder/prepare", full);
  return call(H, "POST", "/api/commit", { ...full, assertions: sign.map((x) => signs(dev, x.challenge, o)) });
}
