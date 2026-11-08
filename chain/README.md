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
