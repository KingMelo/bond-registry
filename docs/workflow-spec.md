# Bond Interest Registry: Workflow Spec

Oct 17, 2026 · King Penson · Revision 2

## Overview and design principles

The private bond stays whole and off-chain. A defined interest in it is divided into integer units, and each assignment of units becomes an on-chain record that holders claim and manage through a web app with a passkey delivered by certified mail. The signed instruments and the register are the legal record; the blockchain is the public, tamper-evident verification layer on top of them.

The registry is a ledger, not a token. Each bond is one record, and every assignment adds a new line beneath it. No line is ever erased. Nobody holds a wallet, nothing can be sent between addresses, and there are no balances tied to anyone. The contract holds records (ID, parent, units, status, document hashes) and updates them as the paperwork happens.

Principles:

- **Register controls.** The append-only register is the controlling record of holders. The chain mirrors it and proves it has not been altered.
- **No paper, no record.** Every on-chain change carries the SHA-256 hash of the signed document that authorizes it. The contract rejects a write without one. Paper is signed first; the chain is written second.
- **No holder wallets.** Holders act through the app with a passkey. The platform's relayer signs on-chain writes; holders never manage keys.
- **Secrets never touch the chain.** Only salted hashes of passkeys exist, and only off-chain. On-chain records carry IDs, units, status, document hashes and filing references.
- **Human approval on consequential actions.** Redemption, unlock, passkey reissue, new-holder credential issuance, disputed cancellations and replacements pass through the issuer multisig.
- **Append-only history.** Nothing is edited or deleted. Corrections are new records that point back to what they correct.
- **Three matching entries per on-chain change.** Every change to on-chain state writes an app audit log entry, a register entry and an on-chain event, linked by assignment ID. Off-chain-only actions (credential lockout, holder requests) write the audit log and register.
- **Locked by default.** Any units without a verified, accepted holder are locked and cannot be acted on.
- **Units are conserved.** Units are never created or destroyed after a bond is anchored. They move between records, back to the unassigned pool on cancellation, or into the retired pool on redemption.

## Decisions in this revision

| # | Decision |
|---|---|
| 1 | `cancelAssignOut` moves units back to the parent and never changes the parent's status. It is refused while the parent is PendingRedemption. |
| 2 | A parent with zero units stays live until every pending child is accepted or cancelled. It becomes Superseded automatically when the last one is accepted. Terminal records never revive. |
| 3 | The holder may cancel an assign-out alone only while the child is AwaitingCredential. Once the assignee requests access, only the issuer may cancel, as a dispute. After Issued, no one may cancel. |
| 4 | Redeemed units are retired permanently in `redeemedUnits` and can never be issued again. |
| 5 | Requester name, position and contact are kept in the register. A hash of the request goes in the `CredentialRequested` event. |
| 6 | The issuer can record instrument and passkey mailings on any live record. Missing mailings appear in the approvals queue. |
| 7 | Holders request an unlock or a new passkey in the app. The request is off-chain only; only the issuer's action is written on-chain. |
| 8 | New issuer function `rejectCredentialRequest` returns a child from CredentialRequested to AwaitingCredential. |
| 9 | New issuer function `replaceAssignment` supersedes a record and creates a replacement with the same units, backed by a supporting document. |
| 10 | Redemption covers the whole record. To redeem part, the holder first assigns that portion out to themselves. |
| 11 | Instrument language (for counsel) sets out when an interest passes and the issuer's non-liability for off-register dealings. |
| 12 | No paper, no record: every on-chain change requires a document hash. |
| 13 | Unlocking a record locked for a pledge requires the pledgee's signed release. |
| 14 | The assignor files the UCC-3 for a child. The issuer will not issue the child's credential until the filing is recorded, and may file it instead after the 30-day window. |

## System architecture

Three trust zones keep secrets private and status public: people act through the platform, the platform writes to the chain through a limited relayer, and the issuer multisig is the only path for consequential actions.

The verify page reads the contract directly through a public RPC endpoint, so verification does not depend on the platform's own database.

Stack: Next.js front end, a TypeScript API service, PostgreSQL with append-only tables, encrypted object storage for documents, a cloud KMS for the relayer key and passkey pepper, and a Safe multisig (2 of 3) for the issuer. Network: Polygon PoS (chain 137).

