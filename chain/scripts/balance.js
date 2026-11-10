// Prints the deployer's POL balance and what a contract deployment would cost at today's gas price.
const { ethers, network } = require("hardhat");
async function main() {
  const [me] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(me.address);
  const fee = await ethers.provider.getFeeData();
  const price = fee.maxFeePerGas || fee.gasPrice || 0n;
  const deploy = 4_400_000n * price, cycle = 7_500_000n * price; // deploy alone; deploy + replay + role move
  console.log(`BALANCE ${network.name} ${me.address} ${ethers.formatEther(bal)} POL · gas ${ethers.formatUnits(price, "gwei")} gwei · deploy ≈ ${ethers.formatEther(deploy)} · full cycle ≈ ${ethers.formatEther(cycle)} POL`);
}
main().catch((e) => { console.error("BALANCE-ERROR", e.message); process.exit(1); });
