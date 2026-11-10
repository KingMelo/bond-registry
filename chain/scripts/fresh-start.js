// A successor that starts clean instead of copying its predecessor: ends the import window at once
// (nothing imported), so the register re-anchors its bonds and prior instruments on it from scratch.
// The contract still names its predecessor, so the line from the old contract stays on record.
//
//   deployments/<network>.json   the new contract (written by deploy.js with WRITE_DEPLOYMENT=1)
//   ISSUER_CODES   issuers to re-register from this key (their Safe link is cleared in the register so
//                  the replay doesn't wait on Safe approvals; move-roles.js moves them back to the Safe)
//   DATABASE_URL   the register
const fs = require("fs"), path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", network.name + ".json"), "utf8"));
  const [me] = await ethers.getSigners();
  const reg = await ethers.getContractAt("BondInterestRegistry", dep.address, me);
  const pred = await reg.predecessor();
  console.log(`${network.name} · ${dep.address} · predecessor ${pred} · from ${me.address}`);
  if (pred !== ethers.ZeroAddress) {
    const p = new ethers.Contract(pred, ["function paused() view returns (bool)"], ethers.provider);
    if (!(await p.paused())) throw new Error("The predecessor isn't paused.");
  }
  if (await reg.migrating()) {
    const tx = await reg.finishImport();
    const r = await tx.wait();
    if (r.status !== 1) throw new Error("finishImport didn't confirm: " + tx.hash);
    console.log("  import window closed, nothing imported · tx " + tx.hash);
  } else console.log("  import window already closed");
  const codes = String(process.env.ISSUER_CODES || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (codes.length && process.env.DATABASE_URL) {
    const { Client } = require("pg");
    const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
    const r = await db.query("update issuers set safe_address = null where code = any($1) returning code", [codes]);
    await db.end();
    console.log("  register: Safe link cleared for the replay on " + (r.rows.map((x) => x.code).join(", ") || "none"));
  }
  console.log("FRESH-START-DONE");
}
main().catch((e) => { console.error("FRESH-START-ERROR", e.message); process.exit(1); });
