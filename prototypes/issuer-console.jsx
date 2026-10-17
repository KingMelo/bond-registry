import React, { useState } from "react";

/* ================================================================
   Bond Interest Registry — issuer console
   ISSUER actions are multisig; the approvals queue is where signing
   happens. RELAYER handles holder-initiated transitions elsewhere.
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

const pct = (u, total) => ((u / total) * 100).toFixed(6) + "%";
const num = (u) => u.toLocaleString("en-US");
const usd = (u) => "$" + u.toLocaleString("en-US");

const CONTRACT = "0x7A3f9C21D4e8B07a55F3cb1290Ae44D6b8E1B214";
const THRESHOLD = "2 of 3";

const TERMINAL = ["Cancelled", "Superseded", "Redeemed"];
// Children created by assignOut that are neither Accepted nor Cancelled.
const PENDING = ["AwaitingCredential", "CredentialRequested", "Issued"];

const fakeHash = () =>
  "0x" + Math.random().toString(16).slice(2, 8) + "…" + Math.random().toString(16).slice(2, 6);

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
  if (s === "Issued" || s === "AwaitingCredential" || s === "CredentialRequested") return [T.amber, "#F2EAD3"];
  if (s === "Locked" || s === "PendingRedemption") return [T.red, "#F0E0DF"];
  return [T.inkSoft, T.wash];
};

/* ---------------- seed ---------------- */

const BONDS = [
  { id: "KPII-0001-BD", face: 100000000, total: 100000000, unassigned: 99765000, redeemed: 0, prior: [],
    registered: "Mar 4, 2026", instrumentHash: "0xa41b7c…88e2", declarationHash: "0xd90f23…1c55" },
  { id: "KPII-0002-BD", face: 100000000, total: 100000000, unassigned: 99950000, redeemed: 0, prior: [],
    registered: "May 19, 2026", instrumentHash: "0xb72e04…3af1", declarationHash: "0x6c1a89…7d20" },
  { id: "KPII-0003-BD", face: 100000000, total: 100000000, unassigned: 100000000, redeemed: 0, prior: [],
    registered: "Sep 1, 2026", instrumentHash: "0x0e55ab…9140", declarationHash: "0x33d71f…b602" },
];

const SEED = [
  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00001", parent: null, origin: "Issuer", assignor: "Issuer of record",
    party: "Company A", contact: "D. Hargrove", position: "Authorized Representative",
    address: "Company A\nAttn: D. Hargrove\n501 Mercer Street\nColumbus, OH 43215",
    units: 170000, issuedUnits: 200000, status: "Accepted", created: "Mar 6, 2026", accepted: "Mar 11, 2026",
    docHash: "0x83a4c7…2d17", filingRef: "0x5f21ab…9c40", deliveryRef: "0x1b77de…04a2",
    instrumentMail: "RE 123 456 789 US", passkeyMail: "RE 123 456 790 US", credLocked: false },

  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00002", parent: null, origin: "Issuer", assignor: "Issuer of record",
    party: "Company B", contact: "L. Whitfield", position: "Managing Member",
    address: "Company B\nAttn: L. Whitfield\n22 Canal Road\nProvidence, RI 02903",
    units: 30000, issuedUnits: 30000, status: "Accepted", created: "Jun 18, 2026", accepted: "Jun 22, 2026",
    docHash: "0xc1f802…9b40", filingRef: "0x77a3e1…5512", deliveryRef: "0x9e44bc…7731",
    instrumentMail: "9407 1000 0000 0000 0000 02", passkeyMail: "9407 1000 0000 0000 0000 09", credLocked: false },

  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00003", parent: "KPII-0001-BD-A00001", origin: "AssignOut", assignor: "Company A",
    party: "Company D", contact: "M. Osei", position: "Treasurer",
    address: "Company D\nAttn: M. Osei\n88 Front Avenue\nAustin, TX 78701",
    units: 30000, issuedUnits: 30000, status: "CredentialRequested", created: "Sep 14, 2026", accepted: null,
    docHash: "0x4a8813…0fd2", filingRef: null, deliveryRef: null,
    instrumentMail: null, passkeyMail: null, credLocked: false,
    requestedParty: "Company D", requestedBy: "M. Osei, Treasurer", requestedContact: "+1 512 555 0148", requestedOn: "Oct 9, 2026" },

  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00004", parent: null, origin: "Issuer", assignor: "Issuer of record",
    party: "Company C", contact: "R. Alvarez", position: "Chief Financial Officer",
    address: "Company C\nAttn: R. Alvarez\n1400 Harbor Street\nWilmington, DE 19801",
    units: 5000, issuedUnits: 5000, status: "Issued", created: "Oct 2, 2026", accepted: null,
    docHash: "0x62de91…c7b8", filingRef: "0x30ba77…e1d9", deliveryRef: "0x8c02fa…66b4",
    instrumentMail: "9407 1000 0000 0000 0000 18", passkeyMail: "9407 1000 0000 0000 0000 25", credLocked: false },

  { bond: "KPII-0002-BD", id: "KPII-0002-BD-A00001", parent: null, origin: "Issuer", assignor: "Issuer of record",
    party: "Company E", contact: "P. Nakamura", position: "Director of Finance",
    address: "Company E\nAttn: P. Nakamura\n9 Bridgeway\nSavannah, GA 31401",
    units: 50000, issuedUnits: 50000, status: "Locked", created: "May 22, 2026", accepted: "May 26, 2026",
    docHash: "0x7f3d20…aa18", filingRef: "0x118cc4…6e37", deliveryRef: "0x44b9f0…2d81",
    instrumentMail: "9407 1000 0000 0000 0000 07", passkeyMail: "9407 1000 0000 0000 0000 11", credLocked: false,
    lockKind: "compromise", lockReason: "Passkey may be compromised", lockedOn: "Oct 11, 2026", rotationRequested: true },
];

const SEED_EVENTS = [
  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00003", t: "Oct 9, 2026 16:12", ev: "CredentialRequested", actor: "RELAYER", ref: "—" },
  { bond: "KPII-0002-BD", id: "KPII-0002-BD-A00001", t: "Oct 11, 2026 08:47", ev: "Locked", actor: "RELAYER", ref: "—" },
  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00004", t: "Oct 2, 2026 10:05", ev: "DeliveryRecorded", actor: "ISSUER", ref: "0x8c02fa…66b4" },
  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00004", t: "Oct 2, 2026 09:41", ev: "AssignmentIssued", actor: "ISSUER", ref: "0x62de91…c7b8" },
  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00003", t: "Sep 14, 2026 14:22", ev: "AssignedOut", actor: "RELAYER", ref: "0x4a8813…0fd2" },
  { bond: "KPII-0001-BD", id: "—", t: "Mar 4, 2026 07:54", ev: "BondAnchored", actor: "ISSUER", ref: "0xa41b7c…88e2" },
];

