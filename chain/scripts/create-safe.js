// Creates a Safe (v1.4.1, Safe's canonical deployment) owned by SAFE_OWNERS with SAFE_THRESHOLD.
//
//   SAFE_OWNERS      comma-separated owner addresses, e.g. the issuer's own wallet
//   SAFE_THRESHOLD   signatures required (default 1)
//   DEPLOYER_KEY     pays the gas only; it is not an owner and has no control over the Safe
//
// Uses the L2 singleton (it emits events per transaction, which explorers and indexers read)
// and the standard fallback handler, exactly as the Safe app does.
const { ethers, network } = require("hardhat");

const V141 = {
  singletonL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
};
const FACTORY_ABI = [
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address indexed proxy, address singleton)",
];
const SAFE_ABI = [
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
];

async function main() {
  const owners = String(process.env.SAFE_OWNERS || "").split(",").map((s) => s.trim()).filter(Boolean).map((a) => ethers.getAddress(a));
  const threshold = Number(process.env.SAFE_THRESHOLD || 1);
  if (!owners.length) throw new Error("Set SAFE_OWNERS.");
  if (threshold < 1 || threshold > owners.length) throw new Error("SAFE_THRESHOLD must be between 1 and the number of owners.");
  const [payer] = await ethers.getSigners();
  console.log(`${network.name} · owners ${owners.join(", ")} · threshold ${threshold} · gas paid by ${payer.address}`);

  // Safe's contracts must already exist here; nothing is deployed if they don't.
  for (const [name, addr] of Object.entries(V141)) {
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") throw new Error(`Safe's ${name} isn't deployed on ${network.name} at ${addr}.`);
  }
  console.log("Safe v1.4.1 contracts found on", network.name);

  const safeIface = new ethers.Interface(SAFE_ABI);
  const initializer = safeIface.encodeFunctionData("setup", [
    owners, threshold, ethers.ZeroAddress, "0x", V141.fallbackHandler, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const factory = new ethers.Contract(V141.proxyFactory, FACTORY_ABI, payer);
  const saltNonce = BigInt(Date.now());
  const tx = await factory.createProxyWithNonce(V141.singletonL2, initializer, saltNonce);
  let receipt = null;
  for (let i = 0; i < 90 && !receipt; i++) {
    receipt = await ethers.provider.getTransactionReceipt(tx.hash).catch(() => null);
    if (!receipt) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!receipt || receipt.status !== 1) throw new Error("Safe creation didn't confirm: " + tx.hash);
  const ev = receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((p) => p?.name === "ProxyCreation");
  const safeAddr = ev.args.proxy;

  // Read it back from the chain.
  const safe = new ethers.Contract(safeAddr, SAFE_ABI, ethers.provider);
  let gotOwners = [], gotThreshold = 0n, version = "";
  for (let i = 0; i < 10; i++) {
    try { [gotOwners, gotThreshold, version] = await Promise.all([safe.getOwners(), safe.getThreshold(), safe.VERSION()]); break; }
    catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
  const ok = gotOwners.length === owners.length && owners.every((o) => gotOwners.includes(o)) && Number(gotThreshold) === threshold;
  console.log(`SAFE-CREATED ${safeAddr} · version ${version} · owners ${gotOwners.join(", ")} · threshold ${gotThreshold} · tx ${tx.hash} · block ${receipt.blockNumber}`);
  console.log(ok ? "SAFE-OK owners and threshold match" : "SAFE-MISMATCH");
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.error("SAFE-ERROR", e.message || e); process.exit(1); });
