import React, { useState, useEffect, useRef } from "react";
import { createDeviceKey, signWithDevice, passkeysAvailable } from "../src/passkey.js";
import { ChainWriting, Spinner, nextChildId } from "../src/registry.jsx";
import { printPacket } from "../src/print-packet.js";
import { useRegistry, api, today, stamp, newEid, Loading, parseUnits, dollars, chainStatus, shortHash, effectiveDate } from "../src/registry.jsx";

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

// Every amount is stored in cents and shown in dollars.
const usd = dollars;

const MAX_ATTEMPTS = 5;
const REJECTION_MIN = 255; // characters: a rejection explains itself

// Children created by assignOut that are neither Accepted nor Cancelled.
const PENDING = ["AwaitingCredential", "CredentialRequested", "Issued"];
const TERMINAL = ["Redeemed", "Superseded", "Cancelled", "Rejected"];

const LOCK_KINDS = [
  ["pledge", "Pledged to a lender"],
  ["sale", "Pending sale"],
  ["compromise", "Access code or device may be compromised"],
  ["other", "Other"],
];

// No paper, no record: every on-chain write carries the hash of the signed
// document behind it. The demo stands in a random hash for that document.
async function sha256File(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
  Accepted: "In effect",
  Locked: "Locked",
  PendingRedemption: "Pending redemption",
  Redeemed: "Redeemed",
  Superseded: "Superseded",
  Cancelled: "Cancelled",
  Rejected: "Rejected",
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
    <button onClick={disabled ? undefined : onClick} disabled={disabled}
      style={{ fontFamily: sans, fontWeight: 500, fontSize: 15, borderRadius: 2, padding: "11px 18px",
        width: "100%", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, ...skin }}>
      {children}
    </button>
  );
}

function Field({ label, value, onChange, placeholder, mono, hint, type }) {
  return (
    <label className="mb-4" style={{ display: "block" }}>
      <Label>{label}</Label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type={type || "text"}
        style={{ width: "100%", fontFamily: sans, fontSize: 16,
          fontVariantNumeric: mono ? "tabular-nums" : "normal", letterSpacing: mono ? "0.04em" : "normal",
          color: T.ink, background: T.white, border: "1px solid " + T.rule, borderRadius: 2,
          padding: "10px 12px", outline: "none" }} />
      {hint && <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 4, lineHeight: 1.5 }}>{hint}</div>}
    </label>
  );
}

