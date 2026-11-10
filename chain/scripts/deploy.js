// Deploys the registry. Role holders come from the environment:
//   ADMIN_ADDRESS     manages roles (use a Safe)
//   PLATFORM_ADDRESS  registers issuers (use a Safe)
//   RELAYER_ADDRESS   the platform's signing key for holder actions
//   GUARDIAN_ADDRESS  can pause in an emergency
//   PREDECESSOR       the contract this one replaces (it copies that one's state); unset for none
// Any that are unset fall back to the deployer, which is only sensible on a testnet.
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const pick = (k) => process.env[k] || deployer.address;
  const roles = { admin: pick("ADMIN_ADDRESS"), platform: pick("PLATFORM_ADDRESS"), relayer: pick("RELAYER_ADDRESS"), guardian: pick("GUARDIAN_ADDRESS") };
  if (network.name === "polygon" && Object.values(roles).includes(deployer.address))
    throw new Error("On mainnet, set ADMIN_ADDRESS, PLATFORM_ADDRESS, RELAYER_ADDRESS and GUARDIAN_ADDRESS to their own addresses.");
  console.log("Network:", network.name, "Deployer:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "POL");
  if (balance === 0n) throw new Error("The deployer has no POL for gas. Fund " + deployer.address + " first.");
  const predecessor = process.env.PREDECESSOR ? ethers.getAddress(process.env.PREDECESSOR) : ethers.ZeroAddress;
  console.log("Roles:", roles, "Predecessor:", predecessor);
  const R = await ethers.getContractFactory("BondInterestRegistry");
  const reg = await R.deploy(roles.admin, roles.platform, roles.relayer, roles.guardian, predecessor);
  await reg.waitForDeployment();
  const addr = await reg.getAddress();
  const receipt = await reg.deploymentTransaction().wait();
  console.log("BondInterestRegistry:", addr);
  console.log("Deployed in block", receipt.blockNumber, "tx", receipt.hash, "gas used", receipt.gasUsed.toString());
  if (network.name === "amoy") console.log("Explorer: https://amoy.polygonscan.com/address/" + addr);
  if (network.name === "polygon") console.log("Explorer: https://polygonscan.com/address/" + addr);
}

main().catch((e) => { console.error(e); process.exit(1); });
