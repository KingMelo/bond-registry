// The gateway keeps the two apps apart on the shared node. Run after e2e/canton-e2e.mjs has gone
// through it (so the bond registry owns parties there):
//   GATEWAY_URL=http://localhost:7676 BOND_KEY=… OMNI_KEY=… GATEWAY_DB=postgres://… RECEIVABLES_DAR=… node e2e/canton-gateway-check.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pg = require("pg");
const G = process.env.GATEWAY_URL, BOND = process.env.BOND_KEY, OMNI = process.env.OMNI_KEY;
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const call = async (key, method, p, body, raw) => {
  const r = await fetch(G + p, { method, headers: { ...(key ? { Authorization: "Bearer " + key } : {}), "Content-Type": raw ? "application/octet-stream" : "application/json" },
    body: raw ? body : body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const db = new pg.Client({ connectionString: process.env.GATEWAY_DB }); await db.connect();
const bondParty = (await db.query("select party from gateway_parties where app = 'bond-registry' and party like 'issuer-%' limit 1")).rows[0]?.party;
const bondExternal = (await db.query("select party from gateway_parties where app = 'bond-registry' and party like 'PENS-%' limit 1")).rows[0]?.party;
await db.end();
ok(!!bondParty && !!bondExternal, "the bond registry's parties, local and external, are recorded as its own");
const sync = (await call(OMNI, "GET", "/v2/state/connected-synchronizers")).body.connectedSynchronizers?.[0]?.synchronizerId;
const end = (await call(OMNI, "GET", "/v2/state/ledger-end")).body.offset;
ok((await call(null, "GET", "/v2/version")).status === 401 && (await call("wrong-key", "GET", "/v2/version")).status === 401, "no key, or a wrong one, gets nothing");
const acs = (key, party) => call(key, "POST", "/v2/state/active-contracts", { activeAtOffset: end, eventFormat: { verbose: false,
  filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } } });
ok((await acs(OMNI, bondParty)).status === 403, "Omni-Stance can't read the bond registry's contracts");
ok((await call(OMNI, "POST", "/v2/state/active-contracts", { activeAtOffset: end, eventFormat: { verbose: false, filtersForAnyParty: { cumulative: [] } } })).status === 403,
  "nor read as every party at once");
ok((await acs(BOND, bondParty)).status === 200, "the bond registry still reads its own");
ok((await call(OMNI, "POST", "/v2/commands/submit-and-wait-for-transaction", { commands: { commands: [], commandId: "x", userId: "participant_admin", actAs: [bondParty], synchronizerId: sync } })).status === 403,
  "Omni-Stance can't act as the bond registry's party");
ok((await call(OMNI, "POST", "/v2/interactive-submission/prepare", { userId: "participant_admin", commandId: "x", actAs: [bondExternal], readAs: [], synchronizerId: sync, commands: [] })).status === 403,
  "nor prepare a transaction for an assignee's party");
ok((await call(OMNI, "POST", "/v2/users/participant_admin/rights", { userId: "participant_admin", identityProviderId: "", rights: [{ kind: { CanActAs: { value: { party: bondParty } } } }] })).status === 403,
  "nor grant itself rights to them");
ok((await call(OMNI, "POST", "/admin/topology/generate", { proposals: [{ operation: "TOPOLOGY_CHANGE_OP_ADD_REPLACE", serial: 0,
  mapping: { party_to_key_mapping: { party: bondExternal, threshold: 1, signing_keys: [] } }, store: { synchronizer: { id: sync } } }] })).status === 403,
  "nor change an assignee's keys");
ok((await call(OMNI, "POST", "/admin/topology/add", { store: { synchronizer: { id: sync } }, force_changes: [], transactions: [{ transaction: "AAAA", proposal: false, signatures: [] }] })).status === 403,
  "nor add any change the gateway didn't generate for it");
ok((await call(OMNI, "GET", "/v2/users")).status === 404 && (await call(BOND, "GET", "/v2/parties")).status === 404, "and anything else on the node isn't reachable at all");
const bondDar = fs.readFileSync(new URL("../canton/.daml/dist/bond-registry-0.7.0.dar", import.meta.url));
ok((await call(OMNI, "POST", "/v2/packages", bondDar, true)).status === 403, "Omni-Stance can't upload the bond registry's package");
if (process.env.RECEIVABLES_DAR) {
  const rDar = fs.readFileSync(process.env.RECEIVABLES_DAR);
  ok((await call(BOND, "POST", "/v2/packages", rDar, true)).status === 403, "nor the bond registry Omni-Stance's");
  ok((await call(OMNI, "POST", "/v2/packages", rDar, true)).status === 200, "each uploads its own");
}
const mine = await call(OMNI, "POST", "/v2/parties", { partyIdHint: "omni-check-" + Date.now(), identityProviderId: "" });
const omniParty = mine.body.partyDetails?.party;
ok(mine.status === 200 && (await acs(OMNI, omniParty)).status === 200 && (await acs(BOND, omniParty)).status === 403,
  "a party Omni-Stance makes is its own: it reads as it, the bond registry can't");
console.log(fails ? fails + " FAILED" : "ALL PASSED");
process.exit(fails ? 1 : 0);
