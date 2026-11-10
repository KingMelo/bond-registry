// Shared register, kept in Postgres behind the API.
// Each app keeps working with plain React state (reg, bonds, events). Every
// change is diffed against what the server last confirmed and saved as one
// commit; changes from the other app arrive by polling.

import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 4000;

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
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
  holderMine: (token) => call("POST", "/api/holder/mine", { token }),
  holderKeyPrepare: (body) => call("POST", "/api/holder/key/prepare", body),
  holderKey: (body) => call("POST", "/api/holder/key", body),
  clearDeviceKey: (issuer, id, reason) => call("POST", "/api/issuer/holder-key/clear", { issuer, id, reason }),
  setPasskey: (issuer, id, passkey) => call("POST", "/api/issuer/passkey", { issuer, id, passkey }),
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
  const stateUrl = (since) => "/api/state?" + [scope, since != null ? "since=" + since : ""].filter(Boolean).join("&");

  const synced = useRef({ version: 0, reg: new Map(), bonds: new Map(), events: new Set() });
  const latest = useRef({ reg, bonds, events });
  latest.current = { reg, bonds, events };
  const busy = useRef(false);
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const before = useRef(beforeCommit);
  before.current = beforeCommit;

  const adopt = useCallback((s) => {
    synced.current = {
      version: s.version,
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
        const s = await call("GET", stateUrl(synced.current.version));
        if (s.unchanged || busy.current) return;
        const { reg: r, bonds: b, events: ev } = latest.current;
        const pending = r.some((a) => synced.current.reg.get(a.id) !== a) ||
          b.some((x) => synced.current.bonds.get(x.id) !== x) ||
          ev.some((e) => !synced.current.events.has(e.eid));
        if (!pending) adopt(s);
      } catch { /* try again next tick */ }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [reload, adopt, scope]);

  return { reg, setReg, bonds, setBonds, events, setEvents, ready, error, reload,
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
  if (c.state === "signing") return { label: "Waiting for your signature", href: null, tone: "soft" };
  if (c.state === "pending") return { label: "Writing to the chain…", href: contract, tone: "soft" };
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
