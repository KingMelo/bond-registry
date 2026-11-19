# Canton pilot (phase two)

The registry's contract model in Daml, run on a local Canton node. The registry's servers can mirror
to it when `CANTON_JSON_URL` is set (see `server/canton.js`); the live sites don't set it. The design is in the [Canton design doc](https://claude.ai/artifact/WCxQLzY9Zx8MUep8tTVioe).

- `daml/Registry.daml`: the templates. `Bond`, `AssignmentOffer`, `Assignment` and `UnitsReturned`.
  One contract per assignment, one signed paper each (`instrumentHash`); an assign-out needs its
  own paper, and the remainder lists it in `carveOuts`.
- `daml/Tests/RegistryTest.daml`: the rules, checked on Canton's engine.
- `pilot/passkey-signing.mjs`: whether an assignee's own key can act for them on a real Canton
  node, with the node unable to sign for them.
- `pilot/backup-key.mjs`: a backup key, so a lost browser key isn't a lost assignment.

## Running it

Needs the Daml SDK 3.4 (it includes Canton). Where get.daml.com is blocked, the SDK can be taken
from Docker Hub: `docker create digitalasset/daml-sdk:3.4.0-rc2`, then copy `/home/daml/.daml` to `~/.daml`.

```
cd canton
daml build
daml test                                                   # the template tests
daml sandbox --json-api-port 7575 --dar .daml/dist/bond-registry-0.2.0.dar &
node pilot/passkey-signing.mjs                              # signing pilot (key in Node)
BROWSER=1 node pilot/passkey-signing.mjs                    # the same, key made in Chromium's WebCrypto
(cd pilot && npm install && node backup-key.mjs)            # backup key; uses the node's admin API (port 6866)
cd .. && node e2e/canton-e2e.mjs                            # the register and Canton together, in a browser
```

## Results (Nov 19, 2026)

**Templates: all 9 test scripts pass** (7 at first, then numbering and mailing/receipt/UCC-3). No record without its paper's SHA-256; never more than is left to
assign; only the issuer issues; nobody but the assignee acts on an assignment (the issuer can't even
archive it); an assign-out needs its own paper and the one-dash number, and the remainder keeps the
original paper with the new one listed; each holder controls only their portion; a rejection needs
255+ characters and returns the units; outsiders see nothing, the assignee sees only its own, a
trustee named on the bond reads but can't act; deemed acceptance only after 30 days from mailing;
redemption needs the payment confirmation's hash.

**Signing: a passkey can't sign for a Canton party; a browser key can.**

| Signed by | Result |
|---|---|
| A WebAuthn passkey (same P-256 key, as browsers use it) | Refused: Canton checks the signature over the transaction hash itself, and a passkey only ever signs its own wrapper around it |
| The node alone, no signature from the assignee | Refused, both through interactive submission and an ordinary submission |
| A non-extractable WebCrypto P-256 key made in Chromium, signing the hash | Accepted once the signature is converted from r‖s to DER (a few lines in the page) |

So the assignee's Canton key is a WebCrypto key their browser makes and can never export; the
passkey can stay for signing in. The cost: a browser key doesn't sync like a passkey, so a cleared
browser or lost device means a lost key, unless there's a backup key (below).

**Backup key: it works, and the node still can't act on its own.**

| Step | Result |
|---|---|
| Backup key B, before it's added | Can't act for the assignee |
| Adding B with only A's signature | Refused: Canton wants B's own signature too ("missing authorizations by … keys"), so nobody can name a key they don't hold |
| A and B add B, both to sign the party's transactions and to change its keys | Done; A keeps working |
| A is lost: B alone accepts an assignment | Accepted |
| B (with the new key C signing for itself) replaces A with C | Done |
| The lost key A afterwards | Refused, whoever has it now |
| C | Accepted |
| A key that was never registered | Refused, and can't add itself ("not properly authorized by any namespace key") |

How the assignee would hold the backup is a product choice: a recovery key their browser makes once
at setup for them to print and keep offline, a second device of theirs (each device its own key), or both.

**Model findings.**
- *Deemed acceptance.* Canton can't create a contract signed by someone who hasn't signed. After 30
  days the offer is marked in effect (it can no longer be rejected) and becomes an `Assignment` the
  first time the assignee acts.
- *One-dash numbering.* One count across a whole tree under A00001 would have to be visible to every
  holder in it. The platform supplies the next number; the template checks its form, the register its uniqueness.
- *Returning units privately.* A rejected assign-out leaves a `UnitsReturned` record that the assignor
  reclaims, so the new assignee never sees the assignor's own contract.
- *Redemption* is the issuer's choice under the template's terms, as it is today; whether the
  assignee's consent should also be required is for counsel.

## The register and Canton together (Nov 19, 2026)

`e2e/canton-e2e.mjs` runs the registry's three servers against the node, with browsers playing the
assignees. All 44 checks pass:

- Issuing in the register puts the bond and an offer on Canton.
- After the passkey, the assignee makes their keys: a device key the browser stores non-extractable,
  and a recovery code shown once (14 groups of four, with a check so typos are caught), which they
  must confirm by typing its last group. The server keeps only public halves; the code never reaches it.
- Every act made in the register is then signed on Canton with the device key: the assignee's
  delivery receipt, accepting, assigning out (the remainder keeps its paper and lists the new one),
  the assignor's mailing and UCC-3 for that assign-out, a new assignee's receipt and rejection with
  its reason, and the assignor taking the units back.
- The issuer's own mailing and UCC-3 for an assignment it made go on Canton as the issuer's party
  right after it saves them, so nobody else is asked to sign. Each new assignee sets up their own keys
  and sees only their own contracts.
- **Before each signature the page checks the transaction itself** (`src/canton-verify.js`): it
  decodes the prepared transaction, rebuilds Canton's hash from it (hashing scheme V2), and only
  then shows in plain words what it does ("Assign $10.40 of … to Company D, LLC, as …-1. New signed
  paper: 0x93d2…. You keep $9,989.60."). The key signs only after the assignee chooses Sign. A
  server that sends the hash of a different transaction is caught; "Not now" signs nothing.
- On a second browser (passkey synced to it), the recovery code adds that browser's own key; both work.
- "Lost a device? Replace it" with the code drops every other device key: the lost browser's key is
  refused by Canton from then on, the new one works. The register is unaffected throughout.

Not mirrored yet: locks and unlocks, redemption, deemed acceptance, cancelling an unclaimed
assign-out, and records issued before the mirror is switched on. The hash check covers the value
and node kinds these contracts produce (records, text, numbers, dates and times, parties,
optionals, lists, contract IDs, creates, exercises, fetches); a transaction with anything else is
refused rather than signed.

The package is at 0.2.0: changing a template means a new version, since a shared Canton network
keeps every version that was uploaded.
