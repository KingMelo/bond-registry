// Test stand-in for a holder's passkey: a P-256 key that signs WebAuthn assertions exactly the
// way a browser does (authenticatorData || sha256(clientDataJSON), with the challenge written
// base64url into clientDataJSON).
const crypto = require("crypto");
const { ethers } = require("hardhat");

const RP_ID = "holder.test";
const NOAUTH = { authenticatorData: "0x", clientDataJSON: "", challengeIndex: 0, typeIndex: 0, r: 0, s: 0 };
const HOLDER_FNS = ["accept", "assignOut", "rejectAssignment", "cancelAssignOut", "lock", "requestRedemption"];

function newKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return { privateKey, x: BigInt("0x" + Buffer.from(jwk.x, "base64url").toString("hex")), y: BigInt("0x" + Buffer.from(jwk.y, "base64url").toString("hex")) };
}

/** A WebAuthn assertion over `challenge` (0x-hex bytes32). Options let a test break one part. */
function assert(key, challenge, o = {}) {
  const flags = o.flags ?? 0x05; // user present + user verified
  const authData = Buffer.concat([crypto.createHash("sha256").update(o.rpId || RP_ID).digest(), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
  const cd = JSON.stringify({ type: o.type || "webauthn.get", challenge: Buffer.from((o.challenge || challenge).slice(2), "hex").toString("base64url"),
    origin: "https://" + RP_ID, crossOrigin: false });
  const msg = Buffer.concat([authData, crypto.createHash("sha256").update(cd).digest()]);
  const sig = crypto.sign("sha256", msg, { key: (o.signWith || key).privateKey, dsaEncoding: "ieee-p1363" });
  return { authenticatorData: "0x" + authData.toString("hex"), clientDataJSON: cd,
    challengeIndex: cd.indexOf('"challenge":"'), typeIndex: cd.indexOf('"type":"'),
    r: BigInt("0x" + sig.subarray(0, 32).toString("hex")), s: BigInt("0x" + sig.subarray(32).toString("hex")) };
}

const enc = (types, vals) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(types, vals));
/** The arguments hash the contract signs over, per function (everything but the assertion). */
const ARGS = {
  accept: (a) => enc(["bytes32", "bytes32", "bytes32"], a),
  rejectAssignment: (a) => enc(["bytes32", "bytes32", "bytes32"], a),
  lock: (a) => enc(["bytes32", "bytes32", "bytes32"], a),
  requestRedemption: (a) => enc(["bytes32", "bytes32", "bytes32"], a),
  cancelAssignOut: (a) => enc(["bytes32", "bytes32", "bytes32"], a),
  assignOut: (a) => enc(["bytes32", "bytes32", "bytes32", "uint128", "bytes32"], a),
  registerHolderKey: (a) => enc(["bytes32", "bytes32", "uint256", "uint256", "bytes32"], a),
  rotateHolderKey: (a) => enc(["bytes32", "bytes32", "uint256", "uint256", "bytes32"], a),
};

async function signFor(reg, key, signerId, fn, args, o) {
  const challenge = await reg.holderChallenge(signerId, reg.interface.getFunction(fn).selector, ARGS[fn](args));
  return assert(key, challenge, o);
}

/**
 * The relayer, with each holder's device: holder calls get a valid assertion from the record's
 * key, registering one the first time a record acts (as the holder's first sign-in would).
 * Calls that can't be signed (no such record, wrong status) go through unsigned so the
 * contract's own refusal shows.
 */
function withHolders(reg, relayer) {
  const RL = reg.connect(relayer);
  const keys = new Map();
  async function keyFor(bond, rec) {
    if (keys.has(rec)) return keys.get(rec);
    const k = await reg.holderKeys(rec);
    if (k.x !== 0n || k.y !== 0n) return null; // registered elsewhere in the test
    const key = newKey(), doc = ethers.id("device " + rec);
    const args = [bond, rec, key.x, key.y, doc];
    try {
      const auth = await signFor(reg, key, rec, "registerHolderKey", args);
      await (await RL.registerHolderKey(...args, auth)).wait();
    } catch (e) { if (process.env.DEBUG_KEYS) console.log("register failed", e.shortMessage || e.message); return null; }
    keys.set(rec, key);
    return key;
  }
  return new Proxy(RL, {
    get(target, prop) {
      if (!HOLDER_FNS.includes(prop)) return target[prop];
      return async (...args) => {
        let signer = args[1];
        if (prop === "cancelAssignOut") {
          const c = await reg.assignments(args[1]).catch(() => null);
          signer = c && c.parentId !== ethers.ZeroHash ? c.parentId : null;
        }
        const key = signer ? await keyFor(args[0], signer) : null;
        const auth = key ? await signFor(reg, key, signer, prop, args) : { ...NOAUTH, r: 1n };
        return target[prop](...args, auth);
      };
    },
  });
}

module.exports = { newKey, assert, signFor, withHolders, NOAUTH, ARGS, RP_ID };
