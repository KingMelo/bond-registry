// The Canton node's only public door. Each app (the bond registry, Omni-Stance) has its own key;
// the gateway lets it make only the calls it needs, each limited to the parties it created itself,
// and forwards them to the node over the project's private network. The node's own APIs, the admin
// API above all, are never public.
//
//   NODE_JSON_URL      the node's JSON Ledger API (private), e.g. http://canton.railway.internal:7575
//   NODE_ADMIN         its admin API (private gRPC), e.g. canton.railway.internal:6866
//   PROTOS             the admin API's .proto files (baked into the image)
//   DATABASE_URL       Postgres, for which app owns which party
//   KEY_<APP>          each app's key, e.g. KEY_BOND_REGISTRY, KEY_OMNI_STANCE
//   PORT               where to listen
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import AdmZip from "adm-zip";

const NODE = (process.env.NODE_JSON_URL || "http://localhost:7575").replace(/\/+$/, "");
const NODE_USER = "participant_admin";
// Which packages each app may upload, by package name.
const APPS = {
  "bond-registry": { packages: ["bond-registry"] },
  "omni-stance": { packages: ["omni-receivables"] },
};
const keys = Object.keys(APPS).map((app) => ({ app, hash: process.env["KEY_" + app.toUpperCase().replace(/-/g, "_")] }))
  .filter((k) => k.hash).map((k) => ({ app: k.app, hash: crypto.createHash("sha256").update(k.hash).digest() }));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
await pool.query(`create table if not exists gateway_parties (party text primary key, app text not null, created_at timestamptz not null default now())`);

class Refused extends Error { constructor(status, message) { super(message); this.status = status; } }

function appOf(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) throw new Refused(401, "Missing the app's key.");
  const h = crypto.createHash("sha256").update(m[1]).digest();
  const k = keys.find((x) => crypto.timingSafeEqual(x.hash, h));
  if (!k) throw new Refused(401, "Unknown key.");
  return k.app;
}
async function owned(app, parties) {
  const list = [...new Set((parties || []).filter(Boolean))];
  if (!list.length) return;
  const rows = (await pool.query("select party, app from gateway_parties where party = any($1)", [list])).rows;
  const mine = new Set(rows.filter((r) => r.app === app).map((r) => r.party));
  const other = list.filter((p) => !mine.has(p));
  if (other.length) throw new Refused(403, "Not this app's parties: " + other.map((p) => p.split("::")[0]).join(", "));
}
const own = (app, party) => pool.query("insert into gateway_parties (party, app) values ($1, $2) on conflict (party) do nothing", [party, app]);

