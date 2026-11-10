// Removes every assignment on one bond from the register: the records, their access codes and
// queued chain writes. Their amounts go back to the bond's unassigned balance. Prior instruments
// stay. The event log is append-only, so the records' past events stay as history and an
// "AssignmentRemoved" event is added for each. Used for a clean start before a fresh contract; the chain's history on
// earlier contracts can't be (and isn't) touched.
//
//   DATABASE_URL   the register
//   BOND_CODE      e.g. KJPII-0001-BD
//   DRY_RUN=1      show what would go, change nothing
const { Client } = require("pg");
const TERMINAL = ["Redeemed", "Superseded", "Cancelled", "Rejected"];

async function main() {
  const bond = String(process.env.BOND_CODE || "").trim();
  if (!bond) throw new Error("Set BOND_CODE.");
  const dry = !!process.env.DRY_RUN;
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
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
    };
    const unassigned = Number(b.data.unassigned) + back;
    const prior = (b.data.prior || []).filter((p) => !p.reversed).reduce((t, p) => t + Number(p.units), 0);
    if (prior + unassigned + Number(b.data.redeemed || 0) !== Number(b.data.total))
      throw new Error(`After removal the bond wouldn't add up: prior ${prior} + unassigned ${unassigned} + redeemed ${b.data.redeemed} ≠ total ${b.data.total}.`);
    console.log(`  ${ids.length} record(s), ${counts.events} past event(s) kept, ${counts.credentials} access code(s), ${counts.chainOps} queued chain write(s)`);
    console.log(`  unassigned ${(Number(b.data.unassigned) / 100).toFixed(2)} → ${(unassigned / 100).toFixed(2)} · prior ${(prior / 100).toFixed(2)} kept`);
    if (dry) { await db.query("rollback"); console.log("REMOVE-DRY-RUN"); return; }
    const when = new Date().toISOString();
    for (const r of recs)
      await db.query("insert into events (eid, bond, assignment, data) values (gen_random_uuid()::text, $1, $2, $3)",
        [bond, r.id, { bond, id: r.id, t: when.slice(0, 16).replace("T", " "), ev: "AssignmentRemoved", actor: "OWNER",
          ref: (process.env.REASON || "Removed at the owner's request") + "; " + (Number(r.data.units) / 100).toFixed(2) + " returned to unassigned" }]);
    await db.query("delete from credentials where id = any($1)", [ids]);
    await db.query("delete from chain_ops where ref = any($1)", [ids]);
    await db.query("delete from assignments where id = any($1)", [ids]);
    await db.query("update bonds set data = jsonb_set(data, '{unassigned}', to_jsonb($2::bigint)), rev = rev + 1 where id = $1", [bond, unassigned]);
    await db.query("update meta set version = version + 1 where k = 'v'");
    await db.query("commit");
    console.log("REMOVED " + ids.length);
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { await db.end(); }
}
main().catch((e) => { console.error("REMOVE-ERROR", e.message); process.exit(1); });
