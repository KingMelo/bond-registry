// The holder's device key: a passkey made and kept by their phone or computer (Face ID, a
// fingerprint, Windows Hello or the device PIN). The registry only ever sees its public half.

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));
const fromHex = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/../g).map((x) => parseInt(x, 16)));

export const passkeysAvailable = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

function explain(e) {
  if (e?.name === "NotAllowedError") return new Error("The device didn't confirm. It was cancelled or timed out; try again.");
  if (e?.name === "InvalidStateError") return new Error("This device already has a key for this record.");
  if (e?.name === "SecurityError") return new Error("Passkeys need this site's secure address (https).");
  return e instanceof Error ? e : new Error(String(e));
}

/** Makes a new passkey for one record. Returns what the server needs to register it. */
export async function createDeviceKey(enroll) {
  if (!passkeysAvailable()) throw new Error("This browser can't use passkeys. Use an up-to-date phone or computer.");
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      rp: { name: "Bond Interest Registry", id: enroll.rpId },
      user: { id: fromB64u(enroll.userId), name: enroll.name, displayName: enroll.displayName },
      challenge: fromB64u(enroll.challenge),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256: P-256, what the chain can check
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      attestation: "none",
      timeout: 120000,
    } });
  } catch (e) { throw explain(e); }
  const spki = cred.response.getPublicKey?.();
  if (!spki) throw new Error("This browser didn't share the new key. Try a current version of Chrome, Safari or Edge.");
  return { credId: b64u(cred.rawId), spki: b64u(spki), clientDataJSON: b64u(cred.response.clientDataJSON) };
}

/** Signs one challenge (0x-hex) with the record's passkey. */
export async function signWithDevice({ challenge, credId, rpId }) {
  let a;
  try {
    a = await navigator.credentials.get({ publicKey: {
      challenge: fromHex(challenge),
      allowCredentials: [{ type: "public-key", id: fromB64u(credId) }],
      userVerification: "required",
      rpId,
      timeout: 120000,
    } });
  } catch (e) { throw explain(e); }
  return { authenticatorData: b64u(a.response.authenticatorData), clientDataJSON: b64u(a.response.clientDataJSON), signature: b64u(a.response.signature) };
}