async function node(method, path, body, raw) {
  const r = await fetch(NODE + path, { method, headers: { "Content-Type": raw ? "application/octet-stream" : "application/json" },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

// ---- the admin API (topology), for assignees' and partners' own keys
let admin = null;
async function adminApi() {
  if (admin) return admin;
  const [{ default: grpc }, { default: loader }] = await Promise.all([import("@grpc/grpc-js"), import("@grpc/proto-loader")]);
  const def = loader.loadSync("com/digitalasset/canton/topology/admin/v30/topology_manager_write_service.proto",
    { includeDirs: [process.env.PROTOS || "/protos"], keepCase: true, longs: String, enums: String, bytes: String, defaults: true, oneofs: true });
  const Svc = grpc.loadPackageDefinition(def).com.digitalasset.canton.topology.admin.v30.TopologyManagerWriteService;
  const client = new Svc(process.env.NODE_ADMIN || "localhost:6866", grpc.credentials.createInsecure());
  admin = (m, req) => new Promise((res, rej) => client[m](req, (e, r) => (e ? rej(new Refused(422, e.details || e.message)) : res(r))));
  return admin;
}
// Changes the gateway generated for an app, by their serialized bytes: the only ones it will add for it.
const generated = new Map();
const remember = (app, tx) => generated.set(app + "|" + tx, Date.now() + 15 * 60_000);
const wasGenerated = (app, tx) => (generated.get(app + "|" + tx) || 0) > Date.now();
setInterval(() => { const now = Date.now(); for (const [k, exp] of generated) if (exp < now) generated.delete(k); }, 60_000).unref();

async function generate(app, body) {
  for (const p of body.proposals || []) {
    const m = p.mapping || {};
    if (m.party_to_key_mapping) await owned(app, [m.party_to_key_mapping.party]);
    else if (m.namespace_delegation) {
      const ns = m.namespace_delegation.namespace;
      const r = (await pool.query("select 1 from gateway_parties where app = $1 and split_part(party, '::', 2) = $2 limit 1", [app, ns])).rowCount;
      if (!r) throw new Refused(403, "That namespace isn't one of this app's parties.");
    } else throw new Refused(403, "Only key changes for this app's own parties.");
  }
  const g = await (await adminApi())("GenerateTransactions", { proposals: body.proposals });
  for (const t of g.generated_transactions) remember(app, t.serialized_transaction);
  return g;
}
async function add(app, body) {
  for (const t of body.transactions || []) if (!wasGenerated(app, t.transaction)) throw new Refused(403, "Only changes this gateway generated for this app can be added.");
  return (await adminApi())("AddTransactions", body);
}

// The package a DAR holds, by name, from its manifest.
function darName(buf) {
  const m = new AdmZip(buf).readAsText("META-INF/MANIFEST.MF");
  const name = /^Name:\s*(.+)$/m.exec(m)?.[1]?.trim() || "";
  return name.replace(/-\d+(\.\d+)*$/, "");
}

const readBody = (req) => new Promise((res, rej) => { const parts = []; let n = 0;
  req.on("data", (d) => { n += d.length; if (n > 20 * 1024 * 1024) { rej(new Refused(413, "Too large.")); req.destroy(); } else parts.push(d); });
  req.on("end", () => res(Buffer.concat(parts))); req.on("error", rej); });

async function handle(req, res) {
  const url = new URL(req.url, "http://x"), path = url.pathname;
  if (req.method === "GET" && path === "/healthz") {
    const v = await node("GET", "/v2/version").catch(() => ({ status: 0 }));
    return send(res, v.status === 200 ? 200 : 503, { ok: v.status === 200 });
  }
  const app = appOf(req);
  const raw = await readBody(req);
  const body = raw.length && path !== "/v2/packages" ? JSON.parse(raw.toString("utf8")) : undefined;
  const pass = async (b = body) => { const r = await node(req.method, path + url.search, b); return r; };
  const route = req.method + " " + path.replace(/^\/v2\/users\/[^/]+\/rights$/, "/v2/users/:user/rights");
  let r;
  switch (route) {
    case "GET /v2/version": case "GET /v2/state/ledger-end": case "GET /v2/state/connected-synchronizers":
    case "POST /v2/parties/external/generate-topology":
      r = await pass(); break;
    case "POST /v2/parties":
      r = await pass();
      if (r.status === 200 && r.json?.partyDetails?.party) await own(app, r.json.partyDetails.party);
      break;
    case "POST /v2/parties/external/allocate":
      r = await pass();
      if (r.status === 200 && r.json?.partyId) await own(app, r.json.partyId);
      break;
    case "POST /v2/users/:user/rights": {
      if (!path.endsWith("/" + NODE_USER + "/rights")) throw new Refused(403, "Only the node's own user.");
      const parties = (body.rights || []).map((x) => x.kind?.CanActAs?.value?.party || x.kind?.CanReadAs?.value?.party || null);
      if (parties.some((p) => !p)) throw new Refused(403, "Only acting or reading as this app's parties.");
      await owned(app, parties); r = await pass(); break;
    }
    case "POST /v2/commands/submit-and-wait-for-transaction": case "POST /v2/commands/submit-and-wait": {
      const c = body.commands || body;
      if ((c.userId || NODE_USER) !== NODE_USER) throw new Refused(403, "Only the node's own user.");
      await owned(app, [...(c.actAs || []), ...(c.readAs || [])]);
      if (!(c.actAs || []).length) throw new Refused(400, "Name who acts.");
      r = await pass(); break;
    }
    case "POST /v2/state/active-contracts": {
      const f = body.eventFormat || body.filter || {};
      if (f.filtersForAnyParty) throw new Refused(403, "Read as this app's own parties only.");
      const parties = Object.keys(f.filtersByParty || {});
      if (!parties.length) throw new Refused(400, "Name whose contracts to read.");
      await owned(app, parties); r = await pass(); break;
    }
    case "POST /v2/interactive-submission/prepare":
      await owned(app, [...(body.actAs || []), ...(body.readAs || [])]);
      if (!(body.actAs || []).length) throw new Refused(400, "Name who acts.");
      r = await pass(); break;
    case "POST /v2/interactive-submission/executeAndWait": case "POST /v2/interactive-submission/execute":
      await owned(app, (body.partySignatures?.signatures || []).map((s) => s.party));
      r = await pass(); break;
    case "POST /v2/packages": {
      const name = darName(raw);
      if (!APPS[app].packages.includes(name)) throw new Refused(403, "This app can't upload " + (name || "that package") + ".");
      r = await node("POST", "/v2/packages", raw, true); break;
    }
    case "POST /admin/topology/generate": return send(res, 200, await generate(app, body));
    case "POST /admin/topology/add": return send(res, 200, await add(app, body));
    default: throw new Refused(404, "Not available through the gateway.");
  }
  res.writeHead(r.status, { "Content-Type": "application/json" });
  res.end(r.text);
}
function send(res, status, j) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); }

http.createServer((req, res) => handle(req, res).catch((e) => {
  if (!(e instanceof Refused)) console.error(e);
  send(res, e instanceof Refused ? e.status : e instanceof SyntaxError ? 400 : 502, { error: e instanceof Refused ? e.message : "Gateway error." });
})).listen(Number(process.env.PORT || 8080), process.env.BIND || "::", () => console.log("Canton gateway listening on " + (process.env.PORT || 8080) + "; apps with keys: " + keys.map((k) => k.app).join(", ")));
