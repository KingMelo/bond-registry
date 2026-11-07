# Bond Interest Registry

A register of assigned interests in private bonds, mirrored to a public blockchain as a tamper-evident record. No holder wallets and no tokens: each assignment is a line on the bond's record, updated as the signed paperwork happens. Any number of issuers can register their bonds; one public registry serves all of them.

- [`docs/workflow-spec.md`](docs/workflow-spec.md) — the workflow spec: data model, contract state machine, workflows, issuer accounts, security and open decisions.
- [`prototypes/platform-console.jsx`](prototypes/platform-console.jsx) — the platform's back office: review queue for issuers and bonds, issuer list, bond directory, staff.
- [`prototypes/issuer-account.jsx`](prototypes/issuer-account.jsx) — issuer sign-in, sign-up and teams.
- [`prototypes/issuer-console.jsx`](prototypes/issuer-console.jsx) — the issuer console (approvals queue, bonds, records, event log), scoped to one issuer.
- [`prototypes/holder-portal.jsx`](prototypes/holder-portal.jsx) — the public registry (claim, assign out, lock, redeem, request access, verify).

The apps share one register in Postgres through a small API server (`server/`). The same server runs three times:

| Service | `APP` | Who uses it |
|---|---|---|
| Holder portal | `holder` | Public: holders sign in with their passkey, request access, verify an assignment. Shows approved issuers only. |
| Issuer console | `issuer` | Issuer accounts (email and password). Each issuer sees and changes only its own bonds. |
| Platform console | `platform` | Platform staff only. Reviews issuers and bonds; directory of every bond's totals. Never shows holder names or contact details. |

## Issuers, bonds and reviews

- **Platform owner and staff.** The owner is created once on the platform console with the setup code in `ADMIN_SETUP_CODE`, and takes over any issuer with no members, such as the sample `KPII` register. The owner invites staff with one-time codes; every staff member can review.
- **Issuers apply.** Anyone can create an issuer account on the issuer console with a legal name and a permanent 3–6 character code. The application waits in the platform's review queue; until it is approved the issuer can't register bonds.
- **Each bond is reviewed.** An approved issuer registers a bond (name, total units, and the SHA-256 hashes of its signed instrument and interest declaration, computed in the browser). The bond waits for platform review: the issuer can record prior instruments, but can't issue against it, and it isn't on the public registry. Platform staff approve it, or decline it with a reason the issuer sees. A declined bond can't be changed.
- **Directory.** The platform console lists every bond with its total, prior instruments, units assigned, redeemed and unassigned, record counts and document hashes. Holder names and contact details stay between issuers and their holders.
- **Teams.** An issuer's owner creates one-time invite codes (valid seven days) in the Team tab. Every member can act for now; the 2-of-3 multisig will map to members later.
- **Suspension.** A suspended issuer can't change anything. Its live records stay publicly verifiable.

The server enforces all of this: an issuer's requests only reach bonds it owns, bond IDs carry its code, a bond's total and document hashes are fixed at registration, and only platform staff can sign in to the platform console. Each bond and record carries a revision number, so a save made from an out-of-date copy of that record is refused while unrelated changes elsewhere never block it. Passwords are scrypt hashes; sessions are HttpOnly cookies that last seven days; cross-site POSTs are refused.

Passkeys are generated in the issuer console, shown once, and stored only as a salted hash. The holder portal never receives passkeys, addresses or mail numbers. The server refuses any holder change outside the holder-initiated transitions and any save that breaks the units rule. Events are append-only in the database.

## Running locally

```
npm install
npm run build
DATABASE_URL=postgres://… APP=holder PORT=4101 npm start
DATABASE_URL=postgres://… APP=issuer PORT=4102 npm start
DATABASE_URL=postgres://… APP=platform PORT=4103 ADMIN_SETUP_CODE=… npm start
```

An empty database is created and loaded with the sample register (issuer `KPII`) on first start. A register from before issuer accounts is assigned to `KPII` automatically.

Environment variables: `DATABASE_URL` (required), `APP` (`holder` or `issuer`), `ADMIN_SETUP_CODE` (platform console only; needed until the platform owner account exists), `PASSKEY_PEPPER` (mixed into passkey hashes; set it once and keep it, or existing passkeys stop working), `PGSSL=1` (for databases that need TLS), `SEED_SAMPLE=0` (start an empty database with no sample issuer).
