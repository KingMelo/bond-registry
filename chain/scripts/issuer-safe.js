// Records in the register which Safe an issuer signs through, or clears it.
//
//   DATABASE_URL   the register
//   ISSUER_CODES   e.g. KJPII
//   ISSUER_SAFE    the Safe address, or "none" to clear it
//
// Clearing is used while a new contract is being filled from the register: the platform's key
// replays the history directly, and move-roles.js then hands the issuer to its Safe.
const { Client } = require("pg");

async function main() {
  const codes = String(process.env.ISSUER_CODES || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const safe = String(process.env.ISSUER_SAFE || "");
  if (!codes.length || !safe) throw new Error("Set ISSUER_CODES and ISSUER_SAFE (an address, or none).");
  const value = safe.toLowerCase() === "none" ? null : safe;
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const r = await db.query("update issuers set safe_address = $1 where code = any($2) returning code, safe_address", [value, codes]);
  await db.end();
  console.log("ISSUER-SAFE " + JSON.stringify(r.rows));
}

main().catch((e) => { console.error("ISSUER-SAFE-ERROR", e.message); process.exit(1); });
