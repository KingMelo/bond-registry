// Shared register, kept in Postgres behind the API.
// Each app keeps working with plain React state (reg, bonds, events). Every
// change is diffed against what the server last confirmed and saved as one
// commit; changes from the other app arrive by polling.

import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 4000;

// The build this page was loaded from; when the server answers from a newer one, the page offers a reload.
let pageBuild = null;
const staleListeners = new Set();
export const onNewVersion = (fn) => { staleListeners.add(fn); return () => staleListeners.delete(fn); };

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const build = res.headers.get("x-registry-build");
  if (build) { if (!pageBuild) pageBuild = build; else if (build !== pageBuild) staleListeners.forEach((fn) => fn()); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Request failed (" + res.status + ").");
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  signIn: (id, passkey) => call("POST", "/api/holder/signin", { id, passkey }),
  holderPrepare: (body) => call("POST", "/api/holder/prepare", body),
  holderStart: (id) => call("POST", "/api/holder/start", { id }),
  signInPasskey: (body) => call("POST", "/api/holder/signin-passkey", body),
  holderMine: (token) => call("POST", "/api/holder/mine", { token }),
  assigneeCode: (token, id) => call("POST", "/api/holder/assignee-code", { token, id }),
  holderKeyPrepare: (body) => call("POST", "/api/holder/key/prepare", body),
  holderKey: (body) => call("POST", "/api/holder/key", body),
  clearDeviceKey: (issuer, id, reason) => call("POST", "/api/issuer/holder-key/clear", { issuer, id, reason }),
  setPasskey: (issuer, id, passkey) => call("POST", "/api/issuer/passkey", { issuer, id, passkey }),
  revealAccessCode: (issuer, id) => call("POST", "/api/issuer/access-code/reveal", { issuer, id }),
  clearLockout: (issuer, id) => call("POST", "/api/issuer/clear-lockout", { issuer, id }),
  me: () => call("GET", "/api/auth/me"),
  setup: (body) => call("POST", "/api/auth/setup", body),
  signup: (body) => call("POST", "/api/auth/signup", body),
  login: (email, password) => call("POST", "/api/auth/login", { email, password }),
  logout: () => call("POST", "/api/auth/logout"),
  forgot: (email) => call("POST", "/api/auth/forgot", { email }),
  resetPassword: (token, password) => call("POST", "/api/auth/reset", { token, password }),
  createIssuer: (legalName, issuerCode) => call("POST", "/api/issuers", { legalName, issuerCode }),
  team: (issuer) => call("GET", "/api/team?issuer=" + encodeURIComponent(issuer)),
  invite: (issuer) => call("POST", "/api/team/invite", { issuer }),
  // platform console
  summary: () => call("GET", "/api/platform/summary"),
  platformIssuers: () => call("GET", "/api/platform/issuers"),
  setIssuerStatus: (id, status) => call("POST", "/api/platform/issuers/" + encodeURIComponent(id) + "/status", { status }),
  platformBonds: () => call("GET", "/api/platform/bonds"),
  reviewBond: (id, decision, note) => call("POST", "/api/platform/bonds/" + encodeURIComponent(id) + "/review", { decision, note }),
  staff: () => call("GET", "/api/platform/staff"),
  staffInvite: () => call("POST", "/api/platform/invite"),
  chainSummary: () => call("GET", "/api/platform/chain"),
  signing: (issuer) => call("GET", "/api/issuer/signing?issuer=" + encodeURIComponent(issuer)),
  sign: (issuer, seq, signature) => call("POST", "/api/issuer/sign", { issuer, seq, signature }),
  platformSigning: () => call("GET", "/api/platform/signing"),
  platformSign: (seq, signature) => call("POST", "/api/platform/sign", { seq, signature }),
  chainRetry: (seq) => call("POST", "/api/platform/chain/retry", { seq }),
  chainFreeze: () => call("POST", "/api/platform/chain/freeze", {}),
};

const byId = (list, key = "id") => new Map(list.map((x) => [x[key], x]));

