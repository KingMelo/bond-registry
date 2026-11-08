// Puts a registered bond and its prior instruments on-chain, from the live register.
//
//   DATABASE_URL   the register (Postgres)
//   BOND_ID        display ID, e.g. KJPII-0001-BD
//   DEPLOYER_KEY   signs: on Amoy the test wallet holds every role, including the issuer's
//   DRY_RUN=1      print the plan and send nothing
//
// Safe to run again: each step is skipped when the chain already has it, and a step whose
// chain state disagrees with the register stops the run.
//
// Hashes written (all documented in chain/README.md):
//   issuerId  = keccak256(issuer code)                      e.g. keccak256("KJPII")
//   bondId    = keccak256(bond display ID)                  e.g. keccak256("KJPII-0001-BD")
//   ucc1Ref   = keccak256(abi.encode("BondInterestRegistry/ucc1/v1", number, office, date, fileSha256))
//   refHash   = keccak256(identifier, trimmed and upper-cased)
//   docHash   = keccak256(abi.encode("BondInterestRegistry/prior/v1", bond display ID, entry id,
//                                    identifier, units, recorded date))
// The prior instrument hash leaves out the holder's name and mailing number on purpose: they
// stay in the register only.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { Client } = require("pg");

const abi = ethers.AbiCoder.defaultAbiCoder();
const k = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
const usd = (c) => "$" + (BigInt(c) / 100n).toLocaleString("en-US") + "." + String(BigInt(c) % 100n).padStart(2, "0");

