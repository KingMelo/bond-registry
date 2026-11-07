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
  setPasskey: (issuer, id, passkey) => call("POST", "/api/issuer/passkey", { issuer, id, passkey }),
  clearLockout: (issuer, id) => call("POST", "/api/issuer/clear-lockout", { issuer, id }),
  me: () => call("GET", "/api/auth/me"),
  setup: (body) => call("POST", "/api/auth/setup", body),
  signup: (body) => call("POST", "/api/auth/signup", body),
  login: (email, password) => call("POST", "/api/auth/login", { email, password }),
  logout: () => call("POST", "/api/auth/logout"),
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
};

const byId = (list, key = "id") => new Map(list.map((x) => [x[key], x]));

// `issuer` scopes the issuer console to one issuer; the holder portal leaves it out.
export function useRegistry({ onNotice, issuer } = {}) {
  const [reg, setReg] = useState([]);
  const [bonds, setBonds] = useState([]);
  const [events, setEvents] = useState([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState({ issuer: null, issuers: [] });
  const scope = issuer ? "issuer=" + encodeURIComponent(issuer) : "";
  const stateUrl = (since) => "/api/state?" + [scope, since != null ? "since=" + since : ""].filter(Boolean).join("&");

  const synced = useRef({ version: 0, reg: new Map(), bonds: new Map(), events: new Set() });
  const latest = useRef({ reg, bonds, events });
  latest.current = { reg, bonds, events };
  const busy = useRef(false);
  const notice = useRef(onNotice);
  notice.current = onNotice;

  const adopt = useCallback((s) => {
    synced.current = {
      version: s.version,
      reg: byId(s.reg),
      bonds: byId(s.bonds),
      events: new Set(s.events.map((e) => e.eid)),
    };
    latest.current = { reg: s.reg, bonds: s.bonds, events: s.events };
    setReg(s.reg); setBonds(s.bonds); setEvents(s.events);
    setInfo({ issuer: s.issuer || null, issuers: s.issuers || [] });
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
      const { version, revs } = await call("POST", "/api/commit",
        { issuer, base: s.version, reg: changedReg, bonds: changedBonds, events: newEvents });
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
    issuerInfo: info.issuer, issuers: info.issuers };
}

// Reads a dollar amount typed into a units box. One unit is $1, so "$250,000" and
// "250,000.00" are 250000 units; an amount with cents is refused rather than misread.
export function parseUnits(text) {
  const t = String(text || "").replace(/[$,\s]/g, "");
  if (!t) return { units: 0, error: "Enter a whole number of units." };
  const m = t.match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return { units: 0, error: "Enter an amount in whole dollars, like 250,000." };
  const whole = parseInt(m[1], 10);
  if (m[2] && /[1-9]/.test(m[2]))
    return { units: 0, error: "One unit is $1, so cents can't be recorded. Enter " + whole.toLocaleString("en-US") +
      " or " + (whole + 1).toLocaleString("en-US") + "." };
  if (whole <= 0) return { units: 0, error: "Enter a whole number of units." };
  return { units: whole };
}

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
