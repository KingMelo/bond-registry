// Hardhat setup for the registry contract.
// The compiler is the npm build of solc (solcjs), so builds don't depend on
// downloading a native compiler.
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const SOLC = "0.8.28";
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async ({ solcVersion }, hre, runSuper) => {
  if (solcVersion !== SOLC) return runSuper();
  const solc = require("solc");
  return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: SOLC, longVersion: solc.version() };
});

// Deployment needs an RPC endpoint and the deployer's private key, both from the environment.
const key = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];

module.exports = {
  solidity: { version: SOLC, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" } },
  networks: {
    amoy: { url: process.env.AMOY_RPC_URL || "https://polygon-amoy-bor-rpc.publicnode.com", chainId: 80002, accounts: key },
    polygon: { url: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com", chainId: 137, accounts: key },
  },
};