## Data model

Each assignment exists in three linked places: an on-chain record (public, minimal), a register entry (controlling, private) and a credential record (secret, off-chain only).

### On-chain bond record

| Field | Type | Notes |
|---|---|---|
| bondId | bytes32 | |
| instrumentHash | bytes32 | SHA-256 of the bond instrument |
| declarationHash | bytes32 | SHA-256 of the interest declaration |
| totalUnits | uint256 | Fixed at anchoring |
| unassignedUnits | uint256 | Available for the issuer to assign |
| redeemedUnits | uint256 | Retired by redemption; never reissued |

### On-chain assignment record

| Field | Type | Notes |
|---|---|---|
| assignmentId | bytes32 | Unique, non-sequential ID (random or hash-derived). Documents may also carry a human-readable display ID. |
| bondId | bytes32 | Links to the anchored bond record |
| parentId | bytes32 | Zero for issuer-originated assignments |
| origin | enum | Issuer, AssignOut or Replacement |
| units | uint256 | Current units held under this record |
| pendingChildren | uint32 | Children created by `assignOut` that are not yet Accepted or Cancelled |
| status | enum | See the state machine below |
| docHash | bytes32 | SHA-256 of the signed assignment instrument |
| filingRef | bytes32 | Hash of UCC-3 filing number and date |
| deliveryRef | bytes32 | Hash of certified mail numbers |
| updatedAt | uint64 | Block timestamp of the last change |

### Off-chain register entry (controlling)

Assignment ID and display ID, holder legal name and contact, units, parent ID, instrument PDF and hash, delivery records, UCC-3 filing details and who filed, credential request details (requester, position, contact, date), lock reason and supporting documents, holder requests (unlock, rotation), status history, approvals.

### Off-chain credential record (secret)

Assignment ID, passkey hash (Argon2id, per-record salt), created and rotated timestamps, failed-attempt counter, lockout state. Never exported, never filed, never on-chain.

### Invariant

For every bond:

```
sum(units of live records) + unassignedUnits + redeemedUnits == totalUnits
```

Live means any status other than Redeemed, Superseded or Cancelled. The contract enforces this on every write. A Redeemed record keeps its `units` value as history; those units are counted once, in `redeemedUnits`.

## Smart contract

One registry contract holds every bond and assignment record. Three roles separate who can do what, and every function emits an event carrying the assignment ID and the authorizing document hash.

### Roles

| Role | Held by | Can do |
|---|---|---|
| ISSUER | Safe multisig, 2 of 3 | Anchor bonds, issue assignments, issue or reject credentials, cancel disputed children, unlock, approve or reject redemption, record rotations, replace assignments, record filings and deliveries |
| RELAYER | Platform signing key in a cloud KMS/HSM | Holder-initiated transitions only: accept, assign out, cancel assign-out (AwaitingCredential only), request credential, lock, request redemption |
| GUARDIAN | Separate key or the same multisig | Pause and unpause the contract in an emergency |

The relayer can never redeem, unlock, activate a new holder, or cancel a child after the assignee has come forward. If it were compromised, the worst it could do is create child records that stay locked until the issuer acts, or cancel children nobody has claimed yet. Every relayer write needs a document hash that reconciliation will check against the register.

### Statuses

AwaitingCredential, CredentialRequested, Issued, Accepted, Locked, PendingRedemption, Redeemed, Superseded, Cancelled.

Redeemed, Superseded and Cancelled are terminal. No function accepts a terminal record as input, and no function moves units into one.

### Functions and transitions

Every function below takes a `docHash` (or `refHash`) argument and reverts if it is zero.

