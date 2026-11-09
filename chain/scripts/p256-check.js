// Checks whether this network verifies P-256 signatures (the kind device passkeys make) with the
// RIP-7212 precompile at 0x…0100. Signs a fresh message locally, then asks the chain to check
// it, and also checks that a tampered signature is refused.
const crypto = require("crypto");
const { ethers, network } = require("hardhat");

async function main() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const msg = Buffer.from("Bond Interest Registry · P-256 check · " + new Date().toISOString());
  const hash = crypto.createHash("sha256").update(msg).digest();
  const der = crypto.sign("sha256", msg, { key: privateKey, dsaEncoding: "ieee-p1363" }); // r||s; signs sha256(msg)
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url"), y = Buffer.from(jwk.y, "base64url");
  const input = (sig) => "0x" + Buffer.concat([hash, sig, x, y]).toString("hex");
  const P256 = "0x0000000000000000000000000000000000000100";
  const good = await ethers.provider.call({ to: P256, data: input(der) });
  const bad = Buffer.from(der); bad[40] ^= 1;
  const tampered = await ethers.provider.call({ to: P256, data: input(bad) });
  const n = (v) => BigInt(!v || v === "0x" ? "0x0" : v);
  const ok = n(good) === 1n && n(tampered) === 0n;
  console.log(`P256 ${network.name}: valid → ${good || "(empty)"} · tampered → ${tampered || "(empty)"}`);
  console.log(ok ? "P256-SUPPORTED" : "P256-NOT-SUPPORTED");
  if (!ok) process.exitCode = 1;
}
main().catch((e) => { console.error("P256-ERROR", e.message); process.exit(1); });
