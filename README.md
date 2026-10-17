# Bond Interest Registry

A register of assigned interests in a private bond, mirrored to a public blockchain as a tamper-evident record. No holder wallets and no tokens: each assignment is a line on the bond's record, updated as the signed paperwork happens.

- [`docs/workflow-spec.md`](docs/workflow-spec.md) — the workflow spec: data model, contract state machine, workflows, security and open decisions.
- [`prototypes/issuer-console.jsx`](prototypes/issuer-console.jsx) — issuer console demo (approvals queue, bonds, records, event log).
- [`prototypes/holder-portal.jsx`](prototypes/holder-portal.jsx) — holder portal demo (claim, assign out, lock, redeem, request access, public verification).

The prototypes are single-file React components styled with Tailwind utility classes. They hold all state in memory; nothing is written to a chain.
