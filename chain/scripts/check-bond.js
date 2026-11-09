// Prints a bond's totals and one record as the contract holds them, and fails if the record's
// last expected write isn't there yet.
//
//   BOND_CODE     e.g. KJPII-0001-BD
//   RECORD_CODE   e.g. KJPII-0001-BD-A00001
//   EXPECT        optional: "delivery" (the mailing reference must be set) or "filing"
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const S = ["None", "AwaitingCredential", "CredentialRequested", "Issued", "Accepted", "Locked", "PendingRedemption", "Redeemed", "Superseded", "Cancelled", "Rejected"];

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", network.name + ".json"), "utf8"));
  const reg = await ethers.getContractAt("BondInterestRegistry", process.env.CONTRACT || dep.address);
  const id = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const t = await reg.bondTotals(id(process.env.BOND_CODE));
  console.log(`BOND ${process.env.BOND_CODE} total ${t[0]} prior ${t[1]} live ${t[2]} unassigned ${t[3]} redeemed ${t[4]}`);
  if (!process.env.RECORD_CODE) return;
  const a = await reg.assignments(id(process.env.RECORD_CODE));
  console.log(`RECORD ${process.env.RECORD_CODE} ${S[Number(a.status)]} units ${a.units} filing ${a.filingRef} delivery ${a.deliveryRef}`);
  const want = process.env.EXPECT;
  if ((want === "delivery" && a.deliveryRef === ethers.ZeroHash) || (want === "filing" && a.filingRef === ethers.ZeroHash) || Number(a.status) === 0)
    throw new Error("Not on-chain yet.");
  console.log("CHECK-OK");
}
main().catch((e) => { console.error("CHECK-FAILED", e.message); process.exit(1); });
