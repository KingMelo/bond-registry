# Bond Interest Registry

A register of assigned interests in private bonds, mirrored to a public blockchain as a tamper-evident record. No holder wallets and no tokens: each assignment is a line on the bond's record, updated as the signed paperwork happens. Any number of issuers can register their bonds; one public registry serves all of them.

- [`docs/workflow-spec.md`](docs/workflow-spec.md) — the workflow spec: data model, contract state machine, workflows, issuer accounts, security and open decisions.
- [`prototypes/issuer-account.jsx`](prototypes/issuer-account.jsx) — issuer sign-in, sign-up, teams and the platform owner's review of new issuers.
- [`prototypes/issuer-console.jsx`](prototypes/issuer-console.jsx) — the issuer console (approvals queue, bonds, records, event log), scoped to one issuer.
- [`prototypes/holder-portal.jsx`](prototypes/holder-portal.jsx) — the public registry (claim, assign out, lock, redeem, request access, verify).

The apps share one register in Postgres through a small API server (`server/`). The same server runs twice:

| Service | `APP` | Who uses it |
|---|---|---|
| Holder portal | `holder` | Public: holders sign in with their passkey, request access, verify an assignment. Shows approved issuers only. |
| Issuer console | `issuer` | Issuer accounts (email and password). Each issuer sees and changes only its own bonds. |

## Issuer accounts

- **Platform owner.** Created once on the issuer console with the setup code in `ADMIN_SETUP_CODE`. The owner approves or suspends issuers from the Platform tab and takes over any issuer with no members, such as the sample `KPII` register.
- **New issuers.** Anyone can create an issuer account with a legal name and a permanent 3–6 character code; bonds are numbered `CODE-0001-BD`. A new issuer is pending: it can register bonds and record prior instruments, but it can't issue assignments, and nothing it does appears on the public registry until the platform owner approves it.
- **Teams.** An issuer's owner creates one-time invite codes (valid seven days) in the Team tab; teammates join with them. Every member can act for now; the 2-of-3 multisig will map to members later.
- **Suspension.** A suspended issuer can't change anything. Its records stay publicly verifiable.

The server enforces all of this: an issuer's requests can only read or change bonds it owns, bond IDs must carry its code, and a bond's total and document hashes can't change after registration. Passwords are scrypt hashes; sessions are HttpOnly cookies that last seven days; cross-site POSTs are refused.

Passkeys are generated in the issuer console, shown once, and stored only as a salted hash. The holder portal never receives passkeys, addresses or mail numbers. The server refuses any holder change outside the holder-initiated transitions, any save that breaks the units rule, and any save made against a stale copy of the register. Events are append-only in the database.

## Running locally

```
npm install
npm run build
DATABASE_URL=postgres://… APP=holder PORT=4101 npm start
DATABASE_URL=postgres://… APP=issuer PORT=4102 ADMIN_SETUP_CODE=… npm start
```

An empty database is created and loaded with the sample register (issuer `KPII`) on first start. A register from before issuer accounts is assigned to `KPII` automatically.

Environment variables: `DATABASE_URL` (required), `APP` (`holder` or `issuer`), `ADMIN_SETUP_CODE` (issuer only; needed until the platform owner account exists), `PASSKEY_PEPPER` (mixed into passkey hashes; set it once and keep it, or existing passkeys stop working), `PGSSL=1` (for databases that need TLS).