| Function | Caller | Requires | Effect |
|---|---|---|---|
| anchorBond | ISSUER | new bondId | Bond record created; all units unassigned |
| issueAssignment | ISSUER | units ≤ unassignedUnits | New record Issued, origin Issuer; units taken from unassigned |
| setDeliveryRef | ISSUER | live record | Reference stored; status unchanged |
| setFilingRef | ISSUER | live record | Reference stored; status unchanged |
| accept | RELAYER | Issued | Accepted. If origin AssignOut: parent.pendingChildren −1, and the parent becomes Superseded if it now has 0 units and 0 pending children |
| assignOut | RELAYER | parent Accepted, 0 < units ≤ parent.units | Parent loses units, pendingChildren +1, status unchanged. Child AwaitingCredential, origin AssignOut |
| cancelAssignOut | RELAYER | child AwaitingCredential; parent not PendingRedemption | Child Cancelled; units back to parent; parent.pendingChildren −1; parent status unchanged |
| cancelAssignOut | ISSUER | child AwaitingCredential or CredentialRequested; parent not PendingRedemption | Same as above, with a reason hash |
| requestCredential | RELAYER | AwaitingCredential | CredentialRequested; event carries hash of the request |
| rejectCredentialRequest | ISSUER | CredentialRequested | AwaitingCredential; event carries reason hash |
| issueCredential | ISSUER | CredentialRequested, filingRef set | Issued |
| lock | RELAYER | Accepted | Locked; event carries hash of the holder's lock notice |
| unlock | ISSUER | Locked | Accepted; event carries hash of the pledgee's release (pledge) or the identity verification memo (other) |
| recordRotation | ISSUER | Locked | Status unchanged; event carries hash of the identity verification memo |
| requestRedemption | RELAYER | Accepted, units > 0, pendingChildren = 0 | PendingRedemption; frozen |
| approveRedemption | ISSUER | PendingRedemption | Redeemed (terminal); redeemedUnits += units |
| rejectRedemption | ISSUER | PendingRedemption | Accepted; event carries reason hash |
| replaceAssignment | ISSUER | Accepted or Issued, pendingChildren = 0 | Old record Superseded; new record Issued with the same units, parentId = old record, origin Replacement |

Notes:

- `pendingChildren = 0` on `requestRedemption` and `replaceAssignment` is what stops units from ever returning to a terminal record. A holder resolves their open transfers first.
- A record with 0 units and pending children is still Accepted (or Locked) but can do nothing: `assignOut` and `requestRedemption` both need units.
- Replacing a Locked record is not allowed. Unlock it first, with the pledgee's release where there is a pledge, so a pledge can't be dropped by replacement.
- Replacement keeps units unchanged. Changing units by correction is an open decision.

### Events

BondAnchored, AssignmentIssued, Accepted, AssignedOut, AssignOutCancelled, CredentialRequested, CredentialRequestRejected, CredentialIssued, Locked, Unlocked, RedemptionRequested, Redeemed, RedemptionRejected, PasskeyRotated, AssignmentReplaced, FilingRecorded, DeliveryRecorded. Each carries assignmentId, actor role and the authorizing document hash.

### Build notes

- Solidity with OpenZeppelin AccessControl, Pausable and ReentrancyGuard; no token transfers or payable functions.
- Non-upgradeable core contract. A new version is deployed and records migrated with a published mapping, so history is never rewritten by an upgrade.
- Unit tests for every transition and every forbidden transition; invariant fuzzing (Foundry) on the units rule and on "no write to a terminal record"; an external audit before mainnet.

## Passkey lifecycle

Each assignment has one passkey, generated by the issuer, delivered by certified mail separately from the assignment, and stored only as a salted hash.

### Format

Fully random: 16 characters from a CSPRNG, base32 without ambiguous characters (no 0/O, 1/I/L), printed in groups of four, for example `7KQM-R4XW-9TPH-C2NV`. About 80 bits of randomness.

### Storage and checking

- Hash with Argon2id and a per-record salt; keep a server-side pepper in the KMS.
- Compare in constant time. Never log the passkey or echo it back.
- Lock the credential after 5 failed attempts; clearing the lockout requires issuer identity verification. This is off-chain only.
- Rate-limit attempts per assignment ID and per IP.

### Delivery

1. The assignment instrument goes by certified mail, return receipt.
2. The passkey document goes in a separate certified mailing, on a different day.
3. Both certified numbers are recorded in the register and hashed into deliveryRef on-chain.
4. The passkey document is marked confidential and never attached to filings, exhibits or copies given to third parties.

### Step-up

