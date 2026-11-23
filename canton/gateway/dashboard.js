// A read-only view of the Canton node for its owner: health, parties by app, live contracts and
// recent activity. Behind its own password (DASHBOARD_PASSWORD; off when unset), separate from the
// apps' keys. It only ever reads from the node.
import crypto from "node:crypto";

const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const SECRET = crypto.createHash("sha256").update("canton-dashboard|" + PASSWORD + "|" + (process.env.KEY_BOND_REGISTRY || "")).digest();
const SESSION_HOURS = 8;
const COOKIE = "node_dash";

// ---- sign-in
const mac = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
const session = (req) => {
  const c = Object.fromEntries((req.headers.cookie || "").split(";").map((x) => x.trim().split("=")).filter((x) => x.length === 2));
  const [exp, sig] = String(c[COOKIE] || "").split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  const want = Buffer.from(mac(exp)), got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
};
const failures = new Map(); // ip → { n, until }
const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

// ---- reading the node
let NODE = "";
async function get(path) { const r = await fetch(NODE + path); return r.json(); }
async function post(path, body) {
  const r = await fetch(NODE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
const ANY = { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] };
async function ledgerEnd() { return (await get("/v2/state/ledger-end")).offset; }
async function activeContracts() {
  const acs = await post("/v2/state/active-contracts", { activeAtOffset: await ledgerEnd(), eventFormat: { verbose: true, filtersForAnyParty: ANY } });
  return (Array.isArray(acs) ? acs : []).map((x) => x.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean);
}
async function recentUpdates(n) {
  const end = await ledgerEnd();
  const u = await post(`/v2/updates?limit=${n * 4}&stream_idle_timeout_ms=1500`,
    { beginExclusive: Math.max(0, end - n * 6), endInclusive: end, verbose: true, filter: { filtersForAnyParty: ANY } });
  return (Array.isArray(u) ? u : []).map((x) => x.update?.Transaction?.value).filter(Boolean).reverse().slice(0, n);
}

// ---- words
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const tplName = (t) => String(t || "").split(":").pop();
const pkgApp = (pkg) => (pkg === "bond-registry" ? "Bond registry" : pkg === "omni-receivables" ? "Omni-Stance" : pkg || "—");
const partyName = (p) => { const n = String(p || "").split("::")[0]; return n.replace(/-[0-9a-f]{8}$/, ""); };
const usd = (cents) => (cents == null || cents === "" ? "" : "$" + (Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const shortId = (s) => (s && s.length > 16 ? s.slice(0, 10) + "…" + s.slice(-4) : s || "");
const when = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");
const recordOf = (a) => a?.receivableId || a?.recordId || a?.bondId || a?.entryId || "";
const amountOf = (t, a) => {
  if (!a) return "";
  if (t === "Receivable") return usd(Number(a.face) - Number(a.paid) - Number(a.writtenOff)) + " owed of " + usd(a.face);
  if (t === "Bond") return usd(a.unassigned) + " unassigned of " + usd(a.total);
  if (a.units != null) return usd(a.units);
  if (a.amount != null) return usd(a.amount);
  if (a.face != null) return usd(a.face);
  return "";
};
const holderOf = (a) => partyName(a?.holder || a?.assignee || a?.seller || a?.issuer || a?.originator || "");
// One line per transaction: what it did, in plain words.
function saying(tx) {
  const ex = tx.events.map((e) => e.ExercisedEvent).filter(Boolean)[0];
  const made = tx.events.map((e) => e.CreatedEvent).filter(Boolean);
  const first = made[0];
  if (!ex) return made.length ? "Created " + made.map((c) => tplName(c.templateId) + " " + recordOf(c.createArgument)).join(", ") : "—";
  const a = ex.choiceArgument || {};
  const target = recordOf(made.find((c) => tplName(c.templateId) === tplName(ex.templateId))?.createArgument) || recordOf(first?.createArgument);
  const words = {
    RecordPayment: `Payment of ${usd(a.amount)} recorded`, WriteOff: `${usd(a.amount)} written off`, Settle: "Settled",
    RecordDispute: "Dispute opened", ResolveDispute: "Dispute resolved", OfferSale: `Offered ${usd(a.amount)} for sale to ${a.buyerName || "a buyer"}`,
    AcceptSale: "Sale accepted", DeclineSale: "Sale declined", Issue: `Issued ${a.recordId || ""} for ${usd(a.units)}`, Accept: "Assignment accepted",
    Reject: "Assignment rejected", AssignOut: `Assigned out ${usd(a.childUnits)} to ${a.childName || ""} as ${a.childId || ""}`,
    Lock: `Locked (${a.kind || ""})`, Unlock: "Unlocked", ReleasePledge: "Pledge released by its lender", BindPledgee: "Lender named on the pledge",
    Bind: "Assignee's party named", RecordMailing: "Certified mailing recorded", RecordReceipt: "Delivery receipt recorded",
    RecordReceiptOnAssignment: "Delivery receipt recorded", RecordUcc3: "UCC-3 recorded", RecordUcc3OnAssignment: "UCC-3 recorded",
    Redeem: "Redeemed", RecordPrior: `Prior instrument ${a.entryId || ""} recorded`, ReversePrior: "Prior instrument reversed",
    Consent: "Replacement agreed by the assignee", Decline: "Replacement declined", SupersedeOffer: "Offer replaced by the issuer",
    CancelAssignOut: "Unclaimed assign-out cancelled", IssuerCancel: "Assign-out cancelled by the issuer", ReclaimToAssignment: "Units taken back",
    ReclaimToBond: "Units back to the bond", RecordNoResponse: "No authenticated response recorded",
  };
  return (words[ex.choice] || ex.choice) + (target ? " · " + target : "");
}

// ---- pages
const CSS = `
:root{--bg:#f7f6f3;--card:#fff;--ink:#1c2230;--soft:#5b6372;--line:#e3e1db;--accent:#28407a;--good:#1f6b45;--chip:#eef0f5}
@media (prefers-color-scheme:dark){:root{--bg:#14171d;--card:#1c2028;--ink:#e8eaee;--soft:#a2a9b6;--line:#2c313c;--accent:#8fa8e8;--good:#6ec497;--chip:#252a35}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;padding:16px;border-bottom:1px solid var(--line);background:var(--card)}
header b{font-size:17px}nav a{color:var(--soft);text-decoration:none;margin-right:14px}nav a.on{color:var(--ink);font-weight:600}
main{max-width:1100px;margin:0 auto;padding:16px}h2{font-size:16px;margin:24px 0 8px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px}.card .n{font-size:22px;font-weight:600}.card .l{color:var(--soft);font-size:13px}
.tbl{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:6px}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}th{color:var(--soft);font-weight:500;font-size:13px}
tr:last-child td{border-bottom:none}td.wrap{white-space:normal;min-width:220px}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.chip{display:inline-block;background:var(--chip);border-radius:10px;padding:1px 8px;font-size:12px}.ok{color:var(--good)}.soft{color:var(--soft)}
a{color:var(--accent)}form.login{max-width:340px;margin:60px auto;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:20px}
input{width:100%;padding:9px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--ink);font:inherit}
button{margin-top:10px;width:100%;padding:9px;border:0;border-radius:4px;background:var(--ink);color:var(--card);font:inherit;cursor:pointer}
pre{white-space:pre-wrap;word-break:break-all;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;font-size:12.5px}
.filters a{margin-right:8px}`;
const page = (title, nav, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Canton node</title><style>${CSS}</style></head><body>
<header><b>Canton node</b><nav>${[["", "Overview"], ["contracts", "Contracts"], ["parties", "Parties"], ["activity", "Activity"]]
    .map(([p, l]) => `<a href="/dashboard${p ? "/" + p : ""}" class="${nav === p ? "on" : ""}">${l}</a>`).join("")}</nav>
<span class="soft" style="margin-left:auto">Read-only · <a href="/dashboard/logout">Sign out</a></span></header><main>${body}</main></body></html>`;
const table = (head, rows) => `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
  rows.length ? rows.join("") : `<tr><td colspan="${head.length}" class="soft">Nothing yet.</td></tr>`}</tbody></table></div>`;
const contractRow = (c) => { const t = tplName(c.templateId), a = c.createArgument;
  return `<tr><td>${esc(t)}</td><td>${esc(recordOf(a))}</td><td>${esc(amountOf(t, a))}</td><td>${esc(holderOf(a))}</td>
  <td><span class="chip">${esc(pkgApp(c.packageName))}</span></td><td class="soft">${esc(when(c.createdAt))}</td>
  <td class="mono"><a href="/dashboard/contract/${encodeURIComponent(c.contractId)}">${esc(shortId(c.contractId))}</a></td></tr>`; };
const activityRow = (tx) => { const ex = tx.events.map((e) => e.ExercisedEvent || e.CreatedEvent).filter(Boolean)[0];
  return `<tr><td class="soft">${esc(when(tx.effectiveAt))}</td><td class="wrap">${esc(saying(tx))}</td>
  <td><span class="chip">${esc(pkgApp(ex?.packageName))}</span></td><td>${esc((ex?.actingParties || ex?.signatories || []).map(partyName).join(", "))}</td>
  <td class="soft">${esc(tx.offset ?? "")}</td></tr>`; };

async function overview(db) {
  const [version, syncs, end, contracts, updates, owners] = await Promise.all([get("/v2/version"), get("/v2/state/connected-synchronizers"),
    ledgerEnd(), activeContracts(), recentUpdates(15), db.query("select app, count(*)::int as n from gateway_parties group by app")]);
  const s = syncs.connectedSynchronizers?.[0];
  const byApp = (pkg) => contracts.filter((c) => c.packageName === pkg).length;
  const count = (t) => contracts.filter((c) => tplName(c.templateId) === t).length;
  const parties = Object.fromEntries(owners.rows.map((r) => [r.app, r.n]));
  return page("Overview", "", `
  <div class="cards">
    <div class="card"><div class="n ok">${s ? "Connected" : "Not connected"}</div><div class="l">${esc(s?.synchronizerAlias || "")} · Canton ${esc(version.version)}</div></div>
    <div class="card"><div class="n">${esc(end)}</div><div class="l">Ledger position (offset)</div></div>
    <div class="card"><div class="n">${byApp("bond-registry")}</div><div class="l">Live bond registry contracts · ${parties["bond-registry"] || 0} parties</div></div>
    <div class="card"><div class="n">${byApp("omni-receivables")}</div><div class="l">Live Omni-Stance contracts · ${parties["omni-stance"] || 0} parties</div></div>
  </div>
  <h2>Live contracts by kind</h2>
  <div class="cards">${["Bond", "AssignmentOffer", "Assignment", "Receivable", "SaleOffer", "LedgerEntry", "Settled", "PriorInstrument"]
    .filter((t) => count(t)).map((t) => `<div class="card"><div class="n">${count(t)}</div><div class="l"><a href="/dashboard/contracts?template=${t}">${t}</a></div></div>`).join("") || '<div class="soft">None yet.</div>'}</div>
  <h2>Recent activity</h2>${table(["When", "What happened", "App", "By", "Offset"], updates.map(activityRow))}
  <p class="soft"><a href="/dashboard/activity">All recent activity</a></p>`);
}
async function contractsPage(url) {
  const t = url.searchParams.get("template"), app = url.searchParams.get("app");
  let list = await activeContracts();
  if (t) list = list.filter((c) => tplName(c.templateId) === t);
  if (app) list = list.filter((c) => c.packageName === app);
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return page("Contracts", "contracts", `<h2>Live contracts${t ? " · " + esc(t) : ""}${app ? " · " + esc(pkgApp(app)) : ""}</h2>
  <p class="filters"><a href="/dashboard/contracts">All</a><a href="/dashboard/contracts?app=bond-registry">Bond registry</a><a href="/dashboard/contracts?app=omni-receivables">Omni-Stance</a></p>
  ${table(["Kind", "Record", "Amount", "Held by", "App", "Since", "Contract"], list.slice(0, 500).map(contractRow))}`);
}
async function partiesPage(db) {
  const [rows, contracts] = await Promise.all([db.query("select party, app, created_at from gateway_parties order by created_at desc"), activeContracts()]);
  const live = (p) => contracts.filter((c) => (c.signatories || []).includes(p) || (c.observers || []).includes(p)).length;
  return page("Parties", "parties", `<h2>Parties, by the app that made them</h2>
  ${table(["Party", "App", "Kind", "Contracts it's on", "Since", "ID"], rows.rows.map((r) => `<tr><td>${esc(partyName(r.party))}</td>
  <td><span class="chip">${esc(r.app === "omni-stance" ? "Omni-Stance" : "Bond registry")}</span></td>
  <td class="soft">${/^(issuer|platform|filer)-/.test(r.party) ? "The app's own" : "Holds its own keys"}</td><td>${live(r.party)}</td>
  <td class="soft">${esc(when(r.created_at))}</td><td class="mono">${esc(shortId(r.party.split("::")[1] || ""))}</td></tr>`))}`);
}
async function activityPage() {
  return page("Activity", "activity", `<h2>Recent activity</h2>${table(["When", "What happened", "App", "By", "Offset"], (await recentUpdates(100)).map(activityRow))}`);
}
async function contractPage(cid) {
  const ev = await post("/v2/events/events-by-contract-id", { contractId: cid, eventFormat: { verbose: true, filtersForAnyParty: ANY } });
  const c = ev.created?.createdEvent;
  if (!c) return page("Contract", "contracts", `<p>No such contract on this node.</p>`);
  const t = tplName(c.templateId);
  return page(t, "contracts", `<h2>${esc(t)} · ${esc(recordOf(c.createArgument))}</h2>
  <div class="cards"><div class="card"><div class="n">${esc(amountOf(t, c.createArgument) || "—")}</div><div class="l">Amount</div></div>
  <div class="card"><div class="n">${ev.archived ? "Archived" : "Live"}</div><div class="l">Since ${esc(when(c.createdAt))}</div></div>
  <div class="card"><div class="n">${esc(pkgApp(c.packageName))}</div><div class="l">App</div></div></div>
  <h2>Signed by</h2><p>${esc((c.signatories || []).map(partyName).join(", "))}${(c.observers || []).length ? ` <span class="soft">· seen by ${esc(c.observers.map(partyName).join(", "))}</span>` : ""}</p>
  <h2>Everything it holds</h2><pre>${esc(JSON.stringify(c.createArgument, null, 2))}</pre>
  <p class="soft mono">${esc(cid)}</p>`);
}
const loginPage = (msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Sign in · Canton node</title><style>${CSS}</style></head><body><form class="login" method="post" action="/dashboard/login">
<b>Canton node</b><p class="soft">Read-only view. Sign in with the dashboard password.</p>
${msg ? `<p style="color:#b3261e">${esc(msg)}</p>` : ""}<input type="password" name="password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button></form></body></html>`;

/** Handles /dashboard requests; returns false for anything else. */
export async function dashboard(req, res, { db, nodeUrl, readBody }) {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/dashboard")) return false;
  NODE = nodeUrl;
  const html = (status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", ...headers }); res.end(body); };
  if (!PASSWORD) { html(404, "Not available."); return true; }
  const secure = (req.headers["x-forwarded-proto"] || "") === "https" ? "; Secure" : "";
  if (url.pathname === "/dashboard/login" && req.method === "POST") {
    const ip = ipOf(req), f = failures.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) { html(429, loginPage("Too many attempts. Wait a few minutes.")); return true; }
    const given = new URLSearchParams((await readBody(req)).toString("utf8")).get("password") || "";
    const ok = given.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(PASSWORD));
    if (!ok) { f.n++; if (f.n >= 5) { f.until = Date.now() + 10 * 60_000; f.n = 0; } failures.set(ip, f); html(401, loginPage("That password isn't right.")); return true; }
    failures.delete(ip);
    const exp = String(Date.now() + SESSION_HOURS * 3600_000);
    html(303, "", { Location: "/dashboard", "Set-Cookie": `${COOKIE}=${exp}.${mac(exp)}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=${SESSION_HOURS * 3600}${secure}` });
    return true;
  }
  if (url.pathname === "/dashboard/logout") { html(303, "", { Location: "/dashboard", "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=0${secure}` }); return true; }
  if (!session(req)) { html(200, loginPage()); return true; }
  if (req.method !== "GET") { html(405, "Read-only."); return true; }
  const p = url.pathname.replace(/\/+$/, "");
  if (p === "/dashboard") html(200, await overview(db));
  else if (p === "/dashboard/contracts") html(200, await contractsPage(url));
  else if (p === "/dashboard/parties") html(200, await partiesPage(db));
  else if (p === "/dashboard/activity") html(200, await activityPage());
  else if (p.startsWith("/dashboard/contract/")) html(200, await contractPage(decodeURIComponent(p.slice("/dashboard/contract/".length))));
  else html(404, page("Not found", "", "<p>Not found.</p>"));
  return true;
}