async function main() {
  const dry = !!process.env.DRY_RUN;
  const bondDisplay = process.env.BOND_ID;
  if (!bondDisplay) throw new Error("Set BOND_ID, e.g. KJPII-0001-BD.");
  const dep = process.env.CONTRACT ? { address: process.env.CONTRACT }
    : JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", network.name + ".json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const reg = await ethers.getContractAt("BondInterestRegistry", dep.address, signer);
  console.log(`${dry ? "DRY RUN — " : ""}${network.name} · contract ${dep.address} · signer ${signer.address}`);

  // ---- read the register
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL ? { rejectUnauthorized: false } : undefined });
  await db.connect();
  const row = (await db.query(
    "select b.id, b.data, b.review, i.code, i.status from bonds b join issuers i on i.id = b.issuer_id where b.id = $1",
    [bondDisplay])).rows[0];
  const records = (await db.query("select count(*)::int as n from assignments where bond = $1", [bondDisplay])).rows[0].n;
  await db.end();
  if (!row) throw new Error(bondDisplay + " isn't in the register.");
  const b = row.data;
  if (row.review !== "approved" || row.status !== "approved") throw new Error(`${bondDisplay} isn't approved (bond ${row.review}, issuer ${row.status}).`);
  if (records) throw new Error(`${bondDisplay} has ${records} assignment records; this script only anchors a bond before any are issued.`);
  if (!isHash(b.instrumentHash)) throw new Error("The bond instrument's hash isn't a full SHA-256: " + b.instrumentHash);
  const u = b.ucc1 || {};
  const missing = [!u.number && "filing number", !u.office && "filing office", !u.date && "filing date",
    !isHash(u.hash) && ("filed copy's SHA-256" + (u.hash ? " (stored value isn't a full hash)" : ""))].filter(Boolean);
  if (missing.length) {
    console.log("  UCC-1 fields present:", Object.keys(u).filter((x) => u[x]).join(", ") || "none", "· has ucc1 object:", !!b.ucc1);
    throw new Error("The bond's UCC-1 is missing: " + missing.join(", ") + ". Add it on the Records tab, then run again.");
  }
  const priors = (b.prior || []).filter((p) => !p.reversed);
  const priorSum = priors.reduce((t, p) => t + BigInt(p.units), 0n);
  if (priorSum + BigInt(b.unassigned) + BigInt(b.redeemed || 0) !== BigInt(b.total))
    throw new Error("The register's lines don't add up to the total; fix that before anchoring.");

  const issuerId = k(row.code), bondId = k(bondDisplay);
  const ucc1Ref = ethers.keccak256(abi.encode(["string", "string", "string", "string", "bytes32"],
    ["BondInterestRegistry/ucc1/v1", u.number, u.office, u.date, u.hash]));
  const plan = priors.map((p) => {
    const ref = String(p.ref).trim().toUpperCase();
    return {
      entry: p.id, units: BigInt(p.units), refHash: k(ref),
      docHash: ethers.keccak256(abi.encode(["string", "string", "string", "string", "uint128", "string"],
        ["BondInterestRegistry/prior/v1", bondDisplay, p.id, ref, BigInt(p.units), p.recordedOn || ""])),
    };
  });
  const dupes = plan.filter((p, i) => plan.findIndex((q) => q.refHash === p.refHash) !== i);
  if (dupes.length) throw new Error("Two active prior instruments share an identifier: " + dupes.map((d) => d.entry).join(", "));

  console.log(`Bond ${bondDisplay} (${b.title || "untitled"}) · issuer ${row.code}`);
  console.log(`  total ${usd(b.total)} · prior ${usd(priorSum)} in ${priors.length} entries · unassigned ${usd(b.unassigned)}`);
  console.log(`  issuerId ${issuerId}\n  bondId   ${bondId}\n  instrument ${b.instrumentHash}\n  ucc1Ref  ${ucc1Ref}`);

  const send = async (label, fn) => {
    if (dry) return console.log("  would send:", label);
    const tx = await fn();
    const r = await tx.wait();
    console.log(`  sent: ${label} · tx ${r.hash} · block ${r.blockNumber}`);
    return r;
  };
  const sent = [];

  // ---- issuer
  const iss = await reg.issuers(issuerId);
  if (iss.account === ethers.ZeroAddress) {
    sent.push(await send(`registerIssuer ${row.code} → ${signer.address}`, () => reg.registerIssuer(issuerId, signer.address)));
  } else if (iss.account !== signer.address) {
    throw new Error(`${row.code} is registered to ${iss.account}, not this signer.`);
  } else console.log(`  issuer ${row.code} already registered`);

  // ---- bond
  const onChain = await reg.bonds(bondId);
  if (onChain.issuerId === ethers.ZeroHash) {
    sent.push(await send(`anchorBond ${bondDisplay} total ${b.total}`, () => reg.anchorBond(bondId, issuerId, BigInt(b.total), b.instrumentHash, ucc1Ref)));
  } else {
    if (onChain.total !== BigInt(b.total) || onChain.instrumentHash !== b.instrumentHash || onChain.ucc1Ref !== ucc1Ref || onChain.issuerId !== issuerId)
      throw new Error(bondDisplay + " is already anchored with different figures.");
    console.log(`  bond already anchored`);
  }

  // ---- prior instruments
  for (const p of plan) {
    const have = await reg.priorInstruments(bondId, p.refHash);
    if (have.recorded) {
      if (have.units !== p.units || have.reversed) throw new Error(`${p.entry} is on-chain with different figures.`);
      console.log(`  ${p.entry} already recorded`);
      continue;
    }
    sent.push(await send(`recordPriorInstrument ${p.entry} ${usd(p.units)}`, () => reg.recordPriorInstrument(bondId, p.refHash, p.units, p.docHash)));
  }

  // ---- check
  if (!dry) {
    const t = await reg.bondTotals(bondId);
    console.log(`On-chain: total ${usd(t[0])} · prior ${usd(t[1])} · live ${usd(t[2])} · unassigned ${usd(t[3])} · redeemed ${usd(t[4])} · reconciled ${t[5]}`);
    const ok = t[0] === BigInt(b.total) && t[1] === priorSum && t[3] === BigInt(b.unassigned) && t[5];
    console.log(ok ? "MATCHES THE REGISTER" : "DOES NOT MATCH THE REGISTER");
    console.log("ANCHOR-RESULT " + JSON.stringify({
      bond: bondDisplay, issuer: row.code, bondId, issuerId, ucc1Ref, instrumentHash: b.instrumentHash,
      priorEntries: plan.map((p) => ({ entry: p.entry, units: p.units.toString(), refHash: p.refHash, docHash: p.docHash })),
      txs: sent.filter(Boolean).map((r) => r.hash), matches: ok,
    }));
    if (!ok) process.exitCode = 1;
  }
}

main().catch((e) => { console.error("ANCHOR-ERROR", e.message || e); process.exit(1); });
