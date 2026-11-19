# Bond Interest Registry

A register of assigned interests in private bonds. No holder wallets and no tokens: each assignment is a line on the bond's record, updated as the signed paperwork happens. Any number of issuers can register their bonds; one public registry serves all of them.

The register in Postgres is the only record. Polygon was retired in November 2026, before anything went live on it; the next ledger is Canton, for private contracts between the parties, and public notice stays with the UCC filings. See the [Canton design](https://claude.ai/artifact/WCxQLzY9Zx8MUep8tTVioe).

- [`docs/workflow-spec.md`](docs/workflow-spec.md) — the original workflow spec. Its contract and on-chain sections describe the retired Polygon mirror.
- [`prototypes/platform-console.jsx`](prototypes/platform-console.jsx) — the platform's back office: review queue for issuers and bonds, issuer list, bond directory, staff.
- [`prototypes/issuer-account.jsx`](prototypes/issuer-account.jsx) — issuer sign-in, sign-up and teams.
- [`prototypes/issuer-console.jsx`](prototypes/issuer-console.jsx) — the issuer console (approvals queue, bonds, records, event log), scoped to one issuer.
- [`prototypes/holder-portal.jsx`](prototypes/holder-portal.jsx) — the public registry (assignee access, review, accept or reject, assign out, verify).

The apps share one register in Postgres through a small API server (`server/`). The same server runs three times:

| Service | `APP` | Who uses it |
|---|---|---|
| Assignee portal | `holder` | Public, at registry.omni-stance.com. `/` is the front page ([`apps/holder/public/home.html`](apps/holder/public/home.html)); the portal is at `/assignee` (`/assignee?id=<ID>` opens one assignment; the old `/holder` redirects). Assignees open an assignment with its one-time transfer code, set up a passkey, then sign in and act with it. Anyone can verify an assignment. Shows approved issuers only. |
| Issuer console | `issuer` | Issuer accounts (email and password). Each issuer sees and changes only its own bonds. |
| Platform console | `platform` | Platform staff only. Reviews issuers and bonds; directory of every bond's totals. Never shows holder names or contact details. |

## Issuers, bonds and reviews

- **Platform owner and staff.** The owner is created once on the platform console with the setup code in `ADMIN_SETUP_CODE`, and takes over any issuer with no members, such as the sample `KPII` register. The owner invites staff with one-time codes; every staff member can review.
- **Issuers apply.** Anyone can create an issuer account on the issuer console with a legal name and a permanent 3–6 character code. The application waits in the platform's review queue; until it is approved the issuer can't register bonds.
- **Each bond is reviewed.** An approved issuer registers a bond: name, face amount, the SHA-256 hash of its signed instrument, and its UCC-1 financing statement (filing number, office, date and the filed copy's hash), plus an optional master collateral assignment agreement. Files are dropped or chosen and hashed in the browser; they are never uploaded. The UCC-1 can be added after registration, but the bond can't be approved without it, and once approved the UCC-1 is fixed. The bond waits for platform review: the issuer can record prior instruments, but can't issue against it, and it isn't on the public registry. Platform staff approve it, or decline it with a reason the issuer sees. A declined bond can't be changed.
- **The owner's own issuers.** An issuer the platform owner creates (from the issuer console's **New issuer**, signed in with the owner account) is approved immediately, and its bonds go live as soon as they are registered with their UCC-1. Everyone else's issuers and bonds go through both reviews.
- **Directory.** The platform console lists every bond with its total, prior instruments, units assigned, redeemed and unassigned, record counts and document hashes. Holder names and contact details stay between issuers and their holders.
- **Teams.** An issuer's owner creates one-time invite codes (valid seven days) in the Team tab. Every member can act for now; the 2-of-3 multisig will map to members later.
- **Suspension.** A suspended issuer can't change anything. Its live records stay publicly verifiable.

The server enforces all of this: an issuer's requests only reach bonds it owns, bond IDs carry its code, a bond's total and document hashes are fixed at registration, and only platform staff can sign in to the platform console. Each bond and record carries a revision number, so a save made from an out-of-date copy of that record is refused while unrelated changes elsewhere never block it. Passwords are scrypt hashes; sessions are HttpOnly cookies that last seven days; cross-site POSTs are refused.

Passkeys are generated in the issuer console, shown once, and stored only as a salted hash. The holder portal never receives passkeys, addresses or mail numbers. The server refuses any holder change outside the holder-initiated transitions and any save that breaks the units rule. Events are append-only in the database.

**Amounts.** Every amount is stored as a whole number of cents and shown in dollars, so $9,428.87 is recorded exactly and the units rule never has to round. Amount boxes accept "$", commas and up to two decimal places. A register from before cents is converted once, on first start.

## Running locally

```
npm install
npm run build
DATABASE_URL=postgres://… APP=holder PORT=4101 npm start
DATABASE_URL=postgres://… APP=issuer PORT=4102 npm start
DATABASE_URL=postgres://… APP=platform PORT=4103 ADMIN_SETUP_CODE=… npm start
```

An empty database is created and loaded with the sample register (issuer `KPII`) on first start. A register from before issuer accounts is assigned to `KPII` automatically.

Environment variables: `DATABASE_URL` (required), `APP` (`holder` or `issuer`), `ADMIN_SETUP_CODE` (platform console only; needed until the platform owner account exists), `PASSKEY_PEPPER` (mixed into passkey hashes; set it once and keep it, or existing passkeys stop working), `PGSSL=1` (for databases that need TLS), `SEED_SAMPLE=0` (start an empty database with no sample issuer), `ISSUER_URL` (holder site only; where the front page's Issuer sign-in button goes, defaults to the live issuer console). Assignee passkeys: `HOLDER_RP_ID` and `HOLDER_ORIGIN` (the site passkeys belong to; default to the request's host). Password reset (issuer and platform consoles): `RESEND_API_KEY` (a Resend API key; without it the Forgot password form says reset isn't set up), `MAIL_FROM` (sender, e.g. `Bond Registry <no-reply@yourdomain.com>` on a domain verified in Resend; defaults to Resend's test sender, which only delivers to the Resend account's own address) and optionally `PUBLIC_URL` (the console's address for the link in the email; defaults to the Railway domain).

## Assignee signatures

Every act an assignee takes on their own assignment (accept, reject, lock, assign out, and recording a mailing, delivery receipt or assign-out UCC-3) is signed with their passkey. The server builds the challenge from the act itself, the signer and a count that only goes up, checks the signature before saving, and keeps it in `holder_signatures`, so each act can be checked again later against the record's public key. Nobody can reset or replace an assignee's passkey.

## Tests

With Postgres on 127.0.0.1:54329 (trust auth) and the apps built:

```
node e2e/holder-keys-e2e.mjs       # passkey rules, signed acts, re-verifies every kept signature
node e2e/holder-browser-e2e.mjs    # the assignee portal in a browser, with a virtual passkey
```
