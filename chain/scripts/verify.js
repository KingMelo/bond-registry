// Publishes the deployed contract's source on Polygonscan (Etherscan API v2).
//
//   ETHERSCAN_API_KEY   an Etherscan key; it works for every Etherscan-family explorer
//
// Sends the exact compiler input Hardhat used (standard JSON), so the explorer rebuilds the
// same bytecode. Before sending, it checks that a local build matches the code on-chain.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers, network, artifacts } = hre;

const API = "https://api.etherscan.io/v2/api";
const NAME = "contracts/BondInterestRegistry.sol:BondInterestRegistry";

async function call(params, post) {
  const chainid = String(network.config.chainId);
  const body = new URLSearchParams({ chainid, apikey: process.env.ETHERSCAN_API_KEY, ...params });
  const r = post
    ? await fetch(API + "?chainid=" + chainid, { method: "POST", body })
    : await fetch(API + "?" + body.toString());
  return r.json();
}

async function main() {
  if (!process.env.ETHERSCAN_API_KEY) throw new Error("Set ETHERSCAN_API_KEY.");
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", network.name + ".json"), "utf8"));
  await hre.run("compile", { quiet: true });

  // 1. The local build must be the code that is on-chain.
  const art = await artifacts.readArtifact("BondInterestRegistry");
  const onChain = await ethers.provider.getCode(dep.address);
  if (onChain.toLowerCase() !== art.deployedBytecode.toLowerCase())
    throw new Error("The local build doesn't match the code at " + dep.address + "; check out the deploy commit (" + dep.commit + ").");
  console.log("Local build matches the deployed code at", dep.address);

  // 2. Already verified?
  const existing = await call({ module: "contract", action: "getsourcecode", address: dep.address });
  if (existing.status === "1" && existing.result?.[0]?.SourceCode) {
    console.log("Already verified:", existing.result[0].ContractName, existing.result[0].CompilerVersion);
    return done(dep);
  }

  // 3. Submit the standard JSON input and the constructor arguments.
  const build = await artifacts.getBuildInfo(NAME);
  const r = dep.roles;
  // v5 and later take the predecessor's address too (zero for none).
  const args = (dep.predecessor !== undefined
    ? ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address", "address"], [r.admin, r.platform, r.relayer, r.guardian, dep.predecessor || ethers.ZeroAddress])
    : ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address"], [r.admin, r.platform, r.relayer, r.guardian])).slice(2);
  const sub = await call({
    module: "contract", action: "verifysourcecode", contractaddress: dep.address,
    sourceCode: JSON.stringify(build.input), codeformat: "solidity-standard-json-input",
    contractname: NAME, compilerversion: "v" + build.solcLongVersion.replace(/\.Emscripten\.clang$/, ""),
    constructorArguements: args, // sic: the API's own spelling
  }, true);
  if (sub.status !== "1") throw new Error("Submission refused: " + sub.result);
  console.log("Submitted; guid", sub.result);

  // 4. Poll until the explorer has rebuilt it.
  for (let i = 0; i < 120; i++) { // the explorer's queue can take several minutes
    await new Promise((res) => setTimeout(res, 5000));
    const st = await call({ module: "contract", action: "checkverifystatus", guid: sub.result });
    console.log("  status:", st.result);
    if (/Pass - Verified|Already Verified/i.test(st.result)) return done(dep);
    if (st.status === "0" && !/Pending/i.test(st.result)) throw new Error("Verification failed: " + st.result);
  }
  throw new Error("Timed out waiting for verification.");
}

function done(dep) {
  const host = network.name === "polygon" ? "https://polygonscan.com" : "https://amoy.polygonscan.com";
  console.log("VERIFIED " + host + "/address/" + dep.address + "#code");
}

main().catch((e) => { console.error("VERIFY-ERROR", e.message || e); process.exit(1); });
