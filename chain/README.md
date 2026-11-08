# Registry contract (Polygon PoS)

`contracts/BondInterestRegistry.sol` is the on-chain mirror of the register described in
[`docs/workflow-spec.md`](../docs/workflow-spec.md#smart-contract). It holds every bond and
assignment record, enforces the status rules and the units rule
(`prior + live + unassigned + redeemed == total`, one unit = one cent), and refuses any write
without a document hash. Nobody holds tokens and nothing is transferable.

```sh
cd chain
npm install
npm test            # 41 tests, including a 1,500-step randomized run of the units rule
npm run build
```

The compiler is the npm build of solc 0.8.28, so no native compiler download is needed.

## Deployed

| Network | Address |
|---|---|
| Polygon Amoy (testnet, chain 80002) | [`0x91312fB0c4eEe48031EF4a0C6b53A89A943109c8`](https://amoy.polygonscan.com/address/0x91312fB0c4eEe48031EF4a0C6b53A89A943109c8) |

Details in [`deployments/amoy.json`](deployments/amoy.json). On Amoy all four roles sit on the
testnet deployer wallet; nothing is on mainnet.

## Deploying

Testnet first (Polygon Amoy, chain 80002), with a funded deployer key:

```sh
DEPLOYER_KEY=0x… npm run deploy:amoy   # AMOY_RPC_URL defaults to publicnode's Amoy endpoint
```

Mainnet (`npm run deploy:polygon`) refuses to run unless `ADMIN_ADDRESS`, `PLATFORM_ADDRESS`,
`RELAYER_ADDRESS` and `GUARDIAN_ADDRESS` are set to their own addresses. An external audit
comes before mainnet.

## IDs

All IDs are `bytes32`: `keccak256` of the display ID (`KPII-0001-BD`,
`KPII-0001-BD-A00001`) and of the issuer code (`KPII`). Prior instruments use `keccak256`
of their identifier; their holder name and mailing number stay off-chain.

## How the app writes to it

`server/chain.js` turns every save into the contract calls it implies and queues them in the
`chain_ops` table, in the same database transaction as the save. One sender (the service with
`CHAIN_WORKER=1`, the issuer console) works through the queue in order:

- Before each call it reads the chain; a change that is already there is marked confirmed
  without a transaction. That makes restarts, retries and bonds anchored by
  `scripts/anchor.js` safe.
- It records each transaction hash as soon as it's sent, and after a restart checks the receipt
  instead of sending again.
- A call the contract refuses is marked failed and holds back later calls on the same bond.
  The platform console's Chain tab lists it with the reason, and the owner can retry it.

| App action | Contract call | Signs on mainnet |
|---|---|---|
| Bond approved | `registerIssuer` (once), `anchorBond`, `recordPriorInstrument` each | platform / issuer |
| Prior instrument added / reversed | `recordPriorInstrument` / `reversePriorInstrument` | issuer |
| Issue / replace an assignment | `issueAssignment` / `replaceAssignment` | issuer |
| UCC-3 filing / mailing recorded | `setFilingRef` / `setDeliveryRef` | issuer |
| Holder accepts, assigns out, requests access, locks, requests redemption | `accept`, `assignOut`, `requestCredential`, `lock`, `requestRedemption` | relayer |
| Holder cancels an unclaimed assign-out | `cancelAssignOut` | relayer |
| Issuer cancels, rejects or issues a credential, unlocks, rotates a passkey, decides a redemption | `issuerCancelAssignOut`, `rejectCredentialRequest`, `issueCredential`, `unlock`, `recordRotation`, `approveRedemption` / `rejectRedemption` | issuer |
| Issuer suspended / reinstated | `suspendIssuer` / `reinstateIssuer` | platform |

On the testnet one key signs everything. On mainnet issuer calls must come from each issuer's
Safe, so they become Safe proposals rather than direct sends; that part isn't built yet.

New records need the SHA-256 of their signed instrument (issue, replacement, assign-out); the
consoles hash it in the browser. Filing and mailing numbers stay in the register and go on-chain
as hashes (`filing/v1`, `delivery/v1` in `server/chain.js`).