function Area({ label, value, onChange, placeholder, rows = 4 }) {
  return (
    <label className="mb-4" style={{ display: "block" }}>
      <Label>{label}</Label>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows}
        style={{ width: "100%", fontFamily: sans, fontSize: 16, color: T.ink, background: T.white,
          border: "1px solid " + T.rule, borderRadius: 2, padding: "10px 12px", outline: "none",
          resize: "vertical", lineHeight: 1.5 }} />
    </label>
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

// Picks or takes a dropped file and keeps only its name and SHA-256. Nothing is uploaded.
/** The holder records the UCC-3 they filed: its number and the filed copy (only its SHA-256 is kept). */
function UccForm({ forWhom, onSave }) {
  const [num, setNum] = useState("");
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState("");
  return (
    <div className="mt-3 px-3 py-3" style={{ border: "1px solid " + T.rule, borderRadius: 2, background: T.white }}>
      <div style={{ fontFamily: serif, fontSize: 16, color: T.ink, marginBottom: 8 }}>Record your UCC-3{forWhom ? " for " + forWhom : ""}</div>
      <Field label="Filing number" value={num} onChange={(v) => { setNum(v); setErr(""); }} placeholder="e.g. 2026 4417 0091" mono />
      <DocDrop label="Filed UCC-3 (acknowledgment copy)" value={doc} onChange={(v) => { setDoc(v); setErr(""); }}
        hint="Hashed on this device; only the hash is kept and written on-chain, with the filing number." />
      {err && <p style={{ color: T.red, fontSize: 14, margin: "0 0 10px" }}>{err}</p>}
      <Button onClick={() => {
        if (!num.trim()) return setErr("Enter the filing number.");
        if (!doc) return setErr("Attach the filed UCC-3.");
        onSave({ filingNumber: num.trim(), filingDoc: doc.hash, filingFile: doc.name, filedOn: today() });
      }}>Record UCC-3: confirm with your passkey</Button>
    </div>
  );
}

// A date recorded as a calendar day (midnight UTC), shown as that same day anywhere.
const utcDay = (sec) => new Date(sec * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const isoToday = () => new Date().toISOString().slice(0, 10);

/**
 * One line of the record you can fill in place: it shows what's recorded; Edit opens its fields right
 * there; Confirm signs it with your passkey. Once recorded it's on-chain and can't be edited again.
 */
function EditRow({ label, value, canEdit, children, onConfirm, onCancel, editing, setEditing, err }) {
  return (
    <div className="mt-3 px-3 py-3" style={{ border: "1px solid " + T.rule, borderRadius: 2, background: T.white }}>
      <div className="flex justify-between items-baseline gap-3">
        <span style={{ fontSize: 14, color: T.inkSoft }}>{label}</span>
        <span className="flex items-baseline gap-3" style={{ fontSize: 14, color: T.ink, textAlign: "right" }}>
          <span>{value}</span>
          {canEdit && !editing && (
            <button onClick={() => setEditing(true)} style={{ ...linkStyle, fontSize: 14, background: "none", border: "none", padding: 0, cursor: "pointer" }}>Edit</button>
          )}
        </span>
      </div>
      {editing && (
        <div className="mt-3">
          {children}
          {err && <p style={{ color: T.red, fontSize: 14, margin: "0 0 10px" }}>{err}</p>}
          <div className="flex gap-3">
            <Button onClick={onConfirm}>Confirm with your passkey</Button>
            <Button variant="quiet" onClick={() => { setEditing(false); onCancel?.(); }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The sender's delivery receipt for an assign-out, recorded by its assignor: mail number, date sent and the receipt. */
function MailingRow({ rec, onSave }) {
  const [editing, setEditing] = useState(false);
  const [num, setNum] = useState("");
  const [on, setOn] = useState(isoToday());
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState("");
  const value = rec.deliveryRef ? "Sent " + (rec.mailedOn || "") + " · recorded on-chain" : "Not recorded";
  return (
    <EditRow label="Delivery receipt" value={value} canEdit={!rec.deliveryRef && rec.status === "Issued"}
      editing={editing} setEditing={(v) => { setEditing(v); setErr(""); }} err={err}
      onConfirm={() => {
        if (!num.trim()) return setErr("Enter the certified mail number.");
        if (!on || on > isoToday()) return setErr("Enter the date it was sent (not a future date).");
        if (!doc) return setErr("Attach the certified mail receipt.");
        onSave({ instrumentMail: num.trim(), mailedOn: on, mailingDoc: doc.hash, mailingFile: doc.name }); setEditing(false);
      }}>
      <Field label="Certified mail number" value={num} onChange={(v) => { setNum(v); setErr(""); }} placeholder="9407 1000 0000 0000 0000 00" mono
        hint="The one mailing with the signed instrument and the sealed transfer code. Only a hash of the number goes on-chain." />
      <Field label="Date sent" type="date" value={on} onChange={(v) => { setOn(v); setErr(""); }}
        hint={rec.party + " has 30 days from this date to accept or reject; after that it takes effect."} />
      <DocDrop label="Certified mail receipt" value={doc} onChange={(v) => { setDoc(v); setErr(""); }}
        hint="Hashed on this device; only the hash is kept and written on-chain, with the number and date." />
    </EditRow>
  );
}

/** The assignee's delivery receipt: the tracking number on it, the date received and the receipt (only its SHA-256 is kept). */
function ReceiptRow({ rec, knownMail, onSave }) {
  const [editing, setEditing] = useState(false);
  const [num, setNum] = useState("");
  const [on, setOn] = useState(isoToday());
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState("");
  const value = !rec.receiptRef ? "Not recorded"
    : "Received " + (rec.receivedOn || "") + (rec.receiptMatches === true ? " · tracking number matches the mailing ✓"
      : rec.receiptMatches === false ? " · tracking number differs from the recorded mailing" : "");
  return (
    <EditRow label="Delivery receipt" value={value} canEdit={!rec.receiptRef && !TERMINAL.includes(rec.status)}
      editing={editing} setEditing={(v) => { setEditing(v); setErr(""); if (v && !num && knownMail) setNum(knownMail); }} err={err}
      onConfirm={() => {
        if (!num.trim()) return setErr("Enter the certified mail number on the receipt.");
        if (!on || on > isoToday()) return setErr("Enter the date you received it (not a future date).");
        if (!doc) return setErr("Attach the delivery receipt.");
        onSave({ receiptMail: num.trim(), receivedOn: on, receiptDoc: doc.hash, receiptFile: doc.name }); setEditing(false);
      }}>
      <Field label="Certified mail number on the receipt" value={num} onChange={(v) => { setNum(v); setErr(""); }} placeholder="9407 1000 0000 0000 0000 00" mono />
      <Field label="Date received" type="date" value={on} onChange={(v) => { setOn(v); setErr(""); }} />
      <DocDrop label="Delivery receipt (USPS confirmation or signed return receipt)" value={doc} onChange={(v) => { setDoc(v); setErr(""); }}
        hint="Hashed on this device; only the hash is kept and written on-chain, with the tracking number and date." />
    </EditRow>
  );
}

function DocDrop({ label, value, onChange, hint }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const take = async (f) => {
    if (!f) return;
    setBusy(true);
    try { onChange({ name: f.name, hash: await sha256File(f) }); } finally { setBusy(false); }
  };
  return (
    <div className="mb-4">
      <div style={{ fontSize: 13, color: T.inkSoft, marginBottom: 6, fontFamily: sans }}>{label}</div>
      <label className="block px-3 py-4"
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]); }}
        style={{ border: over ? "2px solid " + T.ink : "1px dashed " + T.rule, borderRadius: 2, cursor: "pointer",
          background: over ? T.band : T.white, fontSize: 14, color: T.ink, textAlign: "center", wordBreak: "break-all" }}>
        {busy ? "Hashing…" : value ? value.name : over ? "Drop to hash it" : "Drop the PDF here, or choose it"}
        {value && <span style={{ display: "block", fontSize: 12, color: T.inkSoft, marginTop: 2 }}>
          {shortHash(value.hash)} · drop another file to replace it</span>}
        <input type="file" style={{ display: "none" }} onChange={(e) => take(e.target.files?.[0])} />
      </label>
      {hint && <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 4, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

// A record's on-chain standing, linked to the block explorer.
function OnChain({ rec, info }) {
  const st = chainStatus(rec, info);
  if (!st) return null;
  const color = st.tone === "bad" ? T.red : st.tone === "good" ? T.ink : T.inkSoft;
  return st.href
    ? <a href={st.href} target="_blank" rel="noreferrer" style={{ color, textDecoration: "underline", textUnderlineOffset: 2 }}>{st.busy && <Spinner color={color} />}{st.label}{st.tone === "good" ? " · view" : ""}</a>
    : <span style={{ color }}>{st.busy && <Spinner color={color} />}{st.label}</span>;
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

/* ---------------- verify, read straight from the chain ---------------- */

const ORIGIN_SAY = { Issuer: "Issued directly by the issuer", AssignOut: "Assigned out from an earlier record",
  Replacement: "Replaces an earlier record" };
const linkStyle = { color: T.ink, textDecoration: "underline", textUnderlineOffset: 2 };

// The blockchain library is large, so it loads only when the Verify tab opens.
function VerifyChain(props) {
  const [lib, setLib] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { import("../src/chain-read.js").then(setLib).catch(() => setFailed(true)); }, []);
  if (!lib) return <p style={{ fontSize: 14, color: T.inkSoft }}>{failed ? "The verifier couldn't load. Refresh to try again." : "Loading the verifier…"}</p>;
  return <VerifyChainReady {...props} lib={lib} />;
}

function VerifyChainReady({ info, reg, bonds = [], issuerOf, lib }) {
  const { readRecord, readBond, history, nameFor, looksLikeRecord, when, filingRefOf } = lib;
  const start = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("id") || "" : "";
  const [q, setQ] = useState(start);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState(null); // { kind: "record" | "bond", data }
  const [hist, setHist] = useState(null);
  const [histErr, setHistErr] = useState("");
  const [doc, setDoc] = useState(null);

  async function check(value = q) {
    const id = String(value).trim().toUpperCase();
    if (!id) return;
    setBusy(true); setErr(""); setRes(null); setHist(null); setHistErr(""); setDoc(null);
    try {
      const rec = looksLikeRecord(id) ? await readRecord(info, id) : null;
      if (rec) {
        setRes({ kind: "record", data: rec });
        history(info, rec.recordId).then(setHist).catch(() => setHistErr("The history couldn't be read from this endpoint just now. The figures above are current."));
      } else {
        const bond = looksLikeRecord(id) ? null : await readBond(info, id);
        if (bond) setRes({ kind: "bond", data: bond });
        else {
          const inReg = reg.find((a) => a.id.toUpperCase() === id);
          setErr(inReg
            ? "The platform's register has " + id + " (" + (LABEL[inReg.status] || inReg.status).toLowerCase() + "), but it isn't on-chain yet: its write is still on its way. Check again in a minute."
            : "Nothing with the ID " + id + " is recorded on-chain. Check the ID on your paperwork; a record issued in the last minute may still be on its way.");
        }
      }
    } catch (e) {
      setErr("Couldn't reach the blockchain endpoint (" + (e.shortMessage || e.message) + "). Try again in a moment, or look the contract up on the block explorer below.");
    } finally { setBusy(false); }
  }
  useEffect(() => { if (start && info) check(start); }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info) return (
    <div>
      <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Verify an assignment</h1>
      <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, marginTop: 10 }}>On-chain verification isn't switched on for this registry yet.</p>
    </div>
  );

  const contractLink = info.explorer + "/address/" + info.contract;
  const r = res?.kind === "record" ? res.data : null;
  const b = res?.kind === "bond" ? res.data : r?.bond;
  // The platform's own register, shown only to compare with the chain.
  const mine = r && reg.find((a) => a.id.toUpperCase() === r.id);
  const known = reg.map((a) => a.id);
  const parentName = r?.parentId ? nameFor(r.parentId, known) : null;
  const target = r ? r.docHash : b?.instrumentHash;
  const match = doc && target ? doc.hash.toLowerCase() === target.toLowerCase() : null;

  return (
    <div>
      <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Verify an assignment</h1>
      <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 22px", maxWidth: "62ch" }}>
        Enter an assignment ID, or a bond ID, from your paperwork. Your browser reads the answer
        directly from the public blockchain, not from this platform, so you don't have to take our
        word for it. No names or contact details are ever on-chain.
      </p>

      <Field label="Assignment or bond ID" value={q} onChange={(v) => { setQ(v); setErr(""); }} placeholder="KJPII-0001-BD-A00001" mono />
      <Button disabled={busy || !q.trim()} onClick={() => check()}>{busy ? "Reading the chain…" : "Check the chain"}</Button>

      {err && <div className="mt-4"><Note kind="warn">{err}</Note></div>}

      {r && (
        <div className="mt-6">
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <div style={{ fontFamily: serif, fontSize: 21, color: T.ink, fontVariantNumeric: "tabular-nums" }}>{r.id}</div>
            <Chip s={r.status} />
          </div>
          <p style={{ fontSize: 15, color: T.ink, lineHeight: 1.6, marginBottom: 14 }}>
            {r.status === "Redeemed" ? "This record was redeemed. " + usd(r.units) + " was paid out and retired."
              : r.status === "Superseded" ? "This record is closed. Its amount moved to another record."
              : r.status === "Cancelled" ? "This assign-out was cancelled. Its amount went back to the assignor."
              : r.status === "Rejected" ? "The assignee rejected this assignment. Its amount went back " + (r.origin === "AssignOut" ? "to the assignor's record." : "to the bond.")
              : "This record holds " + usd(r.units) + (r.bond ? " of bond " + r.bond.id : "") + "."}
          </p>
          <Rows data={[
            ["Amount", usd(r.units)],
            ["Status", LABEL[r.status] || r.status],
            ["Bond", r.bond ? r.bond.id + " ✓" : "A bond not matching this ID's prefix"],
            mine && ["Issuer", issuerOf(mine)],
            ["How it began", ORIGIN_SAY[r.origin]],
            r.parentId && ["From record", parentName || shortHash(r.parentId)],
            r.pendingChildren > 0 && ["Pending transfers", String(r.pendingChildren)],
            ["UCC-3 filing", !r.filingRef ? "Not recorded"
              : mine?.filingNumber ? mine.filingNumber + (filingRefOf(mine.id, mine.filingNumber, mine.filingDoc) === r.filingRef ? " · matches the chain ✓" : " · doesn't match the chain")
              : "Recorded on-chain"],
            ["Certified mailing", r.deliveryRef ? "Recorded on-chain" + (r.mailedAt ? ", mailed " + utcDay(r.mailedAt) : "") + " (the tracking number is shown only to the assignee)" : "Not recorded"],
            ["Delivery receipt", r.receiptRef ? "Recorded on-chain by the assignee, received " + utcDay(r.receivedAt)
              + (mine ? (mine.receiptRef === r.receiptRef ? " · matches the register ✓" : " · doesn't match the register") : "")
              + (mine?.receiptMatches === true ? " · its tracking number matches the recorded mailing ✓" : mine?.receiptMatches === false ? " · its tracking number differs from the recorded mailing" : "") : "Not recorded"],
            ["Last changed", when(r.updatedAt)],
            ["Document fingerprint", shortHash(r.docHash)],
          ]} />
          {!mine && (
            <div className="mt-3">
              <Note kind="warn">The platform's register has no {r.id}: it was removed from the register. A blockchain can't erase what it
                recorded, so this contract still shows the record as it last stood. The register is the record to rely on.</Note>
            </div>
          )}
          {mine && (
            <div className="mt-3">
              {mine.units === r.units && mine.status === r.status
                ? <Note>The platform's register agrees with the chain: {usd(mine.units)}, {(LABEL[mine.status] || mine.status).toLowerCase()}.</Note>
                : <Note kind="warn">The platform's register shows {usd(mine.units)}, {(LABEL[mine.status] || mine.status).toLowerCase()}, which differs from the chain. A change may still be on its way to the chain; check again in a minute. If it persists, the chain is the record to rely on.</Note>}
            </div>
          )}
        </div>
      )}

      {b && (
        <div className="mt-6">
          <div style={{ fontFamily: serif, fontSize: r ? 17 : 21, color: T.ink, marginBottom: 8 }}>{r ? "The bond it belongs to" : "Bond " + b.id}</div>
          <Rows data={[
            ["Bond", b.id],
            ["Total", usd(b.total)],
            ["Held in assignments", usd(b.live)],
            ["Prior instruments", usd(b.prior)],
            ["Redeemed and retired", usd(b.redeemed)],
            ["Left to assign", usd(b.unassigned)],
            ["Adds up to the total", b.reconciled ? "Yes ✓" : "No"],
            ["Anchored", when(b.anchoredAt)],
            !r && ["Bond instrument fingerprint", shortHash(b.instrumentHash)],
            !r && ["UCC-1 fingerprint", shortHash(b.ucc1Ref)],
          ]} />
          {(() => {
            // The register's figures for the same bond, to compare with the chain's.
            const rb = bonds.find((x) => x.id.toUpperCase() === b.id);
            if (!rb) return null;
            const prior = (rb.prior || []).filter((p) => !p.reversed).reduce((t, p) => t + Number(p.units), 0);
            const redeemed = Number(rb.redeemed || 0), unassigned = Number(rb.unassigned);
            const live = Number(rb.total) - unassigned - redeemed - prior;
            const same = live === b.live && unassigned === b.unassigned && prior === b.prior && redeemed === b.redeemed && Number(rb.total) === b.total;
            return (
              <div className="mt-3">
                {same ? <Note>The platform's register agrees with the chain on this bond's figures.</Note>
                  : <Note kind="warn">The platform's register shows {usd(live)} held in assignments and {usd(unassigned)} left to assign
                      {prior !== b.prior ? ", " + usd(prior) + " in prior instruments" : ""}{redeemed !== b.redeemed ? ", " + usd(redeemed) + " redeemed" : ""}, which
                      differs from the chain. A change may still be on its way; if it persists, records were removed from the register
                      that this contract still holds, and the register is the record to rely on.</Note>}
              </div>
            );
          })()}
        </div>
      )}

      {(r || b) && (
        <div className="mt-6">
          <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 6 }}>
            {r ? "Check your copy of the assignment" : "Check a copy of the bond instrument"}
          </div>
          <p style={{ fontSize: 14, color: T.inkSoft, lineHeight: 1.6, marginBottom: 10 }}>
            Your browser fingerprints the file on this device and compares it with the one on-chain.
            Nothing is uploaded.
          </p>
          <DocDrop label="Signed PDF" value={doc} onChange={setDoc} />
          {match === true && <Note>Match. Your copy is exactly the document on record.</Note>}
          {match === false && <Note kind="warn">No match. This file isn't the document on record: it may be a different version, a scan, or an altered copy.</Note>}
        </div>
      )}

      {r && (
        <div className="mt-6">
          <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 8 }}>History on-chain</div>
          {!hist && !histErr && <p style={{ fontSize: 14, color: T.inkSoft }}>Reading the history…</p>}
          {histErr && <Note kind="warn">{histErr}</Note>}
          {hist && (
            <div style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
              {hist.length === 0 && <div className="px-3 py-2" style={{ fontSize: 14, color: T.inkSoft }}>No events found.</div>}
              {hist.map((e, i) => (
                <div key={e.tx + i} className="flex justify-between gap-3 px-3 py-2"
                  style={{ background: i % 2 ? T.band : T.white, borderTop: i ? "1px solid " + T.rule : "none", fontSize: 14 }}>
                  <span style={{ color: T.ink }}>{e.label}</span>
                  <a href={info.explorer + "/tx/" + e.tx} target="_blank" rel="noreferrer"
                    style={{ ...linkStyle, color: T.inkSoft, fontSize: 13, whiteSpace: "nowrap" }}>{when(e.time)}</a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-8" style={{ fontSize: 13, color: T.inkSoft, lineHeight: 1.6 }}>
        Read from {info.network} through a public endpoint ({new URL(info.rpc).host}), contract{" "}
        <a href={contractLink} target="_blank" rel="noreferrer" style={{ ...linkStyle, color: T.inkSoft }}>
          {info.contract.slice(0, 10)}…{info.contract.slice(-6)}</a>, whose source code is published on the explorer.
      </div>
    </div>
  );
}

/* ---------------- app ---------------- */

export default function HolderPortal() {
  // The signed-in record's session and device key. Every save is signed on the device first: the
  // server says what to sign (what the contract will check), the device signs, the save carries it.
  const session = useRef(null);
  const [device, setDevice] = useState(null); // { fingerprint } once this record has a device key
  const [myMail, setMyMail] = useState(null); // the signed-in record's certified mail number(s)
  // The readable numbers behind the chain's hashes: the UCC-3 filing number is public; the
  // certified mail number only for the record's own signed-in holder.
  const filingSay = (a) => a.filingNumber ? a.filingNumber + (a.filedBy ? " · filed by " + a.filedBy : "")
    : a.filingRef ? "Filed (number not on the register)" : "Not yet filed";
  const mailSay = (a) => {
    const m = myMail && myMail.id === a.id ? myMail : null;
    if (!a.deliveryRef) return "Not yet mailed";
    if (!m) return "Recorded";
    const nums = [...new Set([m.instrumentMail, m.passkeyMail].filter(Boolean))];
    return nums.length ? nums.join(" · ") + (nums.length === 1 && a.origin !== "AssignOut" ? " (instrument and access code)" : "") : "Recorded";
  };
  const [signing, setSigning] = useState(false);
  const beforeCommit = async (body) => {
    const s = session.current;
    if (!s) return null; // only an access request goes without a session
    const { sign } = await api.holderPrepare({ ...body, token: s.token });
    if (!sign.length) return { token: s.token };
    setSigning(true);
    try {
      const assertions = [];
      for (const x of sign) assertions.push(await signWithDevice({ challenge: x.challenge, credId: x.credId, rpId: s.rpId }));
      return { token: s.token, assertions };
    } finally { setSigning(false); }
  };
  const { reg, setReg, bonds, events, setEvents, ready, error, reload, issuers, chainInfo, responseDays, stale } =
    useRegistry({ onNotice: (m) => flash(m), beforeCommit });
  // Every approved issuer shares this registry; each record names its issuer.
  const issuerOf = (rec) => {
    const b = bonds.find((x) => x.id === rec?.bond);
    return issuers.find((i) => i.id === b?.issuerId)?.legalName || "—";
  };
  const ucc1Of = (rec) => {
    const u = bonds.find((x) => x.id === rec?.bond)?.ucc1;
    return u?.number ? u.number + " · " + u.office + " · " + u.date : "—";
  };
  const pct = (u, bondId) => {
    const b = bonds.find((x) => x.id === bondId);
    return b ? ((u / b.total) * 100).toFixed(6) + "%" : "—";
  };
  const [tab, setTab] = useState(() => {
    // The front page links straight to a tab: /assignee#verify.
    const h = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    return h === "verify" ? "verify" : "access";
  });
  const [view, setView] = useState(null);
  const [openId, setOpenId] = useState(null);
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.slice(1);
      if (["access", "verify"].includes(h)) { setTab(h); setView(null); setOpenId(null); }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [toast, setToast] = useState("");

  // sign-in
  // ?id=… (the QR code on the mailing packet) fills in the assignment ID and goes straight to its next step.
  const linkedId = typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("id") || "").trim().toUpperCase() : "";
  const [qId, setQId] = useState(linkedId);
  const [qKey, setQKey] = useState("");
  const [qErr, setQErr] = useState("");

  // lock
  const [lockKind, setLockKind] = useState("pledge");
  const [lockRotate, setLockRotate] = useState(false);
  const [rjReason, setRjReason] = useState(""); // why the holder rejects an assignment
  const [rjErr, setRjErr] = useState("");

  // assign out
  const [aUnits, setAUnits] = useState("");
  const [aParty, setAParty] = useState("");
  const [aContact, setAContact] = useState("");
  const [aPosition, setAPosition] = useState("");
  const [aAddress, setAAddress] = useState("");
  const [aDoc, setADoc] = useState(null); // the signed assignment to the new party
  const [aErr, setAErr] = useState("");
  const [childIssued, setChildIssued] = useState(null);
  // The new assignee's access code, shown once on this screen once the assign-out is saved.
  const [childCode, setChildCode] = useState(null); // { code } | { error } | null while waiting
  // The same, from the list of assign-outs: for when the assignor left that screen before it showed.
  const [listCodes, setListCodes] = useState({});
  // The mailing packet for an assign-out this assignee made: the instruction letter and the code page.
  function printFor(c, code) {
    try {
      printPacket({ rec: c, code, bond: bonds.find((b) => b.id === c.bond), from: open?.party || c.assignor,
        issuer: issuerOf(c), site: window.location.origin, days: responseDays });
    } catch (e) { flash(e.message); }
  }

  async function showTransferCode(c) {
    try { const r = await api.assigneeCode(session.current?.token, c.id); setListCodes((m) => ({ ...m, [c.id]: { code: r.code } })); }
    catch (e) { setListCodes((m) => ({ ...m, [c.id]: { error: e.message } })); }
  }
  useEffect(() => {
    if (view !== "childIssued" || !childIssued || childCode) return;
    let stop = false, tries = 0;
    const tick = async () => {
      if (stop) return;
      try { const r = await api.assigneeCode(session.current?.token, childIssued.id); if (!stop) setChildCode({ code: r.code }); }
      catch (e) {
        // Not saved yet while the device is still signing: try again shortly.
        if (e.status === 404 && tries++ < 60) return setTimeout(tick, 1000);
        if (!stop) setChildCode({ error: e.message });
      }
    };
    tick();
    return () => { stop = true; };
  }, [view, childIssued, childCode]);

  // request access
  const [rId, setRId] = useState("");
  const [rParty, setRParty] = useState("");
  const [rContact, setRContact] = useState("");
  const [rPhone, setRPhone] = useState("");
  const [rErr, setRErr] = useState("");
  const [rDone, setRDone] = useState(null);

  // verify

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
  // Holder access: the assignment ID first. The server says what opens it: the one-time transfer
  // code (until a passkey is set up), or the passkey itself.
  const [qStep, setQStep] = useState(null); // null | { mode: "code" } | { mode: "passkey", ... }
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!ready || autoStarted.current || !linkedId || tab !== "access") return;
    autoStarted.current = true;
    start(linkedId);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start(given) {
    const id = (typeof given === "string" ? given : qId).trim().toUpperCase();
    if (!id) return;
    setQErr("");
    let r;
    try { r = await api.holderStart(id); } catch (e) { return setQErr(e.message); }
    if (r.mode === "code" || r.mode === "passkey") {
      // Keep the ID in the address, so the page can be bookmarked or reopened straight to it.
      try { const u = new URL(window.location.href); u.searchParams.set("id", id); window.history.replaceState(null, "", u); } catch { /* fine without it */ }
      return setQStep(r);
    }
    if (r.mode === "locked") return setQErr("This transfer code is locked after " + MAX_ATTEMPTS + " failed attempts. The issuer must verify your identity before it can be unlocked.");
    if (r.mode === "closed") return setQErr("This record is " + (LABEL[r.status] || r.status).toLowerCase() + " and can no longer be acted on.");
    setQErr(r.error || "That assignment can't be opened.");
  }

  async function opened(id, res) {
    const fresh = (await reload().catch(() => null))?.reg.find((a) => a.id === id) || reg.find((a) => a.id === id);
    if (!fresh) return setQErr("No assignment with that ID is on the register.");
    setQErr(""); setQKey(""); setQStep(null);
    session.current = { id: fresh.id, token: res.token, rpId: res.rpId, enroll: res.enroll };
    api.holderMine(res.token).then(setMyMail).catch(() => setMyMail(null));
    setDevice(res.device);
    setOpenId(fresh.id);
    setView(res.device ? (fresh.status === "Issued" ? "claim" : "position") : "device");
  }

  async function signInWithCode() {
    const id = qStep?.id || qId.trim().toUpperCase();
    let res;
    try { res = await api.signIn(id, qKey); } catch (e) { setQErr(e.message); return; }
    if (!res.ok) {
      if (res.code === "locked") {
        await reload().catch(() => {});
        setQErr("This transfer code is locked after " + MAX_ATTEMPTS + " failed attempts. The issuer must verify your identity before it can be unlocked.");
      } else if (res.code === "mismatch") {
        setQErr("That transfer code doesn't match. " + res.left + (res.left === 1 ? " attempt" : " attempts") + " remaining before it locks.");
      } else {
        setQErr(res.error || "Sign-in failed.");
      }
      return;
    }
    await opened(id, res);
  }

  const [qBusy, setQBusy] = useState(false);
  async function signInWithPasskey() {
    const st = qStep;
    setQErr(""); setQBusy(true);
    try {
      const assertion = await signWithDevice({ challenge: st.challenge, credId: st.credId, rpId: st.rpId });
      const res = await api.signInPasskey({ id: st.id, challenge: st.challenge, exp: st.exp, ticket: st.ticket, assertion });
      await opened(st.id, res);
    } catch (e) {
      setQErr(e.message);
      if (/took too long/.test(e.message)) setQStep(null);
    } finally { setQBusy(false); }
  }

  // First sign-in on this record: the device makes a key, then signs its registration with it.
  const [devErr, setDevErr] = useState("");
  const [devBusy, setDevBusy] = useState(false);
  async function setUpDevice() {
    const s = session.current;
    if (!s?.enroll) return;
    setDevErr(""); setDevBusy(true);
    try {
      const made = await createDeviceKey(s.enroll);
      const { challenge } = await api.holderKeyPrepare({ token: s.token, ...made });
      const assertion = await signWithDevice({ challenge, credId: made.credId, rpId: s.rpId });
      const r = await api.holderKey({ token: s.token, ...made, assertion });
      setDevice({ fingerprint: r.fingerprint, credId: r.credId, since: r.since });
      await reload().catch(() => {});
      flash("Passkey set up. The transfer code no longer works; from now on your passkey opens this assignment.");
      setView(open?.status === "Issued" ? "claim" : "position");
    } catch (e) { setDevErr(e.message); } finally { setDevBusy(false); }
  }

  // The holder confirms the assignment now instead of waiting out the response period.
  function confirmNow() {
    // A child taking effect may close its parent: zero units and nothing pending.
    setReg((r) => settleParent(
      r.map((a) => (a.id === open.id ? { ...a, status: "Accepted", accepted: today(), effective: "holder", effectiveOn: today() } : a)),
      open.origin === "AssignOut" ? open.parent : null
    ));
    emit(open.bond, open.id, "Acknowledged", "RELAYER");
    setView("position");
    flash("Confirmed. The assignment is in effect, and the chain is being updated.");
  }

  // The only way to refuse an assignment: explicitly, with a reason. The amount goes back to
  // the assignor's record for an assign-out, otherwise to the bond.
  function rejectAssignment() {
    const why = rjReason.trim();
    if (why.length < REJECTION_MIN) return setRjErr("Explain why in at least " + REJECTION_MIN + " characters. The issuer and the assignor will read it.");
    setRjErr("");
    setReg((r) => r.map((a) => {
      if (a.id === open.id) return { ...a, status: "Rejected", rejectionReason: why, rejectedOn: today() };
      if (open.origin === "AssignOut" && a.id === open.parent) return { ...a, units: a.units + open.units };
      return a;
    }));
    emit(open.bond, open.id, "AssignmentRejected", "RELAYER", why);
    setRjReason("");
    setView(null); setOpenId(null);
    flash("Rejected. " + usd(open.units) + (open.origin === "AssignOut" ? " goes back to the assignor's record." : " goes back to the bond."));
  }

  function assignOut() {
    if (open.status !== "Accepted") return setAErr("Only a record that's in effect and unlocked can assign out.");
    const au = parseUnits(aUnits), u = au.units;
    if (au.error) return setAErr(au.error);
    if (u > open.units) return setAErr("You hold " + usd(open.units) + ".");
    if (!aParty.trim()) return setAErr("Enter the assignee's legal name.");
    if (!aContact.trim()) return setAErr("Name the person the assignment is addressed to.");
    if (!aAddress.trim()) return setAErr("Add a mailing address.");
    if (!aDoc) return setAErr("Add the signed assignment. Only its SHA-256 hash is kept.");
    setAErr("");

    const child = {
      id: nextChildId(reg, open.id), // a branch of the record it comes from: A00001-1, A00001-1-1, …
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
      status: "Issued", // open to the assignee at once: they claim it with the transfer code
      created: today(),
      accepted: null,
      docHash: aDoc.hash, // SHA-256 of the signed child instrument
      docFile: aDoc.name,
      filingRef: null,
      deliveryRef: null,
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
    setChildIssued(child); setChildCode(null);
    setAUnits(""); setAParty(""); setAContact(""); setAPosition(""); setAAddress(""); setADoc(null);
    setView("childIssued");
  }

  // The holder records a UCC-3: on their own record, or on an assign-out they made. Saved like any
  // other change, so their passkey signs it and it goes on-chain with the filed copy's hash.
  const [uccFor, setUccFor] = useState(null);
  function recordUcc(rec, f) {
    const by = open.party; // whoever is signed in filed it: the holder, for their record or an assign-out they made
    setReg((r) => r.map((a) => (a.id === rec.id ? { ...a, ...f, filedBy: by } : a)));
    emit(rec.bond, rec.id, "FilingRecorded", "HOLDER", f.filingNumber);
    flash("UCC-3 " + f.filingNumber + " recorded. Confirm with your passkey; it's written on-chain with the filed copy's hash.");
  }

  function recordMailingOf(child, f) {
    setReg((r) => r.map((a) => (a.id === child.id ? { ...a, ...f } : a)));
    emit(child.bond, child.id, "DeliveryRecorded", "HOLDER", "sent " + f.mailedOn);
    flash("Delivery receipt recorded: sent " + f.mailedOn + ". Confirm with your passkey; only hashes go on-chain, with the date.");
  }

  function recordReceipt(rec, f) {
    setReg((r) => r.map((a) => (a.id === rec.id ? { ...a, ...f } : a)));
    emit(rec.bond, rec.id, "ReceiptRecorded", "HOLDER", "received " + f.receivedOn);
    flash("Delivery receipt recorded. Confirm with your passkey; it's written on-chain with the receipt's hash.");
  }

  function cancelAssignOut(child) {
    // Only until the assignee has claimed it (set up their device on it).
    if (child.status !== "Issued" || child.deviceKey?.fingerprint) return;
    if (open.status === "PendingRedemption") return;
    // Units go back; the parent's status is never touched, so a lock stays a lock.
    setReg((r) => r.map((a) => {
      if (a.id === child.id) return { ...a, status: "Cancelled" };
      if (a.id === open.id) return { ...a, units: a.units + child.units };
      return a;
    }));
    emit(child.bond, child.id, "AssignOutCancelled", "RELAYER", "—");
    flash("Cancelled. " + usd(child.units) + " returned to your record.");
  }

  function lock() {
    const label = LOCK_KINDS.find(([k]) => k === lockKind)[1];
    setReg((r) => r.map((a) => (a.id === open.id
      ? { ...a, status: "Locked", lockKind, lockReason: label, lockedOn: today(),
          rotationRequested: lockRotate, unlockRequested: false }
      : a)));
    emit(open.bond, open.id, "Locked", "RELAYER", "—");
    setLockKind("pledge"); setLockRotate(false);
    setView("position");
    flash(lockRotate
      ? "Locked, and a new access code requested. Only the issuer can unlock it."
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
    flash("New access code requested. The issuer will verify your identity and mail it.");
  }





  // "Request access" is held back until its use case is defined.
  const tabs = [["access", "Assignee access"], ["verify", "Verify"]];
  const inHolder = view && tab === "access";

  if (!ready) return <Loading error={error} />;

  return (
    <div style={{ background: T.paper, minHeight: "100%", fontFamily: sans }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Spectral:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid ${T.ink}; outline-offset: 1px; }
        input:focus, textarea:focus { border-color: ${T.ink} !important; }`}</style>

      {stale && (
        <div style={{ background: T.ink, color: T.paper, fontSize: 14, fontFamily: sans }}>
          <div className="mx-auto flex items-center justify-between gap-3" style={{ maxWidth: 560, padding: "10px 18px" }}>
            <span>A newer version of the registry is live.</span>
            <button onClick={() => window.location.reload()} style={{ fontFamily: sans, fontSize: 14, color: T.ink, background: T.paper,
              border: "none", borderRadius: 2, padding: "6px 12px", cursor: "pointer", whiteSpace: "nowrap" }}>Reload</button>
          </div>
        </div>
      )}
      <div className="mx-auto" style={{ maxWidth: 560, padding: "20px 18px 56px" }}>
        <div className="flex items-baseline justify-between">
          <a href="/" style={{ fontFamily: serif, fontSize: 21, color: T.ink, fontWeight: 500, textDecoration: "none", display: "block" }}>Interest Registry</a>
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

        {/* What the signed-in holder just did, on its way to the chain. */}
        {inHolder && open && (
          <ChainWriting chainInfo={chainInfo} ink={T.ink} soft={T.inkSoft} wash={T.wash}
            items={reg.filter((a) => a.id === open.id || a.parent === open.id)} />
        )}

        {/* ============ holder access ============ */}
        {tab === "access" && !view && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Open your assignment</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 22px", maxWidth: "62ch" }}>
              Enter the assignment ID from your instrument. The first time, you'll use the one-time transfer
              code from your mailing and set up a passkey; after that, your passkey opens it.
            </p>

            <Field label="Assignment ID" value={qId} onChange={(v) => { setQId(v); setQStep(null); setQErr(""); }} placeholder="KJPII-0001-BD-A00001" mono />

            {!qStep && <Button onClick={start}>Continue</Button>}

            {qStep?.mode === "code" && (
              <div>
                <Field label="Transfer code" value={qKey} onChange={setQKey} placeholder="XXXX-XXXX-XXXX-XXXX" mono
                  hint="The one-time code in the sealed envelope with your instrument. You'll set up your passkey next." />
                <Button onClick={signInWithCode}>Continue</Button>
              </div>
            )}

            {qStep?.mode === "passkey" && (
              <div>
                <Rows data={[
                  ["Secured with", "A passkey"],
                  ["Set up", qStep.since || "—"],
                  ["Key", qStep.fingerprint],
                ]} />
                <div className="mt-4">
                  <Button disabled={qBusy} onClick={signInWithPasskey}>{qBusy ? "Confirm on your device…" : "Sign in with your passkey"}</Button>
                </div>
                <div style={{ fontSize: 13, color: T.inkSoft, marginTop: 10, lineHeight: 1.5 }}>
                  Use the device, password manager or security key you set it up with. If you used a YubiKey or a
                  Trezor and Bitwarden or your browser offers a saved passkey, choose “Use another device” or
                  “Security key” instead, then confirm on the key. Lost it? The issuer can verify you, reset it,
                  and mail you a new transfer code.
                </div>
              </div>
            )}

            {qErr && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, margin: "14px 0 0" }}>{qErr}</p>}

            <div className="mt-6">
              <Note>
                Your transfer code comes in a sealed envelope inside the certified mailing with your
                instrument. Nothing from the registry will ever email you one or ask for it.
              </Note>
            </div>
          </div>
        )}

        {/* ============ device key setup ============ */}
        {inHolder && view === "device" && open && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Set up this device</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 18px", maxWidth: "62ch" }}>
              Your phone or computer makes a key that never leaves it, unlocked with your face,
              fingerprint or device PIN. Every action you take on {open.id} is signed with it, and the
              chain refuses anything that isn't. Nobody else can act for you: not the issuer, not the
              registry.
            </p>
            <Rows data={[
              ["Assignment", open.id],
              ["You'll be asked", "Twice: once to make the key, once to sign its registration"],
              ["Then", "The transfer code from your mailing stops working. Your passkey opens this assignment from then on."],
              ["What you can use", "This phone or computer, a password manager such as Bitwarden, or a security key such as a YubiKey or a Trezor."],
              ["Using a security key", "If Bitwarden or your browser offers to save the passkey, choose \u201cUse another device\u201d or \u201cSecurity key\u201d instead (in Bitwarden, close its window first). Then plug in or connect the key and confirm on it with its PIN. Use that same key every time."],
              ["Use", "The device you'll use to manage this assignment. Passkeys saved to your Apple, Google or Microsoft account work on your other devices too."],
            ]} />
            {!passkeysAvailable() && <div className="mt-4"><Note kind="warn">This browser can't use passkeys. Open this page on an up-to-date phone or computer.</Note></div>}
            {devErr && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, margin: "14px 0 0" }}>{devErr}</p>}
            <div className="mt-5 space-y-3">
              <Button disabled={devBusy || !passkeysAvailable()} onClick={setUpDevice}>{devBusy ? "Follow your device's prompts…" : "Set up device key"}</Button>
              <Button variant="quiet" onClick={() => { session.current = null; setView(null); setOpenId(null); }}>Not now</Button>
            </div>
          </div>
        )}

        {/* ============ claim ============ */}
        {inHolder && view === "claim" && open && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Review this assignment</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 20px", maxWidth: "62ch" }}>
              {effectiveDate(open, responseDays)
                ? "It takes effect on " + effectiveDate(open, responseDays) + " unless you reject it before then. "
                : "It takes effect " + responseDays + " days after it's mailed, unless you reject it. "}
              You can confirm it now, or reject it with a reason. Either way it's recorded on-chain.
            </p>

            <div className="mb-5 px-3 py-4" style={{ border: "2px solid " + T.ink, borderRadius: 2, background: T.white }}>
              <Label>What the register records for this assignment</Label>
              <div style={{ fontFamily: serif, fontSize: 34, color: T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>
                {usd(open.units)}
              </div>
              <div style={{ fontSize: 14, color: T.inkSoft, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                {pct(open.units, open.bond)} of {open.bond}
              </div>
              <div className="mt-4 pt-3" style={{ borderTop: "1px solid " + T.rule, fontSize: 14, color: T.ink, lineHeight: 1.6 }}>
                Check this against the instrument in front of you.
              </div>
            </div>

            <Rows data={[
              ["Issuer", issuerOf(open)],
              ["Assignment", open.id],
              ["Assignor", open.assignor],
              ["Assignee", open.party],
              ["Attention of", open.contact],
              ["Position", open.position || "—"],
              ["Parent", open.parent || "Issuer-originated"],
              ["Dated", open.created],
              ["Document hash", open.docHash],
              ["UCC-3 filing", filingSay(open)],
              open.filingRef && ["UCC-3 filing ref", open.filingRef],
              ["Certified mailing", mailSay(open)],
              open.deliveryRef && ["Delivery ref", open.deliveryRef],
            ]} />
            <ReceiptRow rec={open} knownMail={myMail && myMail.id === open.id ? myMail.instrumentMail || myMail.passkeyMail : null} onSave={(f) => recordReceipt(open, f)} />

            <div className="mt-5 space-y-3">
              <Button onClick={confirmNow}>Accept: confirm with your passkey</Button>
              <Button variant="quiet" danger onClick={() => { setRjErr(""); setView("mismatch"); }}>
                Reject this assignment
              </Button>
              <Button variant="quiet" onClick={() => { setView(null); setOpenId(null); }}>Back</Button>
            </div>
          </div>
        )}

        {/* ============ reject ============ */}
        {inHolder && view === "mismatch" && open && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Reject this assignment</h1>
            <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 20px", maxWidth: "62ch" }}>
              Rejecting is final. {usd(open.units)} goes back {open.origin === "AssignOut" ? "to " + open.assignor + "'s record" : "to the bond"},
              and this record can't be revived. If the figures are simply wrong, you may prefer to
              contact {open.assignor} first; until{effectiveDate(open, responseDays) ? " " + effectiveDate(open, responseDays) : " the response period ends"} nothing changes.
            </p>
            <Rows data={[
              ["Assignment", open.id],
              ["Registered amount", usd(open.units)],
              ["Assignor", open.assignor],
              ["Document hash", shortHash(open.docHash)],
            ]} />
            <div className="mt-5">
              <Area label={"Reason for rejecting (at least " + REJECTION_MIN + " characters)"} value={rjReason} onChange={(v) => { setRjReason(v); setRjErr(""); }}
                rows={7} placeholder="For example: the amount on my instrument is different from the register, or I didn't agree to this assignment. Say what you expected and what you received." />
              <div style={{ fontSize: 12, color: rjReason.trim().length >= REJECTION_MIN ? T.inkSoft : T.red, margin: "-8px 0 12px", fontVariantNumeric: "tabular-nums" }}>
                {rjReason.trim().length} of {REJECTION_MIN} characters{rjReason.trim().length >= REJECTION_MIN ? " · enough" : ""}
              </div>
              {rjErr && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, marginBottom: 12 }}>{rjErr}</p>}
              <div className="space-y-3">
                <Button danger disabled={rjReason.trim().length < REJECTION_MIN} onClick={rejectAssignment}>Reject: confirm with your passkey</Button>
                <Button variant="quiet" onClick={() => setView("claim")}>Back to the assignment</Button>
              </div>
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
              {pct(open.units, open.bond)} of {open.bond}
              {open.issuedUnits !== open.units ? " · issued at " + usd(open.issuedUnits) : ""}
            </div>
            {device && (
              <div style={{ fontSize: 13, color: T.inkSoft, marginTop: 8 }}>
                Signed with your passkey <span style={{ color: T.ink, fontVariantNumeric: "tabular-nums" }}>{device.fingerprint}</span>
                {(device.since || open.deviceKey?.since) ? " · set up " + (device.since || open.deviceKey?.since) : ""}
              </div>
            )}

            {open.status === "Locked" && (
              <div className="mt-4">
                <Note kind="warn">
                  This record is locked{open.lockReason ? " (" + open.lockReason.toLowerCase() + ")" : ""}.
                  Assigning out is blocked until the issuer unlocks it.
                  {open.lockKind === "pledge" && " The issuer will need your lender's signed release to unlock it."}
                </Note>
                <div className="mt-3 space-y-3">
                  <Button variant="quiet" disabled={open.unlockRequested} onClick={requestUnlock}>
                    {open.unlockRequested ? "Unlock requested — with the issuer" : "Request unlock"}
                  </Button>
                  <Button variant="quiet" disabled={open.rotationRequested} onClick={requestRotation}>
                    {open.rotationRequested ? "New access code requested — with the issuer" : "Request a new access code"}
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
                  Every unit under this record has been assigned out and is in effect elsewhere, so it is
                  superseded. It stays on the register as the parent of what came after it.
                </Note>
              </div>
            )}
            {open.units === 0 && pendingChildren.length > 0 && (
              <div className="mt-4">
                <Note>
                  Every unit has been assigned out. This record stays open until each pending
                  transfer takes effect, is rejected or is cancelled, so a cancelled amount always has somewhere to return.
                </Note>
              </div>
            )}

            {open.status === "Accepted" && (
              <div className="mt-5 space-y-3">
                <Button onClick={() => setView("assign")} disabled={open.units <= 0}>
                  Assign out
                </Button>
                <Button variant="quiet" onClick={() => setView("lockConfirm")}>Lock this record</Button>
              </div>
            )}

            <div className="mt-5">
              <Rows data={[
                ["Issuer", issuerOf(open)],
                ["Bond UCC-1", ucc1Of(open)],
                ["Held by", open.party],
                ["Attention of", open.contact],
                ["Assignor", open.assignor],
                ["Parent", open.parent || "Issuer-originated"],
                ["In effect since", open.effectiveOn || open.accepted || "—"],
                ["Document hash", shortHash(open.docHash)],
                ["UCC-3 filing", filingSay(open)],
                open.filingRef && ["UCC-3 filing ref", shortHash(open.filingRef)],
                ["Certified mailing", mailSay(open)],
                ["Delivery ref", open.deliveryRef ? shortHash(open.deliveryRef) : "—"],
                chainInfo && ["On-chain", <OnChain rec={open} info={chainInfo} />],
              ]} />
            </div>

            {(open.receiptRef || !TERMINAL.includes(open.status)) && (
              <ReceiptRow rec={open} knownMail={myMail && myMail.id === open.id ? myMail.instrumentMail || myMail.passkeyMail : null} onSave={(f) => recordReceipt(open, f)} />
            )}


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
                None yet. When you assign out, you mail the signed instrument and the sealed transfer
                code to the assignee in one certified mailing, then record its number and date here.
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
                {["AwaitingCredential", "CredentialRequested", "Issued"].includes(c.status) && !c.deviceKey?.fingerprint && (
                  <div className="mt-3">
                    {listCodes[c.id]?.code ? (
                      <div>
                        <div style={{ fontSize: 12, color: T.inkSoft, marginBottom: 4 }}>{c.party}'s transfer code: seal it and send it with your signed instrument. It works once.</div>
                        <div className="px-3 py-2 text-center" style={{ border: "2px solid " + T.ink, borderRadius: 2, fontSize: 20, letterSpacing: "0.08em",
                          color: T.ink, fontVariantNumeric: "tabular-nums", userSelect: "all" }}>{listCodes[c.id].code}</div>
                        <div className="mt-2"><Button variant="quiet" onClick={() => printFor(c, listCodes[c.id].code)}>Print mailing packet</Button></div>
                      </div>
                    ) : listCodes[c.id]?.error ? (
                      <div style={{ fontSize: 12, color: T.inkSoft, lineHeight: 1.5 }}>{listCodes[c.id].error}</div>
                    ) : (
                      <Button variant="quiet" onClick={() => showTransferCode(c)}>Show {c.party}'s transfer code</Button>
                    )}
                  </div>
                )}
                {(c.status === "Issued" || c.deliveryRef) && <MailingRow rec={c} onSave={(f) => recordMailingOf(c, f)} />}
                {c.receiptRef && (
                  <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 8 }}>{c.party} recorded receipt{c.receivedOn ? " " + c.receivedOn : ""}{c.receiptMatches === false ? " · tracking number differs from your mailing" : c.receiptMatches ? " · tracking number matches ✓" : ""}</div>
                )}
                {!c.filingNumber && !c.filingRef && !TERMINAL.includes(c.status) && (
                  uccFor === c.id ? <UccForm forWhom={c.party} onSave={(f) => { recordUcc(c, f); setUccFor(null); }} />
                    : <div className="mt-3"><Button variant="quiet" onClick={() => setUccFor(c.id)}>Record the UCC-3 for this assignment</Button></div>
                )}
                {c.filingNumber && (
                  <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 8 }}>UCC-3 {c.filingNumber}{c.filedBy ? " · filed by " + c.filedBy : ""}</div>
                )}
                {c.status === "Issued" && !c.deviceKey?.fingerprint && (
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
                {c.status === "Issued" && c.deviceKey?.fingerprint && (
                  <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 8, lineHeight: 1.5 }}>
                    {c.party} has claimed it. Only they can accept or reject it now; you can no longer cancel it.
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
              You will never see the assignee's access code. The issuer verifies them and mails it
              directly, so the portion you transfer leaves your control entirely.
            </Note>

            <div className="mt-5">
              <Field label="Amount to assign" value={aUnits} onChange={setAUnits} placeholder="10,000.00" mono
                hint={aUnits ? (parseUnits(aUnits).error ||
                  usd(parseUnits(aUnits).units) + " · " + usd(Math.max(0, open.units - parseUnits(aUnits).units)) + " remaining") : null} />
            </div>

            <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, margin: "16px 0 12px" }}>Assignee</div>
            <Field label="Legal name" value={aParty} onChange={setAParty} placeholder="Company E, LLC" />
            <Field label="Attention of" value={aContact} onChange={setAContact} placeholder="Full name" />
            <Field label="Position" value={aPosition} onChange={setAPosition} placeholder="Treasurer, Managing Member" />
            <Area label="Mailing address" value={aAddress} onChange={setAAddress}
              placeholder={"Company E, LLC\nAttn: name, position\nStreet\nCity, State ZIP"} />
            <DocDrop label="Signed assignment" value={aDoc} onChange={(v) => { setADoc(v); setAErr(""); }}
              hint="The assignment you signed to this party. It's hashed on this device; only the hash is kept and written on-chain." />

            <div className="mb-4">
              <Note>
                Your phone or computer asks you to confirm with your face, fingerprint or device PIN.
                That signature is what authorizes the transfer: the chain refuses it without one.
              </Note>
            </div>

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
              Signed with your device and being recorded on-chain. It's open to the assignee now:
              give them the transfer code below with the instrument. These are the values the register generated; carry them onto
              the instrument you sign.
            </p>

            <Rows data={[
              ["Assignment ID", childIssued.id],
              ["Bond", childIssued.bond],
              ["Parent", childIssued.parent],
              ["Assignor", childIssued.assignor],
              ["Assignee", childIssued.party],
              ["Attention of", childIssued.contact],
              ["Position", childIssued.position || "—"],
              ["Amount", usd(childIssued.units)],
              ["Proportion", pct(childIssued.units, childIssued.bond)],
              ["Status", LABEL[childIssued.status]],
              ["Document hash", shortHash(childIssued.docHash)],
            ]} />

            <div className="mt-5">
              <Label>{childIssued.party}'s transfer code</Label>
              {!childCode ? (
                <div style={{ fontSize: 14, color: T.inkSoft, padding: "14px 0" }}>Saving the assignment and confirming your device's signature…</div>
              ) : childCode.error ? (
                <Note kind="warn">{childCode.error}</Note>
              ) : (
                <>
                  <div className="px-3 py-4 mb-3 text-center" style={{ border: "2px solid " + T.ink, borderRadius: 2, background: T.white,
                    fontSize: 24, letterSpacing: "0.08em", color: T.ink, fontVariantNumeric: "tabular-nums", userSelect: "all" }}>
                    {childCode.code}
                  </div>
                  <div className="mb-3"><Button onClick={() => printFor({ ...childIssued, ...(reg.find((x) => x.id === childIssued.id) || {}), address: childIssued.address }, childCode.code)}>Print mailing packet</Button></div>
                  <Note kind="warn">
                    <strong style={{ fontWeight: 600 }}>Keep it private.</strong> Print the mailing packet: the instruction letter, and
                    this code on its own page to seal in its own envelope. Send both with your signed instrument to {childIssued.party} in one certified
                    mailing, then record its delivery receipt below. {childIssued.party} signs in at Assignee access with
                    the assignment ID and this code, sets up their passkey, then accepts or rejects it. It works once:
                    their passkey replaces it. Until then you can show it again from your record.
                  </Note>
                  {(() => { const cur = reg.find((x) => x.id === childIssued.id) || childIssued;
                    return <MailingRow rec={cur} onSave={(f) => recordMailingOf(cur, f)} />; })()}
                </>
              )}
            </div>

            <div className="mt-4">
              <Note kind="caution">
                You can cancel this yourself and take the {usd(childIssued.units)} back only until{" "}
                {childIssued.party} claims it with the transfer code. After that only they can accept or
                reject it.
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
              Locking takes effect immediately and blocks assigning out. A signed
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
              Also request a new access code
            </label>

            <Note kind="caution">
              Only the issuer can unlock it.{" "}
              {lockKind === "pledge"
                ? "For a pledge, they will need your lender's signed release first."
                : "They will verify your identity first."}{" "}
              If the access code may be compromised, request a new one — it is mailed to you and the
              old one stops working.
            </Note>
            <div className="mt-5 space-y-3">
              <Button onClick={lock}>Lock it</Button>
              <Button variant="quiet" onClick={() => setView("position")}>Cancel</Button>
            </div>
          </div>
        )}

        {/* ============ verify ============ */}
        {tab === "verify" && <VerifyChain info={chainInfo} reg={reg} bonds={bonds} issuerOf={issuerOf} />}
      </div>

      {signing && (
        <div className="fixed left-0 right-0 flex justify-center px-4" style={{ top: 18, zIndex: 61 }}>
          <div className="px-4 py-3" style={{ background: T.white, color: T.ink, border: "1px solid " + T.ink, borderRadius: 2,
            fontSize: 14, maxWidth: 520, fontFamily: sans, lineHeight: 1.5 }}>
            Confirm on your device to sign this change. It isn't saved until you do.
          </div>
        </div>
      )}
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
