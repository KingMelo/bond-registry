# Bond Interest Registry

A register of assigned interests in a private bond, mirrored to a public blockchain as a tamper-evident record. No holder wallets and no tokens: each assignment is a line on the bond's record, updated as the signed paperwork happens.

- [`docs/workflow-spec.md`](docs/workflow-spec.md) — the workflow spec: data model, contract state machine, workflows, security and open decisions.
- [`prototypes/issuer-console.jsx`](prototypes/issuer-console.jsx) — issuer console demo (approvals queue, bonds, records, event log).
- [`prototypes/holder-portal.jsx`](prototypes/holder-portal.jsx) — holder portal demo (claim, assign out, lock, redeem, request access, public verification).

The two apps share one register in Postgres through a small API server (`server/`). The same server runs twice:

| Service | `APP` | Who uses it |
|---|---|---|
| Holder portal | `holder` | Public: holders sign in with their passkey, request access, verify an assignment |
| Issuer console | `issuer` | Behind `ISSUER_PASSWORD`: approvals, issuing, records, prior instruments |

Passkeys are generated in the issuer console, shown once, and stored only as a salted hash. The holder portal never receives passkeys, addresses or mail numbers. The server refuses any holder change outside the holder-initiated transitions, any save that breaks the units rule, and any save made against a stale copy of the register. Events are append-only in the database.

## Running locally

```
npm install
npm run build
DATABASE_URL=postgres://… APP=holder PORT=4101 npm start
DATABASE_URL=postgres://… APP=issuer PORT=4102 ISSUER_PASSWORD=… npm start
```

An empty database is created and loaded with the sample register on first start. "Reset demo" in the issuer console reloads it for both apps.

Environment variables: `DATABASE_URL` (required), `APP` (`holder` or `issuer`), `ISSUER_PASSWORD` (issuer only), `PASSKEY_PEPPER` (optional, mixed into passkey hashes; set it once and keep it, or existing passkeys stop working), `PGSSL=1` (for databases that need TLS).
