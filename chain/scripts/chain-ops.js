// Read-only: the chain queue for the current contract, and each Safe's on-chain state.
//   DATABASE_URL, CONTRACT (defaults to deployments/<network>.json)
const fs = require("fs"), path = require("path");
const { Client } = require("pg");
const { ethers, network } = require("hardhat");
const SAFE_ABI = ["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)", "function nonce() view returns (uint256)"];
async function main() {
  const contract = process.env.CONTRACT || JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", network.name + ".json"), "utf8")).address;
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const ops = (await db.query(`select seq, bond, ref, fn, role, status, safe, error, note, tx, attempts, signatures, safe_tx->'message'->>'nonce' as snonce,
      safe_tx->>'hash' as shash, created_at, updated_at from chain_ops where contract = $1 order by seq desc limit 15`, [contract])).rows;
  for (const o of ops.reverse())
    console.log(`OP ${o.seq} ${o.fn} ${o.ref} role=${o.role} status=${o.status} attempts=${o.attempts}${o.safe ? " safe=" + o.safe.slice(0, 8) + " nonce=" + o.snonce + " hash=" + String(o.shash).slice(0, 10) : ""}`
      + ` sigs=${JSON.stringify((o.signatures || []).map((s) => s.signer.slice(0, 8) + "@" + s.at))}${o.tx ? " tx=" + o.tx : ""}${o.error ? " ERROR=" + o.error : ""}${o.note ? " note=" + o.note : ""} updated=${o.updated_at.toISOString()}`);
  const safes = [...new Set(ops.map((o) => o.safe).filter(Boolean))];
  for (const s of safes) {
    const c = new ethers.Contract(s, SAFE_ABI, ethers.provider);
    console.log(`SAFE ${s} nonce=${await c.nonce()} threshold=${await c.getThreshold()} owners=${(await c.getOwners()).join(",")}`);
  }
  const [me] = await ethers.getSigners();
  console.log(`RELAYER ${me.address} ${ethers.formatEther(await ethers.provider.getBalance(me.address))} POL`);
  await db.end();
}
main().catch((e) => { console.error("OPS-ERROR", e.message); process.exit(1); });
