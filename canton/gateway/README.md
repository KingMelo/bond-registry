# The node's gateway (Railway)

The Canton node's only public door, in the `canton-node` Railway project next to it. Each app (the
bond registry, Omni-Stance) has its own key; the gateway lets it make only the calls it needs,
each limited to the parties it created itself, and forwards them to the node over the project's
private network. The node's own APIs, the admin API above all, are never public.

What each app can do with its key:
- read the ledger's end and the synchronizer; make parties, which are then its own; set up an
  external party (an assignee's or a partner's own keys);
- submit, read, prepare and execute transactions only as its own parties;
- upload only its own package (by name: `bond-registry`, `omni-receivables`);
- change keys only for its own parties, and add only changes the gateway generated for it.
Everything else on the node returns 404.

Settings: `NODE_JSON_URL`, `NODE_ADMIN` (the node's private addresses), `DATABASE_URL` (which app
owns which party), `KEY_BOND_REGISTRY`, `KEY_OMNI_STANCE`, `PORT`; `BIND` only to listen on IPv4 locally.

Tested locally (Nov 22, 2026): `e2e/canton-e2e.mjs` through the gateway on the bond registry's key
(all 74 checks, including assignees' key setup, a second device and recovery), then
`e2e/canton-gateway-check.mjs` (15 checks): on Omni-Stance's key, nothing of the bond registry's
can be read, acted on, granted, re-keyed or uploaded over, and the other way round.