/* ---------------- pieces ---------------- */

function Label({ children }) {
  return <div className="mb-1" style={{ fontSize: 12, color: T.inkSoft, fontFamily: sans }}>{children}</div>;
}

function Chip({ s, text }) {
  const [fg, bg] = tone(s);
  return (
    <span className="inline-block px-2 py-0.5"
      style={{ fontSize: 12, color: fg, background: bg, fontFamily: sans, borderRadius: 2, whiteSpace: "nowrap" }}>
      {text || LABEL[s] || s}
    </span>
  );
}

function Button({ children, onClick, variant = "solid", disabled, danger }) {
  const skin = variant === "solid"
    ? { background: danger ? T.red : T.ink, color: T.paper, border: "1px solid " + (danger ? T.red : T.ink) }
    : { background: "transparent", color: danger ? T.red : T.ink, border: "1px solid " + (danger ? T.red : T.rule) };
  return (
    <button onClick={disabled ? undefined : onClick}
      style={{ fontFamily: sans, fontWeight: 500, fontSize: 14, borderRadius: 2, padding: "10px 16px",
        width: "100%", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, ...skin }}>
      {children}
    </button>
  );
}

function Field({ label, value, onChange, placeholder, mono, hint }) {
  return (
    <div className="mb-4">
      <Label>{label}</Label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        style={{ width: "100%", fontFamily: sans, fontSize: 16,
          fontVariantNumeric: mono ? "tabular-nums" : "normal", color: T.ink, background: T.white,
          border: "1px solid " + T.rule, borderRadius: 2, padding: "10px 12px", outline: "none" }} />
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
  const skin = kind === "warn" ? { background: "#F7E9E8", borderLeft: "3px solid " + T.red }
    : kind === "caution" ? { background: "#F2EAD3", borderLeft: "3px solid " + T.amber }
    : { background: T.wash };
  return <div className="px-3 py-3" style={{ ...skin, borderRadius: 2, fontSize: 13, color: T.ink, lineHeight: 1.6 }}>{children}</div>;
}

function Sheet({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 flex items-end justify-center"
      style={{ background: "rgba(26,34,51,0.35)", zIndex: 50 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full"
        style={{ maxWidth: 560, background: T.paper, borderTop: "2px solid " + T.ink,
          maxHeight: "88%", overflowY: "auto", padding: "20px 18px 28px" }}>
        <div className="flex justify-between items-start mb-4 gap-4">
          <div style={{ fontFamily: serif, fontSize: 20, color: T.ink, lineHeight: 1.25, wordBreak: "break-all" }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.inkSoft,
            fontSize: 14, cursor: "pointer", fontFamily: sans, flexShrink: 0 }}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------------- console ---------------- */

export default function IssuerConsole() {
  const [reg, setReg] = useState(SEED);
  const [events, setEvents] = useState(SEED_EVENTS);
  const [bonds, setBonds] = useState(BONDS);
  const [activeBond, setActiveBond] = useState("KPII-0001-BD");
  const [tab, setTab] = useState("queue");
  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState("");

  const [mail, setMail] = useState("");
  const [reason, setReason] = useState("");
  const [recHash, setRecHash] = useState("");
  const [filing, setFiling] = useState("");
  const [filedBy, setFiledBy] = useState("assignor");
  const [docRef, setDocRef] = useState("");
  const [iMail, setIMail] = useState("");
  const [pMail, setPMail] = useState("");
  const [rpParty, setRpParty] = useState("");
  const [rpContact, setRpContact] = useState("");
  const [rpAddress, setRpAddress] = useState("");
  const [rpDoc, setRpDoc] = useState("");

  const [nUnits, setNUnits] = useState("");
  const [nParty, setNParty] = useState("");
  const [nContact, setNContact] = useState("");
  const [nPosition, setNPosition] = useState("");
  const [nAddress, setNAddress] = useState("");
  const [nErr, setNErr] = useState("");

  const [pRef, setPRef] = useState("");
  const [pUnits, setPUnits] = useState("");
  const [pErr, setPErr] = useState("");

  const bond = bonds.find((b) => b.id === activeBond);
  const scoped = reg.filter((a) => a.bond === activeBond);
  const scopedEvents = events.filter((e) => e.bond === activeBond);

  const pendingOf = (id) =>
    reg.filter((c) => c.parent === id && c.origin === "AssignOut" && PENDING.includes(c.status));

  // Children deliver their own instrument through the assignor; everything else
  // needs both mailings recorded once it is issued.
  const mailingMissing = (a) =>
    !TERMINAL.includes(a.status) && !["AwaitingCredential", "CredentialRequested"].includes(a.status) &&
    (!a.passkeyMail || (a.origin !== "AssignOut" && !a.instrumentMail));

  const queueItems = (a) => {
    const out = [];
    if (a.credLocked) out.push(["Credential lockout", "Holder failed 5 passkey attempts. Verify identity before clearing."]);
    if (a.status === "CredentialRequested") out.push(a.filingRef
      ? ["Credential request", "Verify the requester is the named assignee, then mail the passkey."]
      : ["Credential request · UCC-3 pending", "Waiting on the assignor's UCC-3. Verify the requester meanwhile; after 30 days you may file it yourself."]);
    if (a.status === "PendingRedemption") out.push(["Redemption", "Review the register, chain record and paperwork before approving."]);
    if (a.status === "Locked" && a.rotationRequested) out.push(["Passkey rotation", "Holder locked the record and asked for a new passkey."]);
    if (a.status === "Locked" && a.unlockRequested) out.push(a.lockKind === "pledge"
      ? ["Unlock request · pledge", "Needs the pledgee's signed release before you unlock."]
      : ["Unlock request", "Verify the holder's identity before you unlock."]);
    if (mailingMissing(a)) out.push(["Mailing not recorded", "Record the certified mail numbers for the instrument and passkey."]);
    return out;
  };

  const queue = reg.flatMap((a) => queueItems(a).map(([kind, why]) => ({ a, kind, why })));

  const liveUnits = (bid) =>
    reg.filter((a) => a.bond === bid && !TERMINAL.includes(a.status))
      .reduce((s, a) => s + a.units, 0);

  // Units carried by instruments issued before the registry (reversed entries excluded).
  const priorUnits = (b) => b.prior.filter((p) => !p.reversed).reduce((t, p) => t + p.units, 0);

  // Units invariant: prior + live + unassigned + redeemed = total.
  const reconciled = (bid) => {
    const b = bonds.find((x) => x.id === bid);
    return priorUnits(b) + liveUnits(bid) + b.unassigned + b.redeemed === b.total;
  };

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2800); };
  const emit = (bid, id, ev, actor, ref) =>
    setEvents((e) => [{ bond: bid, id, t: "Oct 17, 2026 · now", ev, actor, ref: ref || "—" }, ...e]);

  const patch = (id, fields) => setReg((r) => r.map((a) => (a.id === id ? { ...a, ...fields } : a)));

  const clearForms = () => {
    setMail(""); setReason(""); setRecHash(""); setFiling(""); setFiledBy("assignor"); setDocRef("");
    setIMail(""); setPMail(""); setRpParty(""); setRpContact(""); setRpAddress(""); setRpDoc("");
  };
  const done = (m) => { clearForms(); setSheet(null); flash(m); };

  /* --- issuer actions (multisig) ---
     No paper, no record: every action below carries the hash of the document
     that authorizes it. Mail numbers never go on-chain in plain text. */

  function issueCredential(a) {
    if (!mail.trim() || !a.filingRef) return;
    const deliveryRef = fakeHash();
    patch(a.id, { status: "Issued", passkeyMail: mail.trim(), deliveryRef });
    emit(a.bond, a.id, "CredentialIssued", "ISSUER", deliveryRef);
    emit(a.bond, a.id, "DeliveryRecorded", "ISSUER", deliveryRef);
    done("Credential issued and mailing recorded. Multisig " + THRESHOLD + " signed.");
  }

  function rejectCredentialRequest(a) {
    if (!reason.trim()) return;
    patch(a.id, { status: "AwaitingCredential", requestedParty: null, requestedBy: null,
      requestedContact: null, requestedOn: null });
    emit(a.bond, a.id, "CredentialRequestRejected", "ISSUER", fakeHash());
    done("Request rejected. The assignment is back to awaiting a credential.");
  }

  // Issuer-side cancellation of a disputed or timed-out child.
  function cancelChild(a) {
    const parent = reg.find((x) => x.id === a.parent);
    if (!reason.trim() || !parent || parent.status === "PendingRedemption") return;
    setReg((r) => r.map((x) => {
      if (x.id === a.id) return { ...x, status: "Cancelled" };
      if (x.id === parent.id) return { ...x, units: x.units + a.units };
      return x;
    }));
    emit(a.bond, a.id, "AssignOutCancelled", "ISSUER", fakeHash());
    done("Cancelled. " + usd(a.units) + " returned to " + parent.id + ".");
  }

  function unlock(a) {
    if (!docRef.trim()) return;
    patch(a.id, { status: "Accepted", lockKind: null, lockReason: null, lockedOn: null,
      rotationRequested: false, unlockRequested: false });
    emit(a.bond, a.id, "Unlocked", "ISSUER", docRef.trim());
    done("Unlocked. Returned to Accepted.");
  }

  function rotate(a) {
    if (!mail.trim() || !docRef.trim()) return;
    patch(a.id, { passkeyMail: mail.trim(), rotationRequested: false, credLocked: false });
    emit(a.bond, a.id, "PasskeyRotated", "ISSUER", docRef.trim());
    done("New passkey mailed. The old hash has been discarded. The record stays locked until you unlock it.");
  }

  // The credential is off-chain; clearing a lockout is a register and audit entry only.
  function unlockCredential(a) {
    patch(a.id, { credLocked: false });
    done("Credential lockout cleared and logged in the register.");
  }

  function approveRedemption(a) {
    if (!recHash.trim()) return;
    patch(a.id, { status: "Redeemed" });
    // Retired for good: redeemed units never return to the issuable pool.
    setBonds((bs) => bs.map((b) => (b.id === a.bond ? { ...b, redeemed: b.redeemed + a.units } : b)));
    emit(a.bond, a.id, "Redeemed", "ISSUER", recHash.trim());
    done("Redeemed. These units are retired and this record can never be acted on again.");
  }

  function rejectRedemption(a) {
    if (!reason.trim()) return;
    patch(a.id, { status: "Accepted" });
    emit(a.bond, a.id, "RedemptionRejected", "ISSUER", fakeHash());
    done("Rejected. Returned to Accepted.");
  }

  function setFilingRef(a) {
    if (!filing.trim()) return;
    const filingRef = fakeHash();
    patch(a.id, { filingRef, filingNumber: filing.trim(), filedBy });
    emit(a.bond, a.id, "FilingRecorded", "ISSUER", filingRef);
    done("UCC-3 filing reference recorded.");
  }

  function recordMailing(a) {
    const needInstrument = a.origin !== "AssignOut" && !a.instrumentMail;
    const needPasskey = !a.passkeyMail;
    if ((needInstrument && !iMail.trim()) || (needPasskey && !pMail.trim())) return;
    const deliveryRef = fakeHash();
    patch(a.id, {
      instrumentMail: needInstrument ? iMail.trim() : a.instrumentMail,
      passkeyMail: needPasskey ? pMail.trim() : a.passkeyMail,
      deliveryRef,
    });
    emit(a.bond, a.id, "DeliveryRecorded", "ISSUER", deliveryRef);
    done("Mailings recorded. Only their hash goes on-chain.");
  }

  function replaceAssignment(a) {
    if (!["Accepted", "Issued"].includes(a.status) || pendingOf(a.id).length > 0) return;
    if (!rpParty.trim() || !rpContact.trim() || !rpAddress.trim() || !rpDoc.trim()) return;
    const seq = String(reg.filter((x) => x.bond === a.bond).length + 1).padStart(5, "0");
    const rec = {
      bond: a.bond, id: a.bond + "-A" + seq, parent: a.id, origin: "Replacement",
      assignor: "Issuer of record (replacement)",
      party: rpParty.trim(), contact: rpContact.trim(), position: "", address: rpAddress.trim(),
      units: a.units, issuedUnits: a.units, status: "Issued", created: "Oct 17, 2026", accepted: null,
      docHash: fakeHash(), filingRef: null, deliveryRef: null,
      instrumentMail: null, passkeyMail: null, credLocked: false,
    };
    setReg((r) => [rec, ...r.map((x) => (x.id === a.id ? { ...x, status: "Superseded" } : x))]);
    emit(a.bond, a.id, "AssignmentReplaced", "ISSUER", rpDoc.trim());
    emit(a.bond, rec.id, "AssignmentIssued", "ISSUER", rec.docHash);
    done(a.id + " replaced by " + rec.id + ". Mail the new instrument and passkey, then file the UCC-3.");
  }

  /* --- prior instruments ---
     Promissory notes and other instruments issued before the registry. Each is
     an identifier and an amount taken off the bond: no holder, no workflow. */

  function recordPrior() {
    const ref = pRef.trim();
    const u = parseInt(pUnits.replace(/[^0-9]/g, ""), 10);
    if (!ref) return setPErr("Enter the instrument's identifier.");
    if (bond.prior.some((p) => !p.reversed && p.ref.toUpperCase() === ref.toUpperCase()))
      return setPErr(ref + " is already recorded against " + activeBond + ".");
    if (!u || u <= 0) return setPErr("Enter a whole number of units.");
    if (u > bond.unassigned) return setPErr("Unassigned balance is " + num(bond.unassigned) + " units.");
    setPErr("");
    const entry = { id: "P" + String(bond.prior.length + 1).padStart(3, "0"), ref, units: u,
      recordedOn: "Oct 17, 2026", reversed: false };
    setBonds((bs) => bs.map((b) => (b.id === activeBond
      ? { ...b, unassigned: b.unassigned - u, prior: [...b.prior, entry] } : b)));
    emit(activeBond, ref, "PriorInstrumentRecorded", "ISSUER", fakeHash());
    setPRef(""); setPUnits("");
    flash(ref + " recorded. " + usd(u) + " taken off " + activeBond + ".");
  }

  // Append-only: a reversal is a new entry; the original line stays, marked reversed.
  function reversePrior(bid, entry) {
    if (!reason.trim()) return;
    setBonds((bs) => bs.map((b) => (b.id === bid
      ? { ...b, unassigned: b.unassigned + entry.units,
          prior: b.prior.map((p) => (p.id === entry.id ? { ...p, reversed: true, reversedReason: reason.trim() } : p)) }
      : b)));
    emit(bid, entry.ref, "PriorInstrumentReversed", "ISSUER", fakeHash());
    done(entry.ref + " reversed. " + usd(entry.units) + " returned to unassigned.");
  }

  function issueAssignment() {
    const u = parseInt(nUnits.replace(/[^0-9]/g, ""), 10);
    if (!u || u <= 0) return setNErr("Enter a whole number of units.");
    if (u > bond.unassigned) return setNErr("Unassigned balance is " + num(bond.unassigned) + " units.");
    if (!nParty.trim()) return setNErr("Enter the holder's legal name.");
    if (!nContact.trim()) return setNErr("Name the person the instrument is addressed to.");
    if (!nAddress.trim()) return setNErr("Add a mailing address — both documents go by certified post.");
    setNErr("");
    const seq = String(scoped.length + 1).padStart(5, "0");
    const rec = {
      bond: activeBond, id: activeBond + "-A" + seq, parent: null, origin: "Issuer", assignor: "Issuer of record",
      party: nParty.trim(), contact: nContact.trim(), position: nPosition.trim(), address: nAddress.trim(),
      units: u, issuedUnits: u, status: "Issued", created: "Oct 17, 2026", accepted: null,
      docHash: fakeHash(),
      filingRef: null, deliveryRef: null, instrumentMail: null, passkeyMail: null, credLocked: false,
    };
    setReg((r) => [rec, ...r]);
    setBonds((bs) => bs.map((b) => (b.id === activeBond ? { ...b, unassigned: b.unassigned - u } : b)));
    emit(activeBond, rec.id, "AssignmentIssued", "ISSUER", rec.docHash);
    setNUnits(""); setNParty(""); setNContact(""); setNPosition(""); setNAddress("");
    setTab("records");
    flash(rec.id + " issued. Mail both documents separately, then record the numbers.");
  }

  function reset() {
    setReg(SEED); setEvents(SEED_EVENTS); setBonds(BONDS); setActiveBond("KPII-0001-BD");
    setTab("queue"); setSheet(null); clearForms(); setPRef(""); setPUnits(""); setPErr("");
  }

  const tabs = [["queue", "Approvals"], ["bonds", "Bonds"], ["records", "Records"], ["log", "Log"]];

  return (
    <div style={{ background: T.paper, minHeight: "100%", fontFamily: sans }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Spectral:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid ${T.ink}; outline-offset: 1px; }
        input:focus, textarea:focus { border-color: ${T.ink} !important; }`}</style>

      <div className="mx-auto" style={{ maxWidth: 560, padding: "20px 18px 56px" }}>
        <div className="flex items-baseline justify-between">
          <div style={{ fontFamily: serif, fontSize: 21, color: T.ink, fontWeight: 500 }}>Registrar</div>
          <div className="text-right">
            <button onClick={() => setSheet({ k: "switch" })}
              style={{ fontFamily: sans, fontSize: 12, background: "none", border: "none", padding: 0,
                cursor: "pointer", textAlign: "right", color: T.inkSoft, fontVariantNumeric: "tabular-nums" }}>
              <span style={{ color: T.ink }}>{activeBond}</span>
              <span style={{ display: "block", marginTop: 2 }}>ISSUER · multisig {THRESHOLD}</span>
            </button>
            <button onClick={reset} style={{ fontFamily: sans, fontSize: 11, color: T.inkSoft, background: "none",
              border: "none", padding: "2px 0 0", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>
              Reset demo
            </button>
          </div>
        </div>

        <div className="flex gap-4 mt-4 mb-5" style={{ borderBottom: "1px solid " + T.rule }}>
          {tabs.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{ fontFamily: sans, fontSize: 14, color: tab === k ? T.ink : T.inkSoft, padding: "0 0 8px",
                borderBottom: "2px solid " + (tab === k ? T.ink : "transparent"), background: "none", cursor: "pointer" }}>
              {l}
              {k === "queue" && queue.length > 0 && <span style={{ color: T.red }}> · {queue.length}</span>}
            </button>
          ))}
        </div>

        {/* ============ approvals queue ============ */}
        {tab === "queue" && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 25, color: T.ink, lineHeight: 1.25 }}>Awaiting your signature</h1>
            <p style={{ color: T.inkSoft, fontSize: 14, lineHeight: 1.6, margin: "8px 0 18px", maxWidth: "62ch" }}>
              Across every bond. Nothing here moves without {THRESHOLD} multisig — the relayer
              cannot activate a holder, unlock a record, or end an interest.
            </p>

            {queue.length === 0 && (
              <div className="px-3 py-5 text-center" style={{ border: "1px solid " + T.rule, borderRadius: 2,
                fontSize: 14, color: T.inkSoft }}>
                Nothing waiting.
              </div>
            )}

            {queue.map(({ a, kind, why }) => {
              return (
                <button key={a.id + kind} onClick={() => setSheet({ k: "item", a })}
                  className="w-full text-left px-3 py-3 mb-2"
                  style={{ background: T.white, border: "1px solid " + T.red, borderRadius: 2, cursor: "pointer" }}>
                  <div className="flex justify-between items-baseline gap-3">
                    <span style={{ fontSize: 14, color: T.ink, fontWeight: 500 }}>{kind}</span>
                    <span style={{ fontSize: 14, color: T.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                      {usd(a.units)}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 4, lineHeight: 1.5 }}>{why}</div>
                  <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
                    {a.id} · {a.party}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* ============ bonds ============ */}
        {tab === "bonds" && (
          <div>
            <Label>Anchored bonds</Label>
            <div style={{ fontFamily: serif, fontSize: 34, color: T.ink, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>
              {usd(bonds.reduce((t, b) => t + b.face, 0))}
            </div>
            <div style={{ color: T.inkSoft, fontSize: 14, marginTop: 4 }}>
              {bonds.length} bonds · {usd(bonds.reduce((t, b) => t + liveUnits(b.id), 0))} assigned out
            </div>

            <div className="mt-5">
              {bonds.map((b) => {
                const ok = reconciled(b.id);
                const items = reg.filter((a) => a.bond === b.id);
                return (
                  <button key={b.id} onClick={() => { setActiveBond(b.id); setTab("records"); }}
                    className="w-full text-left px-3 py-3 mb-2"
                    style={{ background: b.id === activeBond ? T.band : T.white,
                      border: "1px solid " + (!ok ? T.red : b.id === activeBond ? T.ink : T.rule),
                      borderRadius: 2, cursor: "pointer" }}>
                    <div className="flex justify-between items-baseline gap-3">
                      <span style={{ fontSize: 15, color: T.ink, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{b.id}</span>
                      <span style={{ fontSize: 14, color: T.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {usd(b.unassigned)}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                      unassigned · {priorUnits(b) > 0 ? usd(priorUnits(b)) + " prior instruments · " : ""}{b.redeemed > 0 ? usd(b.redeemed) + " retired · " : ""}{items.length} {items.length === 1 ? "record" : "records"} · anchored {b.registered}
                    </div>
                    <div className="mt-2">
                      <Chip s={ok ? "Accepted" : "Locked"} text={ok ? "Reconciled" : "Mismatch — activity frozen"} />
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-4">
              <Button onClick={() => setTab("issue")}>Issue an assignment from {activeBond}</Button>
            </div>

            <div className="mt-4">
              <Note>
                The daily job rebuilds state from contract events and compares units and status
                per record, plus the rule live + unassigned + redeemed = total per bond, and
                checks every on-chain document hash against a document in the register. A mismatch alerts and freezes
                the affected records rather than correcting them silently.
              </Note>
            </div>
          </div>
        )}

        {/* ============ issue ============ */}
        {tab === "issue" && (
          <div>
            <h1 style={{ fontFamily: serif, fontSize: 25, color: T.ink }}>Issue an assignment</h1>
            <p style={{ color: T.inkSoft, fontSize: 14, lineHeight: 1.6, margin: "8px 0 18px", maxWidth: "62ch" }}>
              From {activeBond}. Unassigned balance {usd(bond.unassigned)}.
            </p>

            <Field label="Units" value={nUnits} onChange={setNUnits} placeholder="30,000" mono
              hint={nUnits ? usd(parseInt(nUnits.replace(/[^0-9]/g, ""), 10) || 0) + " · " +
                pct(parseInt(nUnits.replace(/[^0-9]/g, ""), 10) || 0, bond.total) + " of the bond" : null} />

            <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, margin: "16px 0 12px" }}>Holder</div>
            <Field label="Legal name" value={nParty} onChange={setNParty} placeholder="Company F, LLC" />
            <Field label="Attention of" value={nContact} onChange={setNContact} placeholder="Full name" />
            <Field label="Position" value={nPosition} onChange={setNPosition} placeholder="Managing Member" />
            <Area label="Mailing address" value={nAddress} onChange={setNAddress}
              placeholder={"Company F, LLC\nAttn: name, position\nStreet\nCity, State ZIP"} />

            {nErr && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, marginBottom: 14 }}>{nErr}</p>}

            <Button onClick={issueAssignment}>Issue — multisig {THRESHOLD}</Button>
            <div className="mt-3">
              <Button variant="quiet" onClick={() => setTab("bonds")}>Cancel</Button>
            </div>

            <div className="mt-4">
              <Note kind="caution">
                After issuing: mail the instrument by certified post, then the passkey document
                in a separate mailing on a different day. Record both numbers, then file the
                UCC-3 and record its reference.
              </Note>
            </div>
          </div>
        )}

        {/* ============ records ============ */}
        {tab === "records" && (
          <div>
            <div className="flex justify-between items-baseline mb-1">
              <div style={{ fontFamily: serif, fontSize: 21, color: T.ink }}>{activeBond}</div>
              <button onClick={() => setTab("issue")} style={{ fontSize: 14, color: T.ink, background: "none",
                border: "none", cursor: "pointer", fontFamily: sans, textDecoration: "underline", textUnderlineOffset: 2 }}>
                Issue
              </button>
            </div>
            <div className="mt-3 mb-5">
              <Rows data={[
                ["Bond total", usd(bond.total)],
                ["Prior instruments", usd(priorUnits(bond))],
                ["Assigned in live records", usd(liveUnits(activeBond))],
                ["Redeemed and retired", usd(bond.redeemed)],
                ["Unassigned", usd(bond.unassigned)],
                ["Check", reconciled(activeBond) ? "Reconciled — the lines add up to the total" : "Mismatch — activity frozen"],
              ]} />
            </div>

            <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 4 }}>Prior instruments</div>
            <p style={{ color: T.inkSoft, fontSize: 13, lineHeight: 1.6, marginBottom: 10, maxWidth: "62ch" }}>
              Promissory notes and other instruments issued before this registry. Each one only takes
              its amount off the bond — no holder, passkey or approvals.
            </p>
            {bond.prior.length > 0 && (
              <div className="mb-3" style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
                {bond.prior.map((p, i) => (
                  <div key={p.id} className="flex justify-between items-center gap-3 px-3 py-2"
                    style={{ background: i % 2 ? T.band : T.white, borderTop: i ? "1px solid " + T.rule : "none", fontSize: 14 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: p.reversed ? T.inkSoft : T.ink, textDecoration: p.reversed ? "line-through" : "none",
                        wordBreak: "break-word" }}>{p.ref}</div>
                      <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 2 }}>
                        Recorded {p.recordedOn}{p.reversed ? " · reversed: " + p.reversedReason : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-3" style={{ flexShrink: 0 }}>
                      <span style={{ color: p.reversed ? T.inkSoft : T.ink, fontVariantNumeric: "tabular-nums",
                        textDecoration: p.reversed ? "line-through" : "none" }}>{usd(p.units)}</span>
                      {p.reversed ? <Chip s="Cancelled" text="Reversed" /> : (
                        <button onClick={() => setSheet({ k: "prior", bond: activeBond, entry: p })}
                          style={{ fontSize: 12, color: T.inkSoft, background: "none", border: "none", cursor: "pointer",
                            textDecoration: "underline", textUnderlineOffset: 2, fontFamily: sans }}>
                          Reverse
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="px-3 pt-3 pb-1 mb-6" style={{ border: "1px solid " + T.rule, borderRadius: 2, background: T.white }}>
              <Field label="Instrument identifier" value={pRef} onChange={(v) => { setPRef(v); setPErr(""); }}
                placeholder="PN-2024-007" />
              <Field label="Amount taken off the bond (units)" value={pUnits} onChange={(v) => { setPUnits(v); setPErr(""); }}
                placeholder="250,000" mono
                hint={pUnits ? usd(parseInt(pUnits.replace(/[^0-9]/g, ""), 10) || 0) + " · " +
                  pct(parseInt(pUnits.replace(/[^0-9]/g, ""), 10) || 0, bond.total) + " of the bond" : null} />
              {pErr && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, marginBottom: 12 }}>{pErr}</p>}
              <div className="mb-3">
                <Button variant="quiet" onClick={recordPrior}>Record prior instrument</Button>
              </div>
            </div>

            <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 10 }}>Assignments</div>

            {scoped.length === 0 && (
              <div className="px-3 py-5 text-center" style={{ border: "1px solid " + T.rule, borderRadius: 2,
                fontSize: 14, color: T.inkSoft }}>
                No assignments issued from this bond yet.
              </div>
            )}

            {scoped.map((a) => (
              <button key={a.id} onClick={() => setSheet({ k: "item", a })}
                className="w-full text-left px-3 py-3 mb-2"
                style={{ background: T.white, border: "1px solid " + T.rule, borderRadius: 2, cursor: "pointer" }}>
                <div className="flex justify-between items-baseline gap-3">
                  <span style={{ fontSize: 14, color: T.ink }}>{a.party}</span>
                  <span style={{ fontSize: 14, color: T.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                    {usd(a.units)}
                  </span>
                </div>
                <div className="flex justify-between items-center gap-3 mt-2">
                  <span style={{ fontSize: 12, color: T.inkSoft, fontVariantNumeric: "tabular-nums" }}>
                    {a.id.replace(activeBond + "-", "")} · {a.origin === "Replacement" ? "replaces " + a.parent.replace(activeBond + "-", "")
                      : a.parent ? "from " + a.assignor : "issuer-originated"}
                  </span>
                  <Chip s={a.status} />
                </div>
              </button>
            ))}
          </div>
        )}

        {/* ============ log ============ */}
        {tab === "log" && (
          <div>
            <div style={{ fontFamily: serif, fontSize: 21, color: T.ink, marginBottom: 4 }}>On-chain event log</div>
            <p style={{ color: T.inkSoft, fontSize: 14, lineHeight: 1.6, marginBottom: 16, maxWidth: "62ch" }}>
              {activeBond}. Every action writes an app audit entry, a register entry and an
              on-chain event, linked by assignment ID. Append only.
            </p>
            <div style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
              {scopedEvents.map((e, i) => (
                <div key={i} className="px-3 py-3"
                  style={{ background: i % 2 ? T.band : T.white, borderTop: i ? "1px solid " + T.rule : "none" }}>
                  <div className="flex justify-between gap-3">
                    <span style={{ fontSize: 14, color: T.ink }}>{e.ev}</span>
                    <Chip s={e.actor === "ISSUER" ? "Accepted" : "Issued"} text={e.actor} />
                  </div>
                  <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 4, fontVariantNumeric: "tabular-nums", wordBreak: "break-all" }}>
                    {e.id} · {e.t}
                  </div>
                  <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 2, wordBreak: "break-all" }}>{e.ref}</div>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <Rows data={[["Contract", CONTRACT], ["Role", "ISSUER via Safe " + THRESHOLD]]} />
            </div>
          </div>
        )}
      </div>

      {/* ============ switch bond ============ */}
      {sheet?.k === "prior" && (
        <Sheet title={"Reverse " + sheet.entry.ref} onClose={() => { setSheet(null); clearForms(); }}>
          <Rows data={[
            ["Bond", sheet.bond],
            ["Instrument", sheet.entry.ref],
            ["Amount", usd(sheet.entry.units)],
            ["Recorded", sheet.entry.recordedOn],
          ]} />
          <div className="mt-4">
            <Note kind="caution">
              For an entry made in error. The original line stays on the record, marked reversed,
              and {usd(sheet.entry.units)} returns to the unassigned balance.
            </Note>
          </div>
          <div className="mt-4">
            <Field label="Reason" value={reason} onChange={setReason} placeholder="Amount entered incorrectly" />
            <Button variant="quiet" danger disabled={!reason.trim()} onClick={() => reversePrior(sheet.bond, sheet.entry)}>
              Reverse entry
            </Button>
          </div>
        </Sheet>
      )}

      {sheet?.k === "switch" && (
        <Sheet title="Switch bond" onClose={() => setSheet(null)}>
          {bonds.map((b) => (
            <button key={b.id} onClick={() => { setActiveBond(b.id); setSheet(null); flash("Now showing " + b.id + "."); }}
              className="w-full text-left px-3 py-3 mb-2"
              style={{ background: b.id === activeBond ? T.band : T.white,
                border: "1px solid " + (b.id === activeBond ? T.ink : T.rule), borderRadius: 2, cursor: "pointer" }}>
              <div className="flex justify-between items-baseline gap-3">
                <span style={{ fontSize: 15, color: T.ink, fontVariantNumeric: "tabular-nums" }}>{b.id}</span>
                <span style={{ fontSize: 13, color: T.inkSoft, fontVariantNumeric: "tabular-nums" }}>
                  {usd(b.unassigned)} unassigned
                </span>
              </div>
            </button>
          ))}
        </Sheet>
      )}

      {/* ============ record sheet ============ */}
      {sheet?.k === "item" && (() => {
        const a = reg.find((x) => x.id === sheet.a.id) || sheet.a;
        const parent = a.parent ? reg.find((x) => x.id === a.parent) : null;
        const pending = pendingOf(a.id);
        const isChild = a.origin === "AssignOut";
        const needInstrument = a.origin !== "AssignOut" && !a.instrumentMail;
        const needPasskey = !a.passkeyMail;
        return (
          <Sheet title={a.id} onClose={() => { setSheet(null); clearForms(); }}>
            <div className="mb-4"><Chip s={a.status} /></div>

            <Rows data={[
              ["Holder", a.party],
              ["Attention of", a.contact],
              ["Position", a.position || "—"],
              ["Assignor", a.assignor],
              ["Parent", a.parent ? a.parent + (a.origin === "Replacement" ? " (replaced)" : "") : "Issuer-originated"],
              ["Units", num(a.units)],
              ["Value", usd(a.units)],
              a.issuedUnits !== a.units && ["Issued at", num(a.issuedUnits) + " units"],
              pending.length > 0 && ["Pending transfers", pending.length + " · " + usd(pending.reduce((t, c) => t + c.units, 0))],
              ["Created", a.created],
              ["Accepted", a.accepted || "—"],
              ["Document hash", a.docHash],
              ["UCC-3 filing ref", a.filingRef ? a.filingRef + (a.filedBy ? " · filed by " + a.filedBy : "") : "Not yet filed"],
              ["Delivery ref", a.deliveryRef || "—"],
              ["Instrument mail", a.instrumentMail || (isChild ? "Delivered by assignor" : "Not yet mailed")],
              ["Passkey mail", a.passkeyMail || "Not yet mailed"],
            ]} />

            {a.credLocked && (
              <div className="mt-4">
                <Note kind="warn">
                  Credential locked after 5 failed passkey attempts. Verify the holder's identity
                  before clearing it — a lockout can be a holder who mistyped, or someone guessing.
                  Clearing is recorded in the register only; the credential never touches the chain.
                </Note>
                <div className="mt-3">
                  <Button variant="quiet" danger onClick={() => unlockCredential(a)}>
                    Clear lockout — identity verified
                  </Button>
                </div>
              </div>
            )}

            {a.status === "CredentialRequested" && (
              <div className="mt-5">
                <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 8 }}>Credential request</div>
                <Rows data={[
                  ["Assignee named by requester", a.requestedParty || "—"],
                  ["Requested by", a.requestedBy || "—"],
                  ["Contact given", a.requestedContact || "—"],
                  ["Requested on", a.requestedOn || "—"],
                  ["Named assignee", a.party + " · " + a.contact],
                ]} />
                <div className="mt-3">
                  <Note kind="caution">
                    Check the requester against the named assignee — ID, contact match, and a call —
                    before issuing. {a.assignor} never sees this passkey, which is what keeps the
                    transferred portion out of their control.
                  </Note>
                </div>
                {!a.filingRef && (
                  <div className="mt-3">
                    <Note kind="warn">
                      The child's UCC-3 is not recorded yet. {a.assignor} files it; record the
                      acknowledgment below. If they haven't filed within 30 days of the request,
                      you may file it yourself. No credential is issued until it is recorded.
                    </Note>
                  </div>
                )}
                <div className="mt-4">
                  <Field label="Certified mail number for the passkey" value={mail} onChange={setMail}
                    placeholder="9407 1000 0000 0000 0000 00" mono />
                  <Button disabled={!mail.trim() || !a.filingRef} onClick={() => issueCredential(a)}>
                    Issue credential — multisig {THRESHOLD}
                  </Button>
                </div>
              </div>
            )}

            {isChild && ["AwaitingCredential", "CredentialRequested"].includes(a.status) && (
              <div className="mt-5">
                <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 8 }}>
                  {a.status === "CredentialRequested" ? "Reject or cancel" : "Cancel"}
                </div>
                <Field label="Reason" value={reason} onChange={setReason}
                  placeholder={a.status === "CredentialRequested" ? "Requester doesn't match the named assignee" : "Unclaimed after 30 days plus notice"}
                  hint="A hash of the signed reason memo goes on-chain with the event." />
                <div className="space-y-3">
                  {a.status === "CredentialRequested" && (
                    <Button variant="quiet" disabled={!reason.trim()} onClick={() => rejectCredentialRequest(a)}>
                      Reject request — back to awaiting credential
                    </Button>
                  )}
                  <Button variant="quiet" danger
                    disabled={!reason.trim() || !parent || parent.status === "PendingRedemption"}
                    onClick={() => cancelChild(a)}>
                    Cancel transfer — return {usd(a.units)} to {a.assignor} · multisig {THRESHOLD}
                  </Button>
                </div>
                <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 6, lineHeight: 1.5 }}>
                  {a.status === "CredentialRequested"
                    ? "The assignee has come forward, so only you can cancel. Hear both sides first."
                    : "For a dispute or a timeout. The assignor can also cancel this themselves until the assignee requests access."}
                  {" "}Cancelling never changes the parent's status.
                </div>
              </div>
            )}

            {a.status === "PendingRedemption" && (
              <div className="mt-5">
                <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 8 }}>Redemption</div>
                <Note kind="warn">
                  Approving is terminal. The contract will reject every future action on this
                  record, including a second redemption, and the {usd(a.units)} is retired for
                  good. Confirm payment has been made through the agreed channel first.
                </Note>
                <div className="mt-4">
                  <Field label="Hash of the redemption receipt or release" value={recHash} onChange={setRecHash}
                    placeholder="0x…" mono />
                  <Button danger disabled={!recHash.trim()} onClick={() => approveRedemption(a)}>
                    Approve redemption — multisig {THRESHOLD}
                  </Button>
                  <div className="mt-3">
                    <Field label="Reason, if rejecting" value={reason} onChange={setReason}
                      placeholder="Paperwork incomplete" hint="A hash of the reason memo goes on-chain." />
                    <Button variant="quiet" disabled={!reason.trim()} onClick={() => rejectRedemption(a)}>
                      Reject — return to Accepted
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {a.status === "Locked" && (
              <div className="mt-5">
                <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 8 }}>Locked record</div>
                <Rows data={[
                  ["Reason given", a.lockReason || "—"],
                  ["Locked on", a.lockedOn || "—"],
                  ["Unlock requested", a.unlockRequested ? "Yes" : "No"],
                  ["New passkey requested", a.rotationRequested ? "Yes" : "No"],
                ]} />
                <div className="mt-4">
                  <Field
                    label={a.lockKind === "pledge" ? "Hash of the pledgee's signed release" : "Hash of the identity verification memo"}
                    value={docRef} onChange={setDocRef} placeholder="0x…" mono
                    hint={a.lockKind === "pledge"
                      ? "Pledged record. Do not unlock without the lender's signed release."
                      : "Recorded on-chain with the Unlocked or PasskeyRotated event."} />
                </div>
                {a.rotationRequested && (
                  <div className="mt-2">
                    <Field label="Certified mail number for the new passkey" value={mail} onChange={setMail}
                      placeholder="9407 1000 0000 0000 0000 00" mono
                      hint="The old hash is discarded. The record stays locked until you unlock it." />
                    <Button disabled={!mail.trim() || !docRef.trim()} onClick={() => rotate(a)}>
                      Rotate passkey — multisig {THRESHOLD}
                    </Button>
                  </div>
                )}
                <div className="mt-3">
                  <Button variant="quiet" disabled={!docRef.trim()} onClick={() => unlock(a)}>
                    Unlock — multisig {THRESHOLD}
                  </Button>
                </div>
              </div>
            )}

            {mailingMissing(a) && (
              <div className="mt-5">
                <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 8 }}>Record mailings</div>
                {needInstrument && (
                  <Field label="Certified mail number for the instrument" value={iMail} onChange={setIMail}
                    placeholder="9407 1000 0000 0000 0000 00" mono />
                )}
                {needPasskey && (
                  <Field label="Certified mail number for the passkey" value={pMail} onChange={setPMail}
                    placeholder="9407 1000 0000 0000 0000 00" mono
                    hint="A separate mailing, on a different day. Only a hash of the numbers goes on-chain." />
                )}
                <Button variant="quiet" disabled={(needInstrument && !iMail.trim()) || (needPasskey && !pMail.trim())}
                  onClick={() => recordMailing(a)}>
                  Record mailings — multisig {THRESHOLD}
                </Button>
              </div>
            )}

            {!a.filingRef && !TERMINAL.includes(a.status) && (
              <div className="mt-5">
                <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 8 }}>UCC-3 filing</div>
                <Field label="Filing number and date" value={filing} onChange={setFiling}
                  placeholder="2026-1234567890 · Oct 17, 2026"
                  hint="Stored on-chain as a hash. The filing describes the collateral by bond, assignment ID, units, contract address, chain ID and document hash." />
                {isChild && (
                  <div className="mb-4">
                    <Label>Filed by</Label>
                    <div className="flex gap-4" style={{ fontSize: 14, color: T.ink }}>
                      {[["assignor", a.assignor + " (assignor)"], ["issuer", "Issuer — assignor missed 30 days"]].map(([k, l]) => (
                        <label key={k} className="flex items-center gap-2" style={{ cursor: "pointer" }}>
                          <input type="radio" name="filedBy" checked={filedBy === k} onChange={() => setFiledBy(k)} />
                          {l}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <Button variant="quiet" disabled={!filing.trim()} onClick={() => setFilingRef(a)}>
                  Record filing reference
                </Button>
              </div>
            )}

            {["Accepted", "Issued"].includes(a.status) && (
              <div className="mt-5">
                <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 8 }}>Replace this assignment</div>
                {pending.length > 0 ? (
                  <Note>
                    This record has {pending.length} pending {pending.length === 1 ? "transfer" : "transfers"}.
                    They must be accepted or cancelled before it can be replaced.
                  </Note>
                ) : (
                  <div>
                    <Note kind="caution">
                      For a court order, death, bankruptcy, lost instrument or legal successor. This
                      record becomes Superseded and a new record is issued for the same{" "}
                      {num(a.units)} units. Units can't change.
                    </Note>
                    <div className="mt-4">
                      <Field label="Hash of the supporting document" value={rpDoc} onChange={setRpDoc} placeholder="0x…" mono />
                      <Field label="Rightful holder's legal name" value={rpParty} onChange={setRpParty} placeholder="Estate of …" />
                      <Field label="Attention of" value={rpContact} onChange={setRpContact} placeholder="Full name" />
                      <Area label="Mailing address" value={rpAddress} onChange={setRpAddress}
                        placeholder={"Legal name\nAttn: name, position\nStreet\nCity, State ZIP"} />
                      <Button variant="quiet" danger
                        disabled={!rpDoc.trim() || !rpParty.trim() || !rpContact.trim() || !rpAddress.trim()}
                        onClick={() => replaceAssignment(a)}>
                        Replace — multisig {THRESHOLD}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {a.status === "Locked" && (
              <div className="mt-3" style={{ fontSize: 12, color: T.inkSoft, lineHeight: 1.5 }}>
                A locked record can't be replaced. Unlock it first
                {a.lockKind === "pledge" ? ", with the pledgee's signed release" : ""}.
              </div>
            )}

            {TERMINAL.includes(a.status) && (
              <div className="mt-5">
                <Note>
                  This record is terminal. No function accepts it as input — it stays on the
                  register as history and as the parent of anything that came after it.
                </Note>
              </div>
            )}
          </Sheet>
        );
      })()}

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