- A one-time code to the holder's verified email or phone is **required** to assign out or request redemption.
- At first claim the holder may also register a device passkey (WebAuthn). Later actions then need the mailed passkey plus the device. Optional.

### Rotation and recovery

The holder locks the record and requests a new passkey in the app. The issuer verifies identity, generates and mails a new passkey, discards the old hash and calls `recordRotation`. The record stays Locked until the issuer unlocks it.

## Workflows

### A. Bond setup (issuer, once per bond)

1. Hash the bond instrument and the interest declaration (SHA-256); store the PDFs in encrypted, versioned storage.
2. Register: create the bond entry with total units.
3. On-chain: `anchorBond` (multisig) with both hashes and totalUnits. Event BondAnchored.

### B. Issue an assignment (issuer to first holder)

1. Issuer console: enter holder details and units; generate assignmentId; render the assignment PDF with QR code (verification URL plus assignmentId only).
2. Holder and issuer sign the instrument; hash the signed PDF.
3. Generate the passkey; store its hash; render the separate passkey document.
4. On-chain: `issueAssignment` (multisig) with units and docHash. Status Issued.
5. Mail both documents separately by certified mail; record numbers; `setDeliveryRef`.
6. File the UCC-3 (section below); `setFilingRef`.

### C. Claim (holder)

1. Holder scans the QR code; the public verification page opens.
2. Holder selects Claim and enters the passkey.
3. App: verify the hash, check status is Issued, optionally register a device passkey.
4. On-chain: relayer calls `accept`. Status Accepted. If this was a child, the parent's pending count drops and the parent closes as Superseded if it has nothing left.
5. Register: record acceptance date. Holder gets a confirmation with the transaction hash.

### D. Assign out (holder to new holder)

1. Holder signs in with the passkey and step-up code, and enters units and the new holder's legal name, contact and address.
2. App: generate childId; produce the child assignment PDF; holder signs electronically; hash it.
3. On-chain: relayer calls `assignOut` with that hash. Parent units reduced; parent status unchanged. Child AwaitingCredential, locked.
4. Holder delivers the child assignment to the new holder. No passkey is ever shown to the transferring holder.
5. Assignor files the UCC-3 for the child and sends the acknowledgment to the issuer. Issuer records it with `setFilingRef`.
6. New holder scans the child QR code and selects Request access; enters name, position and contact. On-chain: `requestCredential` with a hash of the request. From here the assignor can no longer cancel alone.
7. Issuer verifies the requester matches the named assignee (ID check, contact match, call). If not, `rejectCredentialRequest` returns the child to AwaitingCredential.
8. Issuer confirms the filing is recorded. If the assignor has not filed within 30 days of the request, the issuer may file it instead.
9. Issuer generates the child passkey and mails it by certified mail; records the number.
10. On-chain: `issueCredential` (multisig) and `setDeliveryRef`. Status Issued.
11. New holder claims (workflow C). The transfer is final.

Cancellation:

- While the child is AwaitingCredential, the transferring holder may cancel alone. Units return to the parent; the parent's status is unchanged.
- While the child is CredentialRequested, only the issuer may cancel, after hearing both sides.
- From Issued onward, no one may cancel.
- No cancellation while the parent is PendingRedemption.

### E. Lock, unlock and rotate (holder and issuer)

1. Lock: holder signs in, selects Lock and gives a reason (pledge, pending sale, suspected compromise, other). The app produces a signed lock notice. On-chain: `lock` with its hash, immediate.
2. Unlock: holder requests in the app (off-chain). If the lock is for a pledge, the issuer needs the pledgee's signed release. Otherwise the issuer verifies identity and writes a memo. On-chain: `unlock` (multisig) with that document's hash.
3. Rotate: holder locks and requests a new passkey in the app (off-chain). Issuer verifies identity and mails a new one. On-chain: `recordRotation`.

### F. Redeem (holder and issuer)

1. Holder signs in with the passkey and step-up code, and selects Request redemption. Allowed only if the record has units and no pending transfers. On-chain: `requestRedemption` with the hash of the signed request. Status PendingRedemption, frozen.
2. Issuer reviews the register, chain record and paperwork; payment is made through the agreed channel.
3. Hash the redemption receipt or release.
4. On-chain: `approveRedemption` (multisig) with that hash. Status Redeemed, permanently. The units move into the bond's `redeemedUnits` and can never be issued again.
5. Register: mark redeemed; holder receives final confirmation.

