# Canton pilot (phase two)

The registry's contract model in Daml, run on a local Canton node. Nothing here is wired to the
live registry yet. The design is in the [Canton design doc](https://claude.ai/artifact/WCxQLzY9Zx8MUep8tTVioe).

- `daml/Registry.daml`: the templates. `Bond`, `AssignmentOffer`, `Assignment` and `UnitsReturned`.
  One contract per assignment, one signed paper each (`instrumentHash`); an assign-out needs its
  own paper, and the remainder lists it in `carveOuts`.
- `daml/Tests/RegistryTest.daml`: the rules, checked on Canton's engine.
- `pilot/passkey-signing.mjs`: whether an assignee's own key can act for them on a real Canton
  node, with the node unable to sign for them.

## Running it

Needs the Daml SDK 3.4 (it includes Canton). Where get.daml.com is blocked, the SDK can be taken
from Docker Hub: `docker create digitalasset/daml-sdk:3.4.0-rc2`, then copy `/home/daml/.daml` to `~/.daml`.

```
cd canton
daml build
daml test                                                   # the template tests
daml sandbox --json-api-port 7575 --dar .daml/dist/bond-registry-0.1.0.dar &
node pilot/passkey-signing.mjs                              # signing pilot (key in Node)
BROWSER=1 node pilot/passkey-signing.mjs                    # the same, key made in Chromium's WebCrypto
```

## Results (Nov 19, 2026)

**Templates: 7 of 7 tests pass.** No record without its paper's SHA-256; never more than is left to
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
browser or lost device means a lost key. Canton lets a party hold more than one key, so a second
(backup) key is the next thing to test.

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
