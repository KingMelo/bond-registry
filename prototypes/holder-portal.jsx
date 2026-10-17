import React, { useState } from "react";
import { useRegistry, api, today, stamp, newEid, Loading } from "../src/registry.jsx";

/* ================================================================
   Bond Interest Registry — holder portal
   Statuses and transitions follow the workflow spec state machine.
   Holder-initiated transitions are relayer-signed; anything that
   activates a holder, unlocks, or ends an interest needs the issuer.
   ================================================================ */

const T = {
  paper: "#FBFAF7",
  band: "#E6EDE4",
  ink: "#1A2233",
  inkSoft: "#5C6472",
  rule: "#C9CDD4",
  red: "#A32F2B",
  amber: "#8A6A1F",
  wash: "#F1F3F0",
  white: "#FFFFFF",
};

const serif = "'Spectral', Georgia, serif";
const sans = "'IBM Plex Sans', system-ui, sans-serif";

const num = (u) => u.toLocaleString("en-US");
const usd = (u) => "$" + u.toLocaleString("en-US");

const CONTRACT = "0x7A3f9C21D4e8B07a55F3cb1290Ae44D6b8E1B214";
const CHAIN = "Polygon PoS · chain 137";
const MAX_ATTEMPTS = 5;
const STEP_UP_DEMO = "482913";

// Children created by assignOut that are neither Accepted nor Cancelled.
const PENDING = ["AwaitingCredential", "CredentialRequested", "Issued"];
const TERMINAL = ["Redeemed", "Superseded", "Cancelled"];

const LOCK_KINDS = [
  ["pledge", "Pledged to a lender"],
  ["sale", "Pending sale"],
  ["compromise", "Passkey may be compromised"],
  ["other", "Other"],
];

// No paper, no record: every on-chain write carries the hash of the signed
// document behind it. The demo stands in a random hash for that document.
const fakeHash = () =>
  "0x" + Math.random().toString(16).slice(2, 8) + "…" + Math.random().toString(16).slice(2, 6);

const pendingOf = (reg, id) =>
  reg.filter((c) => c.parent === id && c.origin === "AssignOut" && PENDING.includes(c.status));

// A parent closes as Superseded only once it has no units and no pending children.
const settleParent = (reg, parentId) => {
  const p = reg.find((a) => a.id === parentId);
  if (!p || p.units > 0 || pendingOf(reg, p.id).length > 0) return reg;
  if (!["Accepted", "Locked"].includes(p.status)) return reg;
  return reg.map((a) => (a.id === p.id ? { ...a, status: "Superseded" } : a));
};

const LABEL = {
  AwaitingCredential: "Awaiting credential",
  CredentialRequested: "Credential requested",
  Issued: "Issued",
  Accepted: "Accepted",
  Locked: "Locked",
  PendingRedemption: "Pending redemption",
  Redeemed: "Redeemed",
  Superseded: "Superseded",
  Cancelled: "Cancelled",
};

const tone = (s) => {
  if (s === "Accepted" || s === "Redeemed") return [T.ink, "#E4E7EB"];
  if (s === "Issued" || s === "AwaitingCredential" || s === "CredentialRequested")
    return [T.amber, "#F2EAD3"];
  if (s === "Locked" || s === "PendingRedemption") return [T.red, "#F0E0DF"];
  return [T.inkSoft, T.wash];
};

/* ---------------- pieces ---------------- */

function Label({ children }) {
  return <div className="mb-1" style={{ fontSize: 12, color: T.inkSoft, fontFamily: sans }}>{children}</div>;
}

function Chip({ s }) {
  const [fg, bg] = tone(s);
  return (
    <span className="inline-block px-2 py-0.5"
      style={{ fontSize: 12, color: fg, background: bg, fontFamily: sans, borderRadius: 2, whiteSpace: "nowrap" }}>
      {LABEL[s] || s}
    </span>
  );
}

function Button({ children, onClick, variant = "solid", disabled, danger }) {
  const skin = variant === "solid"
    ? { background: danger ? T.red : T.ink, color: T.paper, border: "1px solid " + (danger ? T.red : T.ink) }
    : { background: "transparent", color: danger ? T.red : T.ink, border: "1px solid " + (danger ? T.red : T.rule) };
  return (
    <button onClick={disabled ? undefined : onClick}
      style={{ fontFamily: sans, fontWeight: 500, fontSize: 15, borderRadius: 2, padding: "11px 18px",
        width: "100%", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, ...skin }}>
      {children}
    </button>
  );
}