To redeem part of a holding, the holder first assigns the portion out to themselves (workflow D, with themselves as assignee), then redeems that record.

### G. Replace an assignment (issuer)

Used for a court order, death, bankruptcy, a lost or destroyed instrument, or a holder's legal successor.

1. Issuer receives the supporting document and hashes it.
2. The record must be Accepted or Issued with no pending transfers. A Locked record is unlocked first (with the pledgee's release, if pledged).
3. Issuer prepares a replacement instrument for the rightful holder.
4. On-chain: `replaceAssignment` (multisig). Old record Superseded; new record Issued with the same units and the old record as its parent.
5. New passkey and instrument mailed as in workflow B; the new holder claims as in workflow C.

## Timeouts

- A child left in AwaitingCredential or CredentialRequested for 30 days triggers a follow-up letter to the assignee and the assignor.
- After a further 30 days' notice, the issuer may cancel it. Units return to the parent.
- If the assignor has not filed the child's UCC-3 within 30 days of the credential request, the issuer may file it.

## Public verification

Anyone holding a copy of an assignment can confirm its current status in under a minute, without an account and without seeing personal data.

**Shows:** assignment ID, bond ID, units, status, parent chain back to the issuer, document hash, filing and delivery references (as hashes), last updated time and transaction links to a block explorer.

**Never shows:** holder names or contact, passkeys, mail numbers in plain text, or the instrument PDF.

**Document check:** the visitor drops in their copy of the PDF; the browser hashes it locally (Web Crypto, nothing uploaded) and compares it to docHash. A match proves the copy is the recorded instrument.

**Independence:** the page reads the chain directly through a public RPC endpoint and publishes the contract address so anyone can check it themselves.

**Proof of holding:** a signed-in holder can download a time-stamped certificate signed by the issuer key, valid for a stated period (for example 7 days), for buyers or lenders who want a current confirmation.

## UCC-3 and legal record integration

Each UCC-3 references the on-chain record, and the record stores a reference back to the filing, so the public filing, the register and the chain point to one another.

- **Who files:** the issuer for issuer-originated assignments and replacements; the assignor for children they create. The issuer may file a child's UCC-3 if the assignor has not done so within 30 days of the credential request.
- **Collateral description includes:** the bond identifier, assignment ID, units, contract address, chain ID and document hash of the signed assignment.
- **Never include:** passkeys, the passkey document, or holder contact details beyond what the filing requires.
- **Sequence:** sign the instrument, write the on-chain record, file the UCC-3, then `setFilingRef` with a hash of the filing number and date. For a child, the filing must be recorded before `issueCredential`.

**Evidence export:** for any assignment, the app produces a bundle with the signed instrument, the register history, delivery receipts, the UCC-3 acknowledgment, the on-chain event log with transaction hashes, and a verification report, ready to attach as exhibits.

### Instrument language (for counsel to draft)

Every assignment instrument should state:

1. The interest passes only when the register shows the assignment as Accepted. The register controls; the chain mirrors it.
2. The assignor may cancel an assignment until the assignee requests access. After that, only the issuer may cancel, and from issuance of the assignee's credential the assignment cannot be cancelled.
3. The issuer is not a party to, and is not liable for, any dealing between holders that is not recorded on the register. Anyone acting off-register does so at their own risk.
4. A copy of this instrument is not proof of current holding. Current status is what the public verification page shows.
5. Redeemed interest is extinguished and cannot be reissued.
6. The holder is responsible for keeping the passkey confidential. Sharing it is at the holder's own risk.

## Threat model and security controls

No single failure lets anyone redeem or move an interest without issuer approval.

| Threat | Control |
|---|---|
| Copied or photographed assignment used to take control | QR carries only the ID; passkey mailed separately; claim needs the passkey |
| Intercepted passkey mailing | Separate mailings on different days; step-up code for assign out and redemption; optional device passkey; holder can lock and rotate |
| Transferring holder keeps control of the transferred portion | Child stays locked; issuer issues the child passkey directly to the verified assignee |
| Assignor takes payment, then cancels the transfer | Assignor can cancel alone only before the assignee requests access; after that only the issuer can, after hearing both sides |
| Cancellation used to unlock a locked or frozen record | Cancellation never changes the parent's status and is refused while the parent is PendingRedemption |
| Units returned to a closed record | Parent can't become Superseded with pending children; redemption and replacement require no pending children |
| Same assignment sold or pledged twice | Public verification shows live status; lock for pledges; unlock needs the pledgee's release; terminal statuses can never revive |
| Double redemption | approveRedemption is terminal; contract rejects any action on a Redeemed record |
| Redeemed interest reissued | Redeemed units retired in redeemedUnits, outside the issuable pool |
| Platform writes a change with no paperwork | Every write needs a document hash; daily reconciliation flags any hash with no document in the register |
| Stranger requests a credential for someone else's child | Issuer verification; rejectCredentialRequest returns the child to AwaitingCredential |
| Passkey brute force | ~80 bits of randomness, Argon2id, 5-attempt lockout, rate limits per ID and IP |
| Deliberate lockouts by guessing | Rate limits per IP; issuer clears after identity check; no value moves |
| Relayer key compromise | Relayer limited to holder-initiated transitions; children stay locked; pause by guardian; key in KMS with rotation |
| Issuer key loss or compromise | 2-of-3 multisig with keys on separate hardware wallets; documented successor signers; no single key acts alone |
| Database tampering | Register reconciled against on-chain events daily; any mismatch alerts and freezes affected records |
| Phishing site imitating the app | Published official domain, HSTS preload, contract address on every document, step-up codes bound to the domain |
| Personal data exposure | No personal data on-chain; encryption at rest (AES-256) and in transit (TLS 1.3); least-privilege access; field-level encryption for contact data |
| Web vulnerabilities | Strict CSP, CSRF tokens, input validation, dependency scanning, annual penetration test |

Key custody: issuer multisig signers on hardware wallets stored in separate locations; relayer and pepper keys in a cloud KMS with no export; all signing events logged.

### Risks that remain with the holder

| Risk | Position |
|---|---|
| Holder sells off the books without assigning out on the register | On the holder. The register says who holds the interest, and the instrument says so. |
| Holder shares their passkey | On the holder. They can lock and request a new passkey. |
| Holder ignores the instructions on the instrument | On the holder. The instrument and the verify page state the rules. |

## Audit, reconciliation and operations

A daily job proves the register and the chain agree; any difference stops activity on the affected records until resolved.

- **Reconciliation:** an indexer reads all contract events, rebuilds state and compares units, status and pending-child counts per assignment against the register. It re-checks the units invariant per bond and confirms every on-chain document hash matches a document held in the register.
- **Audit log:** every app action records actor, role, assignment ID, IP, timestamp, request hash and resulting transaction hash (if any), in append-only storage.
- **Approvals queue:** the issuer console lists pending items (credential requests, unlock and rotation requests, redemptions, credential lockouts, unrecorded mailings, children waiting on a UCC-3) with the evidence attached. Multisig signing happens from that queue.
- **Backups:** encrypted daily backups of the register and documents in a second region; quarterly restore test.
- **Monitoring:** alerts on failed-claim spikes, relayer gas balance, reconciliation mismatches and any guardian pause.
- **Change control:** contract and app changes go through review, tests and a rollback plan; contract deployments are signed by the multisig.

## Decided

- Chain: Polygon PoS (chain 137).
- Passkey format: fully random, 16 characters in groups of four.
- Step-up code: required for assign out and redemption. Device passkey optional.
- Multisig: 2 of 3.
- Unclaimed child timeout: 30 days, then 30 days' notice before cancellation.
- UCC-3 for children: filed by the assignor; issuer may file after 30 days.

## Open decisions

- [ ] Named multisig signers and named successor signers
- [ ] Payment channel at redemption (obligor direct, paying agent, or pass-through). The app records only the hash of the receipt, whichever is used.
- [ ] Whether a correction may ever change units (replacement currently keeps units unchanged)
- [ ] Counsel review of interest classification, UCC treatment, filing approach and the instrument language above before the first outside assignment
