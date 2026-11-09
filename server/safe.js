// Safe (multisig) support for chain writes.
//
// When a role is held by a Safe, the sender doesn't send the call itself. It wraps it in a Safe
// transaction, asks the Safe's owners to sign it (EIP-712, e.g. on a Trezor), and once enough
// valid owner signatures are in, submits Safe.execTransaction from the platform's key, which only
// pays the gas. The Safe checks the signatures on-chain; the registry sees the Safe as the caller.
import { ethers } from "ethers";

export const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
  "event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash, uint256 payment)",
];

const TYPES = {
  SafeTx: [
    { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

/** A plain call from the Safe to `to`, with no gas refunds: the platform pays the gas itself. */
export function buildSafeTx({ safe, chainId, to, data, nonce }) {
  const message = {
    to, value: "0", data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0",
    gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce: String(nonce),
  };
  const domain = { chainId: Number(chainId), verifyingContract: safe };
  return { safe, chainId: Number(chainId), domain, message, hash: ethers.TypedDataEncoder.hash(domain, TYPES, message) };
}

/**
 * The full EIP-712 payload for a wallet to sign, plus the two hashes that devices which can't
 * show structured data (such as a Trezor Model One) sign instead.
 */
export function typedDataFor(stx) {
  return {
    types: { EIP712Domain: [{ name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...TYPES },
    primaryType: "SafeTx",
    domain: stx.domain,
    message: stx.message,
    domainSeparatorHash: ethers.TypedDataEncoder.hashDomain(stx.domain),
    messageHash: ethers.TypedDataEncoder.from(TYPES).hash(stx.message),
    safeTxHash: stx.hash,
  };
}

/** The address that produced `signature` over this Safe transaction. */
export function signerOf(stx, signature) {
  return ethers.verifyTypedData(stx.domain, TYPES, stx.message, signature);
}

/** Signatures in the form Safe expects: 65 bytes each (r, s, v), sorted by signer address. */
export function packSignatures(sigs) {
  return "0x" + [...sigs]
    .sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1))
    .map((s) => {
      const sig = ethers.Signature.from(s.signature);
      return sig.r.slice(2) + sig.s.slice(2) + sig.v.toString(16).padStart(2, "0");
    })
    .join("");
}

export async function safeState(provider, safe) {
  const c = new ethers.Contract(safe, SAFE_ABI, provider);
  const [owners, threshold, nonce] = await Promise.all([c.getOwners(), c.getThreshold(), c.nonce()]);
  return { owners: owners.map((o) => ethers.getAddress(o)), threshold: Number(threshold), nonce: Number(nonce) };
}

export function execArgs(stx, sigs) {
  const m = stx.message;
  return [m.to, m.value, m.data, m.operation, m.safeTxGas, m.baseGas, m.gasPrice, m.gasToken, m.refundReceiver, packSignatures(sigs)];
}
