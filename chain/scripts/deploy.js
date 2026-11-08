// Deploys the registry. Role holders come from the environment:
//   ADMIN_ADDRESS     manages roles (use a Safe)
//   PLATFORM_ADDRESS  registers issuers (use a Safe)
//   RELAYER_ADDRESS   the platform's signing key for holder actions
//   GUARDIAN_ADDRESS  can pause in an emergency
// Any that are unset fall back to the deployer, which is only sensible on a testnet.
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const pick = (k) => process.env[k] || deployer.address;
  const roles = { admin: pick("ADMIN_ADDRESS"), platform: pick("PLATFORM_ADDRESS"), relayer: pick("RELAYER_ADDRESS"), guardian: pick("GUARDIAN_ADDRESS") };
  if (network.name === "polygon" && Object.values(roles).includes(deployer.address))
    throw new Error("On mainnet, set ADMIN_ADDRESS, PLATFORM_ADDRESS, RELAYER_ADDRESS and GUARDIAN_ADDRESS to their own addresses.");
  console.log("Network:", network.name, "Deployer:", deployer.address);
  console.log("Roles:", roles);
  const R = await ethers.getContractFactory("BondInterestRegistry");
  const reg = await R.deploy(roles.admin, roles.platform, roles.relayer, roles.guardian);
  await reg.waitForDeployment();
  console.log("BondInterestRegistry:", await reg.getAddress());
}

main().catch((e) => { console.error(e); process.exit(1); });