// `issuer` scopes the issuer console to one issuer; the holder portal leaves it out.
// `beforeCommit`, when given, adds to each save: the holder portal uses it to get the holder's
// device signatures for what the save will do on-chain.
export function useRegistry({ onNotice, issuer, beforeCommit } = {}) {
  const [reg, setReg] = useState([]);
  const [bonds, setBonds] = useState([]);
  const [events, setEvents] = useState([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState({ issuer: null, issuers: [], chain: null, responseDays: 30 });
  const scope = issuer ? "issuer=" + encodeURIComponent(issuer) : "";
  const stateUrl = (since) => "/api/state?" + [scope, since != null ? "since=" + since + "&chain=" + (synced.current.chainStamp || 0) : ""].filter(Boolean).join("&");

  const synced = useRef({ version: 0, reg: new Map(), bonds: new Map(), events: new Set() });
  const latest = useRef({ reg, bonds, events });
  // After a save, the server's copy carries what only it works out (on-chain references, matches):
  // the next poll takes the whole state, once nothing local is waiting to be saved.
  const refetch = useRef(false);
  latest.current = { reg, bonds, events };
  const busy = useRef(false);
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const before = useRef(beforeCommit);
  before.current = beforeCommit;

  const adopt = useCallback((s) => {
    synced.current = {
      version: s.version, chainStamp: s.chainStamp || 0,
      reg: byId(s.reg),
      bonds: byId(s.bonds),
      events: new Set(s.events.map((e) => e.eid)),
    };
    latest.current = { reg: s.reg, bonds: s.bonds, events: s.events };
    setReg(s.reg); setBonds(s.bonds); setEvents(s.events);
    setInfo({ issuer: s.issuer || null, issuers: s.issuers || [], chain: s.chain || null, responseDays: s.responseDays || 30 });
  }, []);

  const reload = useCallback(async () => {
    const s = await call("GET", stateUrl());
    adopt(s);
    setReady(true);
    setError("");
    return s;
  }, [adopt, scope]);

  // Anything whose object identity changed since the last confirmed state is
  // sent; the apps always replace a record rather than mutating it.
  const flush = useCallback(async () => {
    if (busy.current) return;
    const { reg: r, bonds: b, events: ev } = latest.current;
    const s = synced.current;
    const changedReg = r.filter((a) => s.reg.get(a.id) !== a);
    const changedBonds = b.filter((x) => s.bonds.get(x.id) !== x);
    const newEvents = ev.filter((e) => !s.events.has(e.eid));
    if (!changedReg.length && !changedBonds.length && !newEvents.length) return;

    busy.current = true;
    try {
      const body = { issuer, base: s.version, reg: changedReg, bonds: changedBonds, events: newEvents };
      const extra = before.current ? await before.current(body) : null;
      const { version, revs } = await call("POST", "/api/commit", { ...body, ...(extra || {}) });
      // Carry the server's new revisions forward. A record that was edited again while
      // this save was in flight keeps the newer edit, which then saves with the new revision.
      const settle = (sent, rev, map, current) => {
        const saved = { ...sent, rev };
        map.set(sent.id, saved);
        return current === sent ? saved : { ...current, rev };
      };
      const sentReg = new Map(changedReg.map((a) => [a.id, a]));
      const sentBonds = new Map(changedBonds.map((x) => [x.id, x]));
      const settleAll = (list, sent, got, map) =>
        list.map((x) => sent.has(x.id) ? settle(sent.get(x.id), got[x.id], map, x) : x);
      latest.current = { ...latest.current,
        reg: settleAll(latest.current.reg, sentReg, revs.reg, s.reg),
        bonds: settleAll(latest.current.bonds, sentBonds, revs.bonds, s.bonds) };
      setReg((cur) => settleAll(cur, sentReg, revs.reg, s.reg));
      setBonds((cur) => settleAll(cur, sentBonds, revs.bonds, s.bonds));
      newEvents.forEach((e) => s.events.add(e.eid));
      s.version = version;
      refetch.current = true;
    } catch (e) {
      await reload().catch(() => {});
      notice.current?.(e.status === 409
        ? "Someone else changed this record before your change was saved. The latest version has been loaded — please redo your last step."
        : e.message + " The register has been reloaded.");
    } finally {
      busy.current = false;
    }
    // Pick up anything changed while the commit was in flight.
    flush();
  }, [reload, issuer]);

  useEffect(() => { if (ready) flush(); }, [reg, bonds, events, ready, flush]);

  useEffect(() => {
    reload().catch((e) => setError(e.message));
    const t = setInterval(async () => {
      if (busy.current) return;
      try {
        const full = refetch.current;
        const s = await call("GET", stateUrl(full ? null : synced.current.version));
        if (s.unchanged || busy.current) return;
        const { reg: r, bonds: b, events: ev } = latest.current;
        const pending = r.some((a) => synced.current.reg.get(a.id) !== a) ||
          b.some((x) => synced.current.bonds.get(x.id) !== x) ||
          ev.some((e) => !synced.current.events.has(e.eid));
        if (!pending) { adopt(s); if (full) refetch.current = false; }
      } catch { /* try again next tick */ }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [reload, adopt, scope]);

  const [stale, setStale] = useState(false);
  useEffect(() => onNewVersion(() => setStale(true)), []);

  return { reg, setReg, bonds, setBonds, events, setEvents, ready, error, reload, stale,
    issuerInfo: info.issuer, issuers: info.issuers, chainInfo: info.chain, responseDays: info.responseDays };
}

// The date an issued assignment takes effect if the holder doesn't reject it, or null before mailing.
export function effectiveDate(rec, days) {
  if (!rec?.deliveredAt) return null;
  const d = new Date(new Date(rec.deliveredAt).getTime() + days * 86400000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// How a bond or record stands on-chain, in words, with an explorer link when there is one.
//   rec.chain: { state: confirmed | pending | failed, tx, error } from the server, or null
//   chainInfo: { contract, explorer } when the mirror is on, else null
export function chainStatus(rec, chainInfo) {
  if (!chainInfo) return null;
  const c = rec?.chain;
  const contract = chainInfo.explorer + "/address/" + chainInfo.contract;
  if (!c) return { label: "Not on-chain yet", href: null, tone: "soft" };
  if (c.state === "failed") return { label: "Not written: " + (c.error || "the contract refused it"), href: contract, tone: "bad" };
  if (c.state === "signing") return { label: "Waiting for your signature", href: null, tone: "soft", busy: true };
  if (c.state === "pending") return { label: "Writing to the chain…", href: contract, tone: "soft", busy: true };
  return { label: "Recorded on-chain", href: c.tx ? chainInfo.explorer + "/tx/" + c.tx : contract, tone: "good" };
}

// Bytes32 hashes are long; show the ends.
export const shortHash = (h) => (typeof h === "string" && h.length > 20 ? h.slice(0, 10) + "…" + h.slice(-6) : h || "—");

// Reads a dollar amount typed into an amount box and returns it in cents, the unit every
// amount is stored in. "$9,428.87" is 942887; three or more decimal places are refused.
// String arithmetic, so nothing is rounded by floating point.
export function parseUnits(text) {
  const t = String(text || "").replace(/[$,\s]/g, "");
  if (!t) return { units: 0, error: "Enter an amount." };
  const m = t.match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2])) return { units: 0, error: "Enter an amount in dollars and cents, like 9,428.87." };
  if ((m[2] || "").length > 2) return { units: 0, error: "Use at most two decimal places, for cents." };
  const units = parseInt(m[1] || "0", 10) * 100 + parseInt(((m[2] || "") + "00").slice(0, 2), 10);
  if (units <= 0) return { units: 0, error: "Enter an amount above zero." };
  return { units };
}

// Cents as dollars, always with both decimal places.
export const dollars = (cents) =>
  "$" + (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const today = () =>
  new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export const stamp = () => {
  const d = new Date();
  return today() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};

export const newEid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// 16 characters from a set without look-alikes (no 0/O, 1/I/L), in groups of four.
export function generatePasskey() {
  const set = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let chars = "";
  while (chars.length < 16) {
    // Rejection sampling keeps every character equally likely.
    for (const b of crypto.getRandomValues(new Uint8Array(32)))
      if (b < 248 && chars.length < 16) chars += set[b % set.length];
  }
  return chars.match(/.{4}/g).join("-");
}

export function Loading({ error }) {
  return (
    <div style={{ padding: "48px 18px", textAlign: "center", fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      color: error ? "#A32F2B" : "#5C6472", fontSize: 14 }}>
      {error ? "Couldn't load the register: " + error : "Loading the register…"}
    </div>
  );
}

// ------------------------------------------------------------------ writing on-chain

const SPIN_CSS = `
@keyframes br-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
@keyframes br-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .br-slide, .br-spin { animation-duration: 3s !important; } }`;
function SpinStyle() { return <style>{SPIN_CSS}</style>; }

/** A small spinner, for a status that's still on its way to the chain. */
export function Spinner({ color = "#5C6472", size = 12 }) {
  return (
    <>
      <SpinStyle />
      <span className="br-spin" aria-hidden="true" style={{ display: "inline-block", width: size, height: size, verticalAlign: "-1px", marginRight: 6,
        border: "2px solid " + color, borderRightColor: "transparent", borderRadius: "50%", animation: "br-spin 0.8s linear infinite" }} />
    </>
  );
}

/**
 * The preloader for writes on their way to the chain: an animated bar while any of `items` (records
 * or bonds with a `chain` status) is being written or waits for a signature, then "Recorded
 * on-chain" for a few seconds once they've all landed.
 */
export function ChainWriting({ items, chainInfo, ink = "#1D2433", soft = "#5C6472", wash = "#EEF0F2", signHint }) {
  const pending = (items || []).filter((x) => x?.chain?.state === "pending").length;
  const signing = (items || []).filter((x) => x?.chain?.state === "signing").length;
  const busy = pending + signing;
  const [done, setDone] = useState(false);
  const was = useRef(0);
  useEffect(() => {
    if (was.current > 0 && busy === 0) { setDone(true); const t = setTimeout(() => setDone(false), 5000); was.current = busy; return () => clearTimeout(t); }
    if (busy > 0) setDone(false);
    was.current = busy;
  }, [busy]);
  if (!chainInfo || (!busy && !done)) return null;
  const text = busy
    ? (pending ? "Writing " + pending + (pending === 1 ? " change" : " changes") + " to the blockchain…" : "")
      + (pending && signing ? " " : "")
      + (signing ? signing + (signing === 1 ? " change waits" : " changes wait") + " for your signature" + (signHint ? " (" + signHint + ")" : "") + "." : "")
    : "Recorded on-chain ✓";
  return (
    <div role="status" aria-live="polite" style={{ position: "sticky", top: 0, zIndex: 20, margin: "0 0 14px", background: wash, borderRadius: 2,
      overflow: "hidden", fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      <SpinStyle />
      <div style={{ padding: "9px 12px", fontSize: 13, color: busy ? soft : ink, display: "flex", alignItems: "center" }}>
        {busy ? <Spinner color={soft} /> : null}<span>{text}</span>
        {busy && pending ? <span style={{ marginLeft: "auto", fontSize: 12, color: soft, whiteSpace: "nowrap", paddingLeft: 10 }}>usually a few seconds</span> : null}
      </div>
      <div style={{ height: 3, background: busy ? "rgba(0,0,0,0.06)" : ink, position: "relative" }}>
        {busy ? <div className="br-slide" style={{ position: "absolute", top: 0, bottom: 0, width: "40%", background: ink, animation: "br-slide 1.2s ease-in-out infinite" }} /> : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ assignment IDs
//
// An assignment the issuer makes is <bond>-A00001, -A00002, …: each is tied to its original assignor
// and secured party. Every assign-out under it, however far down the chain, is A00001-1, A00001-2, …:
// one dash, one count of how many times that assignment has been assigned out. Which record each
// came from is its parent, kept on the record.

/** The issuer-made assignment an ID belongs to: <bond>-A00001 for A00001 and A00001-7 alike. */
export const rootId = (id) => String(id).replace(/(-A\d+)-\d+$/, "$1");

/** The next issuer-made ID on a bond: one past the highest A-number in use (assign-outs don't count). */
export function nextIssuedId(reg, bondId) {
  const n = reg.filter((a) => a.bond === bondId).map((a) => /-A(\d+)$/.exec(a.id)?.[1]).filter(Boolean)
    .reduce((m, x) => Math.max(m, Number(x)), 0);
  return bondId + "-A" + String(n + 1).padStart(5, "0");
}

/** The next assign-out ID under the same issuer-made assignment: <root>-<n>, one past the highest in use. */
export function nextChildId(reg, parentId) {
  const root = rootId(parentId);
  const re = new RegExp("^" + root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)$");
  const n = reg.map((a) => re.exec(a.id)?.[1]).filter(Boolean).reduce((m, x) => Math.max(m, Number(x)), 0);
  return root + "-" + (n + 1);
}
