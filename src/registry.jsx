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
  setPasskey: (id, passkey) => call("POST", "/api/issuer/passkey", { id, passkey }),
  clearLockout: (id) => call("POST", "/api/issuer/clear-lockout", { id }),
  reset: () => call("POST", "/api/issuer/reset"),
};

const byId = (list, key = "id") => new Map(list.map((x) => [x[key], x]));

export function useRegistry({ onNotice } = {}) {
  const [reg, setReg] = useState([]);
  const [bonds, setBonds] = useState([]);
  const [events, setEvents] = useState([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

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
  }, []);

  const reload = useCallback(async () => {
    const s = await call("GET", "/api/state");
    adopt(s);
    setReady(true);
    setError("");
    return s;
  }, [adopt]);

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
      const { version } = await call("POST", "/api/commit",
        { base: s.version, reg: changedReg, bonds: changedBonds, events: newEvents });
      changedReg.forEach((a) => s.reg.set(a.id, a));
      changedBonds.forEach((x) => s.bonds.set(x.id, x));
      newEvents.forEach((e) => s.events.add(e.eid));
      s.version = version;
    } catch (e) {
      await reload().catch(() => {});
      notice.current?.(e.status === 409
        ? "The register changed in the other app before this was saved. It has been reloaded — please redo your last step."
        : e.message + " The register has been reloaded.");
    } finally {
      busy.current = false;
    }
    // Pick up anything changed while the commit was in flight.
    flush();
  }, [reload]);

  useEffect(() => { if (ready) flush(); }, [reg, bonds, events, ready, flush]);

  useEffect(() => {
    reload().catch((e) => setError(e.message));
    const t = setInterval(async () => {
      if (busy.current) return;
      try {
        const s = await call("GET", "/api/state?since=" + synced.current.version);
        if (s.unchanged || busy.current) return;
        const { reg: r, bonds: b, events: ev } = latest.current;
        const pending = r.some((a) => synced.current.reg.get(a.id) !== a) ||
          b.some((x) => synced.current.bonds.get(x.id) !== x) ||
          ev.some((e) => !synced.current.events.has(e.eid));
        if (!pending) adopt(s);
      } catch { /* try again next tick */ }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [reload, adopt]);

  return { reg, setReg, bonds, setBonds, events, setEvents, ready, error, reload };
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
