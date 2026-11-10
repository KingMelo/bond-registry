// Removes every assignment on one bond from the register: the records, their access codes and
// queued chain writes. Their amounts go back to the bond's unassigned balance. Prior instruments
// stay. The event log is append-only, so the records' past events stay as history and an
// "AssignmentRemoved" event is added for each. Used for a clean start before a fresh contract; the chain's history on
// earlier contracts can't be (and isn't) touched.
//
//   DATABASE_URL   the register
//   BOND_CODE      e.g. KJPII-0001-BD, or ALL for every bond
//   DRY_RUN=1      show what would go, change nothing
//   CHAIN_CONTRACT the current contract: removals of records it holds are logged on it (logChange)
const { Client } = require("pg");
const { ethers } = require("ethers");
// Same hashing as server/chain.js: the removal is logged on-chain (logChange) for records the
// current contract already holds, so the chain shows they left the register.
const id32 = (s) => ethers.keccak256(ethers.toUtf8Bytes(String(s)));
const tagged = (kind, values) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ["string", ...values.map(() => "string")], ["BondInterestRegistry/" + kind + "/v1", ...values.map((v) => String(v ?? ""))]));
const TERMINAL = ["Redeemed", "Superseded", "Cancelled", "Rejected"];

async function main() {
  const code = String(process.env.BOND_CODE || "").trim();
  if (!code) throw new Error("Set BOND_CODE (or ALL).");
  const dry = !!process.env.DRY_RUN;
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    const bonds = code === "ALL" ? (await db.query("select id from bonds order by id")).rows.map((r) => r.id) : [code];
    for (const bond of bonds) { console.log("BOND " + bond); await removeFrom(db, bond, dry); }
    console.log(dry ? "REMOVE-DRY-RUN" : "REMOVED-ALL");
  } finally { await db.end(); }
}

async function removeFrom(db, bond, dry) {
  try {
    await db.query("begin");
    const b = (await db.query("select data from bonds where id = $1 for update", [bond])).rows[0];
    if (!b) throw new Error("No bond " + bond + ".");
    const recs = (await db.query("select id, data from assignments where bond = $1 order by id", [bond])).rows;
    const back = recs.filter((r) => !TERMINAL.includes(r.data.status)).reduce((t, r) => t + Number(r.data.units), 0);
    for (const r of recs) console.log(`  ${dry ? "would remove" : "removing"} ${r.id} · ${r.data.status} · ${(Number(r.data.units) / 100).toFixed(2)} · ${r.data.party || ""}`);
    const ids = recs.map((r) => r.id);
    const counts = {
      events: (await db.query("select count(*)::int c from events where assignment = any($1)", [ids])).rows[0].c,
      credentials: (await db.query("select count(*)::int c from credentials where id = any($1)", [ids])).rows[0].c,
      chainOps: (await db.query("select count(*)::int c from chain_ops where ref = any($1)", [ids])).rows[0].c,
      sealed: (await db.query("select count(*)::int c from sealed_codes where id = any($1)", [ids])).rows[0].c,
    };
    const ops = (await db.query("select seq, fn, ref, status from chain_ops where ref = any($1) and status <> 'confirmed' order by seq", [ids])).rows;
    for (const o of ops) console.log(`  ${dry ? "would withdraw" : "withdrawing"} chain write ${o.seq} ${o.fn} ${o.ref} (${o.status})`);
    const unassigned = Number(b.data.unassigned) + back;
    const prior = (b.data.prior || []).filter((p) => !p.reversed).reduce((t, p) => t + Number(p.units), 0);
    if (prior + unassigned + Number(b.data.redeemed || 0) !== Number(b.data.total))
      throw new Error(`After removal the bond wouldn't add up: prior ${prior} + unassigned ${unassigned} + redeemed ${b.data.redeemed} ≠ total ${b.data.total}.`);
    console.log(`  ${ids.length} record(s), ${counts.events} past event(s) kept, ${counts.credentials + counts.sealed} transfer code(s), ${counts.chainOps} queued chain write(s)`);
    console.log(`  unassigned ${(Number(b.data.unassigned) / 100).toFixed(2)} → ${(unassigned / 100).toFixed(2)} · prior ${(prior / 100).toFixed(2)} kept`);
    if (dry) { await db.query("rollback"); return; }
    const when = new Date().toISOString();
    for (const r of recs)
      await db.query("insert into events (eid, bond, assignment, data) values (gen_random_uuid()::text, $1, $2, $3)",
        [bond, r.id, { bond, id: r.id, t: when.slice(0, 16).replace("T", " "), ev: "AssignmentRemoved", actor: "OWNER",
          ref: (process.env.REASON || "Removed at the owner's request") + "; " + (Number(r.data.units) / 100).toFixed(2) + " returned to unassigned" }]);
    await db.query("delete from credentials where id = any($1)", [ids]);
    await db.query("delete from sealed_codes where id = any($1)", [ids]);
    // Which records the current contract holds (a confirmed write on it), before their writes go.
    const onChain = (await db.query(`select distinct ref, contract from chain_ops where ref = any($1) and status = 'confirmed' and contract = $2`,
      [ids, process.env.CHAIN_CONTRACT || ""])).rows;
    await db.query("delete from chain_ops where ref = any($1)", [ids]);
    for (const o of onChain) {
      const why = (process.env.REASON || "Removed at the owner's request") + " " + when;
      await db.query("insert into chain_ops (bond, ref, fn, args, role, status, contract) values ($1, $2, 'logChange', $3, 'relayer', 'queued', $4)",
        [bond, o.ref, JSON.stringify([id32(bond), id32(o.ref), ethers.id("removed"), tagged("change", [o.ref, "removed", why])]), o.contract]);
      console.log("  logging the removal of " + o.ref + " on " + o.contract);
    }
    await db.query("delete from assignments where id = any($1)", [ids]);
    await db.query("update bonds set data = jsonb_set(data, '{unassigned}', to_jsonb($2::bigint)), rev = rev + 1 where id = $1", [bond, unassigned]);
    await db.query("update meta set version = version + 1 where k = 'v'");
    await db.query("commit");
    console.log("REMOVED " + ids.length);
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; }
}
main().catch((e) => { console.error("REMOVE-ERROR", e.message); process.exit(1); });