function Field({ label, value, onChange, placeholder, mono, hint, type }) {
  return (
    <div className="mb-4">
      <Label>{label}</Label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type={type || "text"}
        style={{ width: "100%", fontFamily: sans, fontSize: 16,
          fontVariantNumeric: mono ? "tabular-nums" : "normal", letterSpacing: mono ? "0.04em" : "normal",
          color: T.ink, background: T.white, border: "1px solid " + T.rule, borderRadius: 2,
          padding: "10px 12px", outline: "none" }} />
      {hint && <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 4, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

function Area({ label, value, onChange, placeholder, rows = 4 }) {
  return (
    <div className="mb-4">
      <Label>{label}</Label>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows}
        style={{ width: "100%", fontFamily: sans, fontSize: 16, color: T.ink, background: T.white,
          border: "1px solid " + T.rule, borderRadius: 2, padding: "10px 12px", outline: "none",
          resize: "vertical", lineHeight: 1.5 }} />
    </div>
  );
}

function Rows({ data }) {
  return (
    <div style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
      {data.filter(Boolean).map(([k, v], i) => (
        <div key={k} className="flex justify-between gap-4 px-3 py-2"
          style={{ background: i % 2 ? T.band : T.white, fontSize: 14, fontFamily: sans }}>
          <span style={{ color: T.inkSoft, flexShrink: 0 }}>{k}</span>
          <span style={{ color: T.ink, textAlign: "right", fontVariantNumeric: "tabular-nums", wordBreak: "break-word" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function Note({ children, kind = "quiet" }) {
  const skin = kind === "warn"
    ? { background: "#F7E9E8", borderLeft: "3px solid " + T.red }
    : kind === "caution"
    ? { background: "#F2EAD3", borderLeft: "3px solid " + T.amber }
    : { background: T.wash };
  return (
    <div className="px-3 py-3" style={{ ...skin, borderRadius: 2, fontSize: 13, color: T.ink, lineHeight: 1.6 }}>
      {children}
    </div>
  );
}

/* ---------------- app ---------------- */

export default function HolderPortal() {
  const { reg, setReg, bonds, events, setEvents, ready, error, reload } =
    useRegistry({ onNotice: (m) => flash(m) });
  const pct = (u, bondId) => {
    const b = bonds.find((x) => x.id === bondId);
    return b ? ((u / b.total) * 100).toFixed(6) + "%" : "—";
  };
  const [tab, setTab] = useState("access");
  const [view, setView] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [toast, setToast] = useState("");

  // sign-in
  const [qId, setQId] = useState("");
  const [qKey, setQKey] = useState("");
  const [qErr, setQErr] = useState("");
  const [stepUp, setStepUp] = useState("");
  const [stepUpNeeded, setStepUpNeeded] = useState(false);

  // lock / redeem
  const [lockKind, setLockKind] = useState("pledge");
  const [lockRotate, setLockRotate] = useState(false);
  const [rdErr, setRdErr] = useState("");

  // assign out
  const [aUnits, setAUnits] = useState("");
  const [aParty, setAParty] = useState("");
  const [aContact, setAContact] = useState("");
  const [aPosition, setAPosition] = useState("");
  const [aAddress, setAAddress] = useState("");
  const [aErr, setAErr] = useState("");
  const [childIssued, setChildIssued] = useState(null);

  // request access
  const [rId, setRId] = useState("");
  const [rParty, setRParty] = useState("");
  const [rContact, setRContact] = useState("");
  const [rPhone, setRPhone] = useState("");
  const [rErr, setRErr] = useState("");
  const [rDone, setRDone] = useState(null);

  // verify
  const [vId, setVId] = useState("");
  const [vRec, setVRec] = useState(null);
  const [vErr, setVErr] = useState("");
  const [vHash, setVHash] = useState(null);

  const open = reg.find((a) => a.id === openId);
  const children = open ? reg.filter((a) => a.parent === open.id) : [];
  const liveChildren = children.filter((c) => !["Cancelled"].includes(c.status));
  const pendingChildren = open ? pendingOf(reg, open.id) : [];

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2800); };
  const emit = (bond, id, ev, actor, ref) =>
    setEvents((e) => [{ eid: newEid(), bond, id, t: stamp(), ev, actor, ref: ref || "—" }, ...e]);

  const chainOf = (a) => {
    const line = []; let cur = a;
    while (cur) { line.unshift(cur); cur = reg.find((x) => x.id === cur.parent); }
    return line;
  };

  /* --- sign in --- */
  async function signIn() {
    const id = qId.trim().toUpperCase();
    const rec = reg.find((a) => a.id.toUpperCase() === id);
    if (!rec) { setQErr("No assignment with that ID is on the register."); return; }
    let res;
    try { res = await api.signIn(rec.id, qKey); } catch (e) { setQErr(e.message); return; }
    if (!res.ok) {
      if (res.code === "locked") {
        await reload().catch(() => {});
        setQErr("This credential is locked after " + MAX_ATTEMPTS + " failed attempts. The issuer must verify your identity before it can be unlocked.");
      } else if (res.code === "nokey") {
        setQErr("No passkey has been issued for this assignment yet. If you are the named assignee, use Request access.");
      } else if (res.code === "mismatch") {
        setQErr("That passkey doesn't match. " + res.left + (res.left === 1 ? " attempt" : " attempts") + " remaining before the credential locks.");
      } else {
        setQErr(res.error || "Sign-in failed.");
      }
      return;
    }
    const fresh = (await reload().catch(() => null))?.reg.find((a) => a.id === rec.id) || rec;
    if (["Redeemed", "Superseded", "Cancelled"].includes(fresh.status)) {
      setQErr("This record is " + LABEL[fresh.status].toLowerCase() + " and can no longer be acted on.");
      return;
    }
    setQErr(""); setQKey("");
    setOpenId(fresh.id);
    setView(fresh.status === "Issued" ? "claim" : "position");
  }

  function accept() {
    // A child's acceptance may close its parent: zero units and nothing pending.
    setReg((r) => settleParent(
      r.map((a) => (a.id === open.id ? { ...a, status: "Accepted", accepted: today() } : a)),
      open.origin === "AssignOut" ? open.parent : null
    ));
    emit(open.bond, open.id, "Accepted", "RELAYER");
    setView("position");
    flash("Accepted. The relayer has written the transition on-chain.");
  }

  function requestStepUp(next) {
    setStepUpNeeded(true);
    setStepUp("");
    setView(next);
  }

  function assignOut() {
    if (open.status !== "Accepted") return setAErr("Only an accepted, unlocked record can assign out.");
    const u = parseInt(aUnits.replace(/[^0-9]/g, ""), 10);
    if (!u || u <= 0) return setAErr("Enter a whole number of units.");
    if (u > open.units) return setAErr("You hold " + num(open.units) + " units.");
    if (!aParty.trim()) return setAErr("Enter the assignee's legal name.");
    if (!aContact.trim()) return setAErr("Name the person the assignment is addressed to.");
    if (!aAddress.trim()) return setAErr("Add a mailing address.");
    if (stepUp.trim() !== STEP_UP_DEMO) return setAErr("Enter the 6-digit code sent to your verified contact. Demo code: " + STEP_UP_DEMO);
    setAErr("");

    const seq = String(reg.filter((a) => a.bond === open.bond).length + 1).padStart(5, "0");
    const child = {
      id: open.bond + "-A" + seq,
      bond: open.bond,
      parent: open.id,
      origin: "AssignOut",
      assignor: open.party,
      party: aParty.trim(),
      contact: aContact.trim(),
      position: aPosition.trim(),
      address: aAddress.trim(),
      units: u,
      issuedUnits: u,
      status: "AwaitingCredential",
      created: today(),
      accepted: null,
      docHash: fakeHash(), // hash of the signed child instrument
      filingRef: null,
      deliveryRef: null,
      tx: fakeHash(),
      lockReason: null,
      lockedOn: null,
      unlockRequested: false,
      rotationRequested: false,
    };
    // The parent keeps its status, even at zero units, until every child settles.
    setReg((r) => [
      ...r.map((a) => (a.id === open.id ? { ...a, units: a.units - u } : a)),
      child,
    ]);
    emit(child.bond, child.id, "AssignedOut", "RELAYER", child.docHash);
    setChildIssued(child);
    setAUnits(""); setAParty(""); setAContact(""); setAPosition(""); setAAddress("");
    setStepUp(""); setStepUpNeeded(false);
    setView("childIssued");
  }

  function cancelAssignOut(child) {
    // Once the assignee has requested access, only the issuer can cancel.
    if (child.status !== "AwaitingCredential") return;
    if (open.status === "PendingRedemption") return;
    // Units go back; the parent's status is never touched, so a lock stays a lock.
    setReg((r) => r.map((a) => {
      if (a.id === child.id) return { ...a, status: "Cancelled" };
      if (a.id === open.id) return { ...a, units: a.units + child.units };
      return a;
    }));
    emit(child.bond, child.id, "AssignOutCancelled", "RELAYER", fakeHash());
    flash("Cancelled. " + usd(child.units) + " returned to your record.");
  }

  function lock() {
    const label = LOCK_KINDS.find(([k]) => k === lockKind)[1];
    setReg((r) => r.map((a) => (a.id === open.id
      ? { ...a, status: "Locked", lockKind, lockReason: label, lockedOn: today(),
          rotationRequested: lockRotate, unlockRequested: false }
      : a)));
    emit(open.bond, open.id, "Locked", "RELAYER", fakeHash());
    setLockKind("pledge"); setLockRotate(false);
    setView("position");
    flash(lockRotate
      ? "Locked, and a new passkey requested. Only the issuer can unlock it."
      : "Locked. Only the issuer can unlock it.");
  }

  // Holder requests are register entries for the issuer queue, not chain writes.
  function requestUnlock() {
    setReg((r) => r.map((a) => (a.id === open.id ? { ...a, unlockRequested: true } : a)));
    flash(open.lockKind === "pledge"
      ? "Unlock requested. The issuer will need your lender's signed release."
      : "Unlock requested. The issuer will verify your identity first.");
  }

  function requestRotation() {
    setReg((r) => r.map((a) => (a.id === open.id ? { ...a, rotationRequested: true } : a)));
    flash("New passkey requested. The issuer will verify your identity and mail it.");
  }

  function requestRedemption() {
    if (open.status !== "Accepted" || open.units <= 0) return setRdErr("Only an accepted record with units can be redeemed.");
    if (pendingChildren.length > 0) return setRdErr("Settle your pending transfers first. Each must be accepted or cancelled.");
    if (stepUp.trim() !== STEP_UP_DEMO) return setRdErr("Enter the 6-digit code sent to your verified contact. Demo code: " + STEP_UP_DEMO);
    setRdErr("");
    setReg((r) => r.map((a) => (a.id === open.id ? { ...a, status: "PendingRedemption" } : a)));
    emit(open.bond, open.id, "RedemptionRequested", "RELAYER", fakeHash());
    setStepUp(""); setStepUpNeeded(false);
    setView("position");
    flash("Redemption requested. The record is frozen pending issuer review.");
  }

  function requestAccess() {
    const id = rId.trim().toUpperCase();
    const rec = reg.find((a) => a.id.toUpperCase() === id);
    if (!rec) return setRErr("No assignment with that ID is on the register.");
    if (rec.status === "CredentialRequested")
      return setRErr("A credential request is already open on this assignment. The issuer is verifying it.");
    if (rec.status !== "AwaitingCredential")
      return setRErr("This assignment is " + LABEL[rec.status].toLowerCase() + ". A credential can only be requested while it awaits one.");
    if (!rParty.trim() || !rContact.trim() || !rPhone.trim())
      return setRErr("Enter the assignee's legal name, your own name and position, and a contact for verification.");
    setRErr("");
    // The details stay in the register; only a hash of the request goes on-chain.
    const requestHash = fakeHash();
    setReg((r) => r.map((a) => (a.id === rec.id
      ? { ...a, status: "CredentialRequested", requestedParty: rParty.trim(), requestedBy: rContact.trim(),
          requestedContact: rPhone.trim(), requestedOn: today(), requestHash }
      : a)));
    emit(rec.bond, rec.id, "CredentialRequested", "RELAYER", requestHash);
    setRDone(rec);
    setRParty(""); setRContact(""); setRPhone(""); setRId("");
  }

  function verify() {
    const id = vId.trim().toUpperCase();
    const rec = reg.find((a) => a.id.toUpperCase() === id);
    setVHash(null);
    if (!rec) { setVErr("No assignment with that ID is on the register."); setVRec(null); return; }
    setVErr(""); setVRec(rec);
  }

  async function hashFile(file, rec) {
    try {
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
      setVHash({ computed: "0x" + hex.slice(0, 6) + "…" + hex.slice(-4), full: hex, match: false, name: file.name });
    } catch (e) {
      setVHash({ error: "This browser blocked local hashing. Nothing was uploaded." });
    }
  }

  const tabs = [["access", "Holder access"], ["request", "Request access"], ["verify", "Verify"]];
  const inHolder = view && tab === "access";

  if (!ready) return <Loading error={error} />;

  return (
    <div style={{ background: T.paper, minHeight: "100%", fontFamily: sans }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Spectral:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid ${T.ink}; outline-offset: 1px; }
        input:focus, textarea:focus { border-color: ${T.ink} !important; }`}</style>

      <div className="mx-auto" style={{ maxWidth: 560, padding: "20px 18px 56px" }}>
        <div className="flex items-baseline justify-between">
          <div style={{ fontFamily: serif, fontSize: 21, color: T.ink, fontWeight: 500 }}>Interest Registry</div>
        </div>

        <div className="flex gap-4 mt-4 mb-5" style={{ borderBottom: "1px solid " + T.rule }}>
          {tabs.map(([k, l]) => (
            <button key={k} onClick={() => { setTab(k); setView(null); setOpenId(null); }}
              style={{ fontFamily: sans, fontSize: 14, color: tab === k ? T.ink : T.inkSoft,
                padding: "0 0 8px", borderBottom: "2px solid " + (tab === k ? T.ink : "transparent"),
                background: "none", cursor: "pointer" }}>
              {l}
            </button>
          ))}
        </div>

        {/* ============ holder access ============ */}
        {tab === "access" && !view && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Open your assignment</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 22px", maxWidth: "62ch" }}>
              Enter the assignment ID from your instrument and the passkey from the separate
              certified mailing.
            </p>

            <Field label="Assignment ID" value={qId} onChange={setQId} placeholder="KPII-0001-BD-A00001" mono />
            <Field label="Passkey" value={qKey} onChange={setQKey} placeholder="XXXX-XXXX-XXXX-XXXX" mono />

            {qErr && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, marginBottom: 16 }}>{qErr}</p>}

            <Button onClick={signIn}>Continue</Button>

            <div className="mt-6">
              <Note>
                The passkey arrives in its own certified mailing, on a different day from the
                instrument. Nothing from the registry will ever email you one or ask for it.
                <div style={{ marginTop: 8, color: T.ink, fontVariantNumeric: "tabular-nums" }}>
                  Demo · accepted: …A00001 / 7KQM-R4XW-9TPH-C2NV
                  <br />Demo · awaiting claim: …A00004 / N4VP-K9TC-X3HW-R7MJ
                </div>
              </Note>
            </div>
          </div>
        )}

        {/* ============ claim ============ */}
        {inHolder && view === "claim" && open && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Accept this assignment</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 20px", maxWidth: "62ch" }}>
              The passkey checked out. Accepting moves the record from Issued to Accepted and
              is written on-chain by the relayer.
            </p>

            <div className="mb-5 px-3 py-4" style={{ border: "2px solid " + T.ink, borderRadius: 2, background: T.white }}>
              <Label>What the register records for this assignment</Label>
              <div style={{ fontFamily: serif, fontSize: 34, color: T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>
                {usd(open.units)}
              </div>
              <div style={{ fontSize: 14, color: T.inkSoft, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                {num(open.units)} units · {pct(open.units, open.bond)} of {open.bond}
              </div>
              <div className="mt-4 pt-3" style={{ borderTop: "1px solid " + T.rule, fontSize: 14, color: T.ink, lineHeight: 1.6 }}>
                Check this against the instrument in front of you before accepting.
              </div>
            </div>

            <Rows data={[
              ["Assignment", open.id],
              ["Assignor", open.assignor],
              ["Assignee", open.party],
              ["Attention of", open.contact],
              ["Position", open.position || "—"],
              ["Parent", open.parent || "Issuer-originated"],
              ["Dated", open.created],
              ["Document hash", open.docHash],
              open.filingRef && ["UCC-3 filing ref", open.filingRef],
              open.deliveryRef && ["Delivery ref", open.deliveryRef],
            ]} />

            <div className="mt-5 space-y-3">
              <Button onClick={accept}>Accept — the figures match</Button>
              <Button variant="quiet" danger onClick={() => setView("mismatch")}>
                My instrument says something different
              </Button>
              <Button variant="quiet" onClick={() => { setView(null); setOpenId(null); }}>Back</Button>
            </div>
          </div>
        )}

        {/* ============ mismatch ============ */}
        {inHolder && view === "mismatch" && open && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Don't accept yet</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 20px", maxWidth: "62ch" }}>
              Nothing has been recorded. The record stays Issued and the interest stays where it is.
            </p>
            <Rows data={[
              ["Assignment", open.id],
              ["Registered units", num(open.units)],
              ["Registered value", usd(open.units)],
              ["Assignor", open.assignor],
              ["Document hash", open.docHash],
            ]} />
            <div className="mt-5">
              <Note kind="warn">
                Take it up with {open.assignor}. They created this assignment. You can also
                check your copy of the instrument against the recorded hash on the Verify tab —
                the file is hashed in your browser and never uploaded.
              </Note>
            </div>
            <div className="mt-4">
              <Button variant="quiet" onClick={() => setView("claim")}>Back to the assignment</Button>
            </div>
          </div>
        )}

        {/* ============ position ============ */}
        {inHolder && view === "position" && open && (
          <div>
            <Label>{open.id}</Label>
            <div className="flex items-baseline gap-3">
              <div style={{ fontFamily: serif, fontSize: 34, color: T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>
                {usd(open.units)}
              </div>
              <Chip s={open.status} />
            </div>
            <div style={{ fontSize: 14, color: T.inkSoft, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
              {num(open.units)} units · {pct(open.units, open.bond)} of {open.bond}
              {open.issuedUnits !== open.units ? " · issued at " + usd(open.issuedUnits) : ""}
            </div>

            {open.status === "Locked" && (
              <div className="mt-4">
                <Note kind="warn">
                  This record is locked{open.lockReason ? " (" + open.lockReason.toLowerCase() + ")" : ""}.
                  Assigning out and redemption are blocked until the issuer unlocks it.
                  {open.lockKind === "pledge" && " The issuer will need your lender's signed release to unlock it."}
                </Note>
                <div className="mt-3 space-y-3">
                  <Button variant="quiet" disabled={open.unlockRequested} onClick={requestUnlock}>
                    {open.unlockRequested ? "Unlock requested — with the issuer" : "Request unlock"}
                  </Button>
                  <Button variant="quiet" disabled={open.rotationRequested} onClick={requestRotation}>
                    {open.rotationRequested ? "New passkey requested — with the issuer" : "Request a new passkey"}
                  </Button>
                </div>
              </div>
            )}
            {open.status === "PendingRedemption" && (
              <div className="mt-4">
                <Note kind="warn">
                  Redemption requested. The record is frozen while the issuer reviews it. If
                  approved it becomes Redeemed, which is permanent.
                </Note>
              </div>
            )}
            {open.status === "Superseded" && (
              <div className="mt-4">
                <Note>
                  Every unit under this record has been assigned out and accepted, so it is
                  superseded. It stays on the register as the parent of what came after it.
                </Note>
              </div>
            )}
            {open.units === 0 && pendingChildren.length > 0 && (
              <div className="mt-4">
                <Note>
                  Every unit has been assigned out. This record stays open until each pending
                  transfer is accepted or cancelled, so cancelled units always have somewhere to return.
                </Note>
              </div>
            )}

            {open.status === "Accepted" && (
              <div className="mt-5 space-y-3">
                <Button onClick={() => requestStepUp("assign")} disabled={open.units <= 0}>
                  Assign out
                </Button>
                <Button variant="quiet" onClick={() => setView("lockConfirm")}>Lock this record</Button>
                <Button variant="quiet" disabled={open.units <= 0 || pendingChildren.length > 0}
                  onClick={() => { setRdErr(""); requestStepUp("redeemConfirm"); }}>
                  Request redemption
                </Button>
                {pendingChildren.length > 0 && open.units > 0 && (
                  <div style={{ fontSize: 12, color: T.inkSoft, lineHeight: 1.5 }}>
                    Redemption opens once your pending transfers are accepted or cancelled.
                    To redeem part of your holding, assign that portion to yourself first.
                  </div>
                )}
              </div>
            )}

            <div className="mt-5">
              <Rows data={[
                ["Held by", open.party],
                ["Attention of", open.contact],
                ["Assignor", open.assignor],
                ["Parent", open.parent || "Issuer-originated"],
                ["Accepted", open.accepted || "—"],
                ["Document hash", open.docHash],
                ["UCC-3 filing ref", open.filingRef || "Not yet filed"],
                ["Delivery ref", open.deliveryRef || "—"],
                ["Transaction", open.tx],
              ]} />
            </div>

            <div style={{ fontFamily: serif, fontSize: 18, color: T.ink, margin: "22px 0 10px" }}>
              Chain of authority
            </div>
            <div style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
              {chainOf(open).map((a, i, arr) => (
                <div key={a.id} className="px-3 py-3"
                  style={{ background: i % 2 ? T.band : T.white, borderTop: i ? "1px solid " + T.rule : "none" }}>
                  <div className="flex justify-between gap-3" style={{ fontSize: 14 }}>
                    <span style={{ color: T.ink, fontWeight: i === arr.length - 1 ? 600 : 400 }}>
                      {a.party}{i === arr.length - 1 ? " · this record" : ""}
                    </span>
                    <span style={{ color: T.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                      {usd(a.units)}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                    {a.id} · from {a.assignor}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ fontFamily: serif, fontSize: 18, color: T.ink, margin: "22px 0 10px" }}>
              Assignments you've made
            </div>
            {liveChildren.length === 0 && (
              <div className="px-3 py-4" style={{ border: "1px solid " + T.rule, borderRadius: 2,
                fontSize: 14, color: T.inkSoft, lineHeight: 1.6 }}>
                None yet. A new assignment stays locked and awaiting a credential until the
                issuer verifies the assignee and mails their passkey.
              </div>
            )}
            {liveChildren.map((c) => (
              <div key={c.id} className="px-3 py-3 mb-2"
                style={{ border: "1px solid " + T.rule, borderRadius: 2, background: T.white }}>
                <div className="flex justify-between items-baseline gap-3">
                  <span style={{ fontSize: 14, color: T.ink }}>{c.party}</span>
                  <span style={{ fontSize: 14, color: T.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                    {usd(c.units)}
                  </span>
                </div>
                <div className="flex justify-between items-center gap-3 mt-2">
                  <span style={{ fontSize: 12, color: T.inkSoft, fontVariantNumeric: "tabular-nums" }}>
                    {c.id} · {c.created}
                  </span>
                  <Chip s={c.status} />
                </div>
                {c.status === "AwaitingCredential" && open.status !== "PendingRedemption" && (
                  <div className="mt-3">
                    <Button variant="quiet" danger onClick={() => cancelAssignOut(c)}>
                      Cancel — return {usd(c.units)}
                    </Button>
                  </div>
                )}
                {c.status === "CredentialRequested" && (
                  <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 8, lineHeight: 1.5 }}>
                    {c.party} has requested access. Only the issuer can cancel this transfer now,
                    after hearing from both sides.
                  </div>
                )}
                {c.status === "Issued" && (
                  <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 8, lineHeight: 1.5 }}>
                    The passkey has been mailed. This transfer can no longer be cancelled.
                  </div>
                )}
              </div>
            ))}

            <div className="mt-5">
              <Button variant="quiet" onClick={() => { setView(null); setOpenId(null); }}>Close</Button>
            </div>
          </div>
        )}

        {/* ============ assign out ============ */}
        {inHolder && view === "assign" && open && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink }}>Assign out</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 20px", maxWidth: "62ch" }}>
              From {open.id}. You hold {usd(open.units)}.
            </p>

            <Note kind="caution">
              You will never see the assignee's passkey. The issuer verifies them and mails it
              directly, so the portion you transfer leaves your control entirely.
            </Note>

            <div className="mt-5">
              <Field label="Units to assign" value={aUnits} onChange={setAUnits} placeholder="10,000" mono
                hint={aUnits && !isNaN(parseInt(aUnits.replace(/[^0-9]/g, ""), 10))
                  ? usd(parseInt(aUnits.replace(/[^0-9]/g, ""), 10) || 0) + " · " +
                    usd(Math.max(0, open.units - (parseInt(aUnits.replace(/[^0-9]/g, ""), 10) || 0))) + " remaining"
                  : null} />
            </div>

            <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, margin: "16px 0 12px" }}>Assignee</div>
            <Field label="Legal name" value={aParty} onChange={setAParty} placeholder="Company E, LLC" />
            <Field label="Attention of" value={aContact} onChange={setAContact} placeholder="Full name" />
            <Field label="Position" value={aPosition} onChange={setAPosition} placeholder="Treasurer, Managing Member" />
            <Area label="Mailing address" value={aAddress} onChange={setAAddress}
              placeholder={"Company E, LLC\nAttn: name, position\nStreet\nCity, State ZIP"} />

            <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, margin: "16px 0 12px" }}>Confirm it's you</div>
            <Field label="Code sent to your verified contact" value={stepUp} onChange={(v) => { setStepUp(v); setAErr(""); }}
              placeholder="6 digits" mono hint={"Demo code: " + STEP_UP_DEMO} />

            {aErr && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, marginBottom: 16 }}>{aErr}</p>}

            <Button onClick={assignOut}>Create the assignment</Button>
            <div className="mt-3">
              <Button variant="quiet" onClick={() => { setView("position"); setAErr(""); }}>Cancel</Button>
            </div>
          </div>
        )}

        {/* ============ child issued ============ */}
        {inHolder && view === "childIssued" && childIssued && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Assignment created</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 20px", maxWidth: "62ch" }}>
              Recorded on-chain and locked awaiting a credential. These are the values the
              register generated — carry them onto whatever instrument you draft.
            </p>

            <Rows data={[
              ["Assignment ID", childIssued.id],
              ["Bond", childIssued.bond],
              ["Parent", childIssued.parent],
              ["Assignor", childIssued.assignor],
              ["Assignee", childIssued.party],
              ["Attention of", childIssued.contact],
              ["Position", childIssued.position || "—"],
              ["Units", num(childIssued.units)],
              ["Value", usd(childIssued.units)],
              ["Proportion", pct(childIssued.units, childIssued.bond)],
              ["Status", LABEL[childIssued.status]],
              ["Document hash", childIssued.docHash],
              ["Transaction", childIssued.tx],
            ]} />

            <div className="mt-4">
              <Note>
                <strong style={{ fontWeight: 600 }}>No passkey appears here, by design.</strong> Deliver
                your signed instrument to {childIssued.party}. They request access with the
                assignment ID; the issuer verifies them and mails the passkey separately.
              </Note>
            </div>

            <div className="mt-4">
              <Note kind="caution">
                You can cancel this yourself and take the {usd(childIssued.units)} back only
                until {childIssued.party} requests access. After that only the issuer can cancel
                it, and once their passkey is mailed it can't be cancelled at all.
              </Note>
            </div>

            <div className="mt-5">
              <Button onClick={() => setView("position")}>Back to my record</Button>
            </div>
          </div>
        )}

        {/* ============ lock confirm ============ */}
        {inHolder && view === "lockConfirm" && open && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Lock this record</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 20px", maxWidth: "62ch" }}>
              Locking takes effect immediately and blocks assigning out and redemption. A signed
              lock notice is recorded with the reason you give.
            </p>

            <Label>Reason</Label>
            <div className="mb-4" style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
              {LOCK_KINDS.map(([k, l], i) => (
                <label key={k} className="flex items-center gap-3 px-3 py-2"
                  style={{ background: i % 2 ? T.band : T.white, fontSize: 14, color: T.ink, cursor: "pointer" }}>
                  <input type="radio" name="lockKind" checked={lockKind === k} onChange={() => setLockKind(k)} />
                  {l}
                </label>
              ))}
            </div>
            <label className="flex items-center gap-3 mb-4" style={{ fontSize: 14, color: T.ink, cursor: "pointer" }}>
              <input type="checkbox" checked={lockRotate} onChange={(e) => setLockRotate(e.target.checked)} />
              Also request a new passkey
            </label>

            <Note kind="caution">
              Only the issuer can unlock it.{" "}
              {lockKind === "pledge"
                ? "For a pledge, they will need your lender's signed release first."
                : "They will verify your identity first."}{" "}
              If the passkey may be compromised, request a new one — it is mailed to you and the
              old one stops working.
            </Note>
            <div className="mt-5 space-y-3">
              <Button onClick={lock}>Lock it</Button>
              <Button variant="quiet" onClick={() => setView("position")}>Cancel</Button>
            </div>
          </div>
        )}

        {/* ============ redeem confirm ============ */}
        {inHolder && view === "redeemConfirm" && open && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Request redemption</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 20px", maxWidth: "62ch" }}>
              This freezes {usd(open.units)} while the issuer reviews the register, the chain
              record and the paperwork.
            </p>
            <Note kind="warn">
              If the issuer approves, the record becomes Redeemed. That is terminal — the
              contract will not accept any further action on it, ever. If they reject it, the
              record returns to Accepted. Redemption covers the whole record.
            </Note>
            <div className="mt-5">
              <Field label="Code sent to your verified contact" value={stepUp}
                onChange={(v) => { setStepUp(v); setRdErr(""); }}
                placeholder="6 digits" mono hint={"Demo code: " + STEP_UP_DEMO} />
            </div>
            {rdErr && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, marginBottom: 16 }}>{rdErr}</p>}
            <div className="space-y-3">
              <Button onClick={requestRedemption}>Request redemption</Button>
              <Button variant="quiet" onClick={() => setView("position")}>Cancel</Button>
            </div>
          </div>
        )}

        {/* ============ request access ============ */}
        {tab === "request" && !rDone && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Request access</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 22px", maxWidth: "62ch" }}>
              If an assignment has been made to you but no passkey has arrived, request one
              here. The issuer verifies that you are the named assignee, then mails it by
              certified post.
            </p>

            <Field label="Assignment ID" value={rId} onChange={setRId} placeholder="KPII-0001-BD-A00003" mono
              hint="On the instrument you received, and in its QR code." />
            <Field label="Assignee legal name" value={rParty} onChange={setRParty} placeholder="Company D" />
            <Field label="Your name and position" value={rContact} onChange={setRContact} placeholder="M. Osei, Treasurer" />
            <Field label="Contact for verification" value={rPhone} onChange={setRPhone} placeholder="Phone or email" />

            {rErr && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, marginBottom: 16 }}>{rErr}</p>}

            <Button onClick={requestAccess}>Submit request</Button>

            <div className="mt-6">
              <Note>
                The issuer will check your details against the named assignee before issuing
                anything. Expect an identity check and a call.
                <div style={{ marginTop: 8, color: T.ink, fontVariantNumeric: "tabular-nums" }}>
                  Demo · awaiting credential: KPII-0001-BD-A00003, Company D, M. Osei
                </div>
              </Note>
            </div>
          </div>
        )}

        {tab === "request" && rDone && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Request submitted</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 20px", maxWidth: "62ch" }}>
              {rDone.id} now shows Credential requested on the register and on-chain.
            </p>
            <div style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
              {[
                ["Request recorded", true],
                ["Issuer verifies you are the named assignee", false],
                ["Passkey generated and mailed by certified post", false],
                ["Status moves to Issued", false],
                ["You accept with the passkey", false],
              ].map(([step, done], i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-3"
                  style={{ borderTop: i ? "1px solid " + T.rule : "none", fontSize: 14 }}>
                  <span style={{ width: 16, height: 16, borderRadius: 8, flexShrink: 0,
                    background: done ? T.ink : "transparent", border: "1px solid " + (done ? T.ink : T.rule) }} />
                  <span style={{ color: done ? T.ink : T.inkSoft, lineHeight: 1.5 }}>{step}</span>
                </div>
              ))}
            </div>
            <div className="mt-5">
              <Button variant="quiet" onClick={() => setRDone(null)}>Submit another</Button>
            </div>
          </div>
        )}

        {/* ============ verify ============ */}
        {tab === "verify" && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Verify an assignment</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 22px", maxWidth: "62ch" }}>
              No account needed. Anyone holding a copy can confirm its current status. Names,
              contact details and passkeys are never shown.
            </p>

            <Field label="Assignment ID" value={vId} onChange={setVId} placeholder="KPII-0001-BD-A00001" mono />
            <Button onClick={verify}>Check the register</Button>

            {vErr && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, marginTop: 16 }}>{vErr}</p>}

            {vRec && (
              <div className="mt-5">
                <div className="flex items-center gap-3 mb-3">
                  <div style={{ fontFamily: serif, fontSize: 19, color: T.ink }}>Record found</div>
                  <Chip s={vRec.status} />
                </div>

                <Rows data={[
                  ["Assignment", vRec.id],
                  ["Bond", vRec.bond],
                  ["Units", num(vRec.units)],
                  ["Proportion", pct(vRec.units, vRec.bond)],
                  ["Parent", vRec.parent || "Issuer-originated"],
                  ["Document hash", vRec.docHash],
                  ["UCC-3 filing ref", vRec.filingRef || "Not yet filed"],
                  ["Delivery ref", vRec.deliveryRef || "—"],
                  ["Last updated", vRec.accepted || vRec.created],
                  ["Transaction", vRec.tx],
                ]} />

                <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, margin: "20px 0 8px" }}>
                  Chain back to the issuer
                </div>
                <div style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
                  {chainOf(vRec).map((a, i) => (
                    <div key={a.id} className="flex justify-between gap-3 px-3 py-2"
                      style={{ background: i % 2 ? T.band : T.white, fontSize: 13 }}>
                      <span style={{ color: T.inkSoft, fontVariantNumeric: "tabular-nums" }}>{a.id}</span>
                      <span style={{ color: T.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {num(a.units)} units
                      </span>
                    </div>
                  ))}
                </div>

                <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, margin: "20px 0 8px" }}>
                  Check your copy of the instrument
                </div>
                <p style={{ fontSize: 14, color: T.inkSoft, lineHeight: 1.6, marginBottom: 10 }}>
                  Your browser hashes the file locally. Nothing is uploaded and nothing leaves
                  this device.
                </p>
                <label className="block px-3 py-3" style={{ border: "1px dashed " + T.rule, borderRadius: 2,
                  cursor: "pointer", background: T.white, fontSize: 14, color: T.ink, textAlign: "center" }}>
                  Choose the PDF
                  <input type="file" style={{ display: "none" }}
                    onChange={(e) => e.target.files?.[0] && hashFile(e.target.files[0], vRec)} />
                </label>

                {vHash && !vHash.error && (
                  <div className="mt-3">
                    <Rows data={[
                      ["File", vHash.name],
                      ["Computed hash", vHash.computed],
                      ["Recorded hash", vRec.docHash],
                    ]} />
                    <div className="mt-2">
                      <Note kind="warn">
                        No match. The recorded hashes in this demo are placeholders, so any real
                        file will differ. In production a match proves your copy is the recorded
                        instrument.
                      </Note>
                    </div>
                  </div>
                )}
                {vHash?.error && (
                  <div className="mt-3"><Note kind="warn">{vHash.error}</Note></div>
                )}

                <div className="mt-5">
                  <Rows data={[
                    ["Contract", CONTRACT],
                    ["Network", CHAIN],
                    ["Read path", "Public RPC, independent of this platform"],
                  ]} />
                </div>

                <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, margin: "20px 0 8px" }}>
                  On-chain events
                </div>
                <div style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
                  {events.filter((e) => e.id === vRec.id).map((e, i) => (
                    <div key={i} className="px-3 py-2"
                      style={{ background: i % 2 ? T.band : T.white, borderTop: i ? "1px solid " + T.rule : "none" }}>
                      <div className="flex justify-between gap-3" style={{ fontSize: 13 }}>
                        <span style={{ color: T.ink }}>{e.ev}</span>
                        <span style={{ color: T.inkSoft, fontVariantNumeric: "tabular-nums" }}>{e.actor}</span>
                      </div>
                      <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                        {e.t} · {e.ref}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed left-0 right-0 flex justify-center px-4" style={{ bottom: 18, zIndex: 60 }}>
          <div className="px-4 py-3" style={{ background: T.ink, color: T.paper, borderRadius: 2,
            fontSize: 14, maxWidth: 520, fontFamily: sans, lineHeight: 1.5 }}>
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}
