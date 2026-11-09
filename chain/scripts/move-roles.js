// Moves the registry's governing roles to a Safe, and points issuers at it.
//
//   SAFE            the Safe that takes over (it must already exist on this network)
//   ISSUER_CODES    issuer codes whose on-chain account becomes the Safe, e.g. KJPII
//   DATABASE_URL    optional: also records the Safe on those issuers in the register
//   DRY_RUN=1       print the plan only
//
// Order matters, and is safe to re-run:
//   1. point each issuer at the Safe. Only an issuer's current account can move it, so this works
//      for issuers this key still acts for (on a fresh deployment, before any move);
//   2. grant PLATFORM, GUARDIAN and DEFAULT_ADMIN to the Safe;
//   3. only once the Safe verifiably holds all three, renounce them from this key.
// The relayer role stays on this key: holder actions keep going straight through.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const dry = !!process.env.DRY_RUN;
  const safe = ethers.getAddress(process.env.SAFE || "");
  const codes = String(process.env.ISSUER_CODES || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const dep = process.env.CONTRACT ? { address: process.env.CONTRACT }
    : JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", network.name + ".json"), "utf8"));
  const [me] = await ethers.getSigners();
  const signer = new ethers.NonceManager(me); signer.address = me.address;
  const reg = await ethers.getContractAt("BondInterestRegistry", dep.address, signer);
  console.log(`${dry ? "DRY RUN — " : ""}${network.name} · registry ${dep.address} · from ${me.address} · to Safe ${safe}`);
  if ((await ethers.provider.getCode(safe)) === "0x") throw new Error("No Safe deployed at " + safe + " on " + network.name + ".");

  const send = async (label, fn) => {
    if (dry) return console.log("  would:", label);
    const tx = await fn();
    let r = null;
    for (let i = 0; i < 90 && !r; i++) { r = await ethers.provider.getTransactionReceipt(tx.hash).catch(() => null); if (!r) await new Promise((x) => setTimeout(x, 1500)); }
    if (!r || r.status !== 1) throw new Error(label + " didn't confirm: " + tx.hash);
    console.log("  done:", label, "· tx", tx.hash);
  };
  const tag = (s) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "string"], ["BondInterestRegistry/governance/v1", s]));

  // 1. Issuers act through the Safe.
  for (const code of codes) {
    const id = ethers.keccak256(ethers.toUtf8Bytes(code));
    const iss = await reg.issuers(id);
    if (iss.account === ethers.ZeroAddress) throw new Error(code + " isn't registered on-chain.");
    if (iss.account.toLowerCase() === safe.toLowerCase()) { console.log(`  ${code} already acts through the Safe`); continue; }
    if (iss.account.toLowerCase() !== me.address.toLowerCase())
      throw new Error(`${code} acts through ${iss.account}; only that account can move it, so this key can't.`);
    await send(`setIssuerAccount ${code} → Safe`, () => reg.setIssuerAccount(id, safe, tag("issuer " + code + " to Safe " + safe)));
  }

  // 2. The Safe takes the governing roles.
  const ROLES = { PLATFORM: await reg.PLATFORM_ROLE(), GUARDIAN: await reg.GUARDIAN_ROLE(), ADMIN: await reg.DEFAULT_ADMIN_ROLE() };
  for (const [name, role] of Object.entries(ROLES)) {
    if (await reg.hasRole(role, safe)) { console.log(`  Safe already has ${name}`); continue; }
    await send(`grant ${name} to Safe`, () => reg.grantRole(role, safe));
  }

  // 3. Only now does this key give them up, admin last.
  if (!dry) for (const [name, role] of Object.entries(ROLES))
    if (!(await reg.hasRole(role, safe))) throw new Error(`The Safe doesn't hold ${name}; nothing renounced.`);
  for (const name of ["PLATFORM", "GUARDIAN", "ADMIN"]) {
    if (!(await reg.hasRole(ROLES[name], me.address))) { console.log(`  this key no longer has ${name}`); continue; }
    await send(`renounce ${name} from this key`, () => reg.renounceRole(ROLES[name], me.address));
  }

  // The register records which issuers sign through the Safe.
  if (process.env.DATABASE_URL && codes.length && !dry) {
    const { Client } = require("pg");
    const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
    const r = await db.query("update issuers set safe_address = $1 where code = any($2) returning code", [safe, codes]);
    await db.end();
    console.log("  register: issuers now signing through the Safe:", r.rows.map((x) => x.code).join(", ") || "none");
  }

  const state = {};
  for (const [name, role] of Object.entries({ ...ROLES, RELAYER: await reg.RELAYER_ROLE() }))
    state[name] = { safe: await reg.hasRole(role, safe), thisKey: await reg.hasRole(role, me.address) };
  console.log("ROLES " + JSON.stringify(state));
}

main().catch((e) => { console.error("ROLES-ERROR", e.message || e); process.exit(1); });
