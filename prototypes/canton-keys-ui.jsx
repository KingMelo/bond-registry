// The assignee's Canton keys (pilot): set them up, keep the recovery code, add a device, recover.
// Shown only when the registry runs with Canton switched on. The look comes from the portal (ui).
import React, { useState } from "react";
import { api } from "../src/registry.jsx";
import { newDeviceKey, deviceKey, rememberFingerprint, signWithDeviceKey, newRecoveryKey, recoveryFromCode } from "../src/canton-keys.js";

const deviceLabel = () => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return browser + (os ? " on " + os : "");
};
const shortFp = (fp) => (fp ? fp.slice(4, 10) + "…" + fp.slice(-4) : "");

const dollars = (cents) => "$" + (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (h) => (h && h.length > 20 ? h.slice(0, 10) + "…" + h.slice(-6) : h);

/** The checked transaction in plain words: one line per thing it does. */
export function sayActs(summary) {
  const lines = [];
  const made = (tpl) => summary.acts.filter((a) => a.kind === "create" && a.template === tpl);
  for (const a of summary.acts) {
    if (a.kind !== "exercise") continue;
    if (a.template === "AssignmentOffer" && a.choice === "Accept") {
      const asg = made("Assignment")[0]?.args || {};
      lines.push("Accept assignment " + asg.recordId + " of " + dollars(asg.units) + " in bond " + asg.bondId + ", from " + asg.assignor + ".");
      lines.push("Signed paper on record: " + short(asg.instrumentHash) + ".");
    } else if (a.template === "AssignmentOffer" && a.choice === "Reject") {
      const back = made("UnitsReturned")[0]?.args || {};
      lines.push("Reject assignment " + back.recordId + "; its " + dollars(back.units) + " go back to " + (back.parentId !== "none" ? back.parentId : "the bond") + ".");
      lines.push("Reason: \u201c" + String(a.args.reason || "").slice(0, 120) + (String(a.args.reason || "").length > 120 ? "…" : "") + "\u201d");
    } else if (a.template === "Assignment" && a.choice === "AssignOut") {
      const rest = made("Assignment")[0]?.args || {};
      lines.push("Assign " + dollars(a.args.childUnits) + " of " + rest.recordId + " to " + a.args.childName + ", as " + a.args.childId + ".");
      lines.push("New signed paper: " + short(a.args.childHash) + ". You keep " + dollars(rest.units) + ".");
    } else if (a.template === "Assignment" && a.choice === "ReclaimToAssignment") {
      const rest = made("Assignment")[0]?.args || {};
      lines.push("Take back the units of a rejected assign-out into " + rest.recordId + ", which then holds " + dollars(rest.units) + ".");
    } else if (a.choice === "RecordMailing") {
      const offer = made("AssignmentOffer")[0]?.args || {};
      lines.push("Record the certified mailing of " + offer.recordId + " to " + offer.assigneeName + ", sent " + String(a.args.sentOn).slice(0, 10) + ".");
      lines.push("Its fingerprint: " + short(a.args.mailingRef) + ". The assignee's 30 days run from this date.");
    } else if (a.choice === "RecordUcc3" || a.choice === "RecordUcc3OnAssignment") {
      const on = (made("AssignmentOffer")[0] || made("Assignment")[0])?.args || {};
      lines.push("Record the UCC-3 filed for " + on.recordId + ": filed copy " + short(a.args.filedHash) + ".");
    } else if (a.choice === "RecordReceipt" || a.choice === "RecordReceiptOnAssignment") {
      const on = (made("AssignmentOffer")[0] || made("Assignment")[0])?.args || {};
      lines.push("Record your delivery receipt for " + on.recordId + ", received " + a.args.received + ".");
      lines.push("Its fingerprint: " + short(a.args.ref) + ".");
    } else if (a.template === "Assignment" && a.choice === "Lock") {
      const on = made("Assignment")[0]?.args || {};
      lines.push("Lock " + on.recordId + " (" + a.args.kind + ": " + a.args.reason + ").");
      if (a.args.kind === "pledge" && a.args.lender && a.args.lender !== "none")
        lines.push("Pledged to " + a.args.lender + (/\.$/.test(a.args.lender) ? "" : ".") + " While it's locked nothing can be assigned out, redeemed or replaced. Once " + a.args.lender + " claims the pledge, only they can release it.");
      else lines.push("While it's locked nothing can be assigned out, redeemed or replaced; you can unlock it yourself.");
    } else if (a.template === "Assignment" && a.choice === "Unlock") {
      const on = made("Assignment")[0]?.args || {};
      lines.push("Unlock " + on.recordId + ": it's back in effect, and you can assign out from it again.");
    } else if (a.template === "Assignment" && a.choice === "ReleasePledge") {
      const on = made("Assignment")[0]?.args || {};
      lines.push("Release your pledge on " + on.recordId + " (" + dollars(on.units) + ", held by " + on.assigneeName + "). It's unlocked, and you no longer hold it as security.");
    } else if (a.template === "ReplacementProposal" && a.choice === "Consent") {
      const offer = made("AssignmentOffer")[0]?.args || {};
      lines.push("Agree to the issuer replacing " + offer.parentId + ": it ends, and " + offer.recordId + " is offered to " + offer.assigneeName + " for the same " + dollars(offer.units) + ".");
      lines.push("New signed paper: " + short(offer.instrumentHash) + ". You no longer hold " + offer.parentId + ".");
    } else if (a.template === "ReplacementProposal" && a.choice === "Decline") {
      lines.push("Decline the issuer's proposal to replace your assignment. Nothing about it changes.");
    } else if (a.choice === "ReplaceByConsent" || a.choice === "Withdraw") {
      // part of consenting to a replacement, said above
    } else if (a.template === "Assignment" && a.choice === "CancelAssignOut") {
      const rest = made("Assignment")[0]?.args || {};
      lines.push("Cancel your unclaimed assign-out; its units come back to " + rest.recordId + ", which then holds " + dollars(rest.units) + ".");
    } else if (a.choice === "Cancel" || a.choice === "Archive") {
      // part of cancelling an assign-out, said above
    } else lines.push(a.choice + " on " + a.template + ".");
  }
  return lines;
}
const SAY_KIND = { accept: "your acceptance", reject: "your rejection", assignOut: "your assign-out", reclaim: "taking back the units",
  mailing: "the mailing", ucc3: "the UCC-3", receipt: "your delivery receipt", lock: "your lock", cancelOut: "cancelling your assign-out",
  unlock: "your unlock", release: "releasing the pledge", consentReplacement: "agreeing to the replacement", declineReplacement: "declining the replacement" };

/**
 * Signs, one by one, the acts the register has and Canton doesn't. Each transaction is checked
 * against its hash in this page first, then shown to the assignee (ask), and only signed if they agree.
 * `wait`: poll a little while for an act the register is still saving.
 */
export async function signWaiting(recordId, token, ask, { wait = false } = {}) {
  let signed = 0;
  for (let i = 0; i < (wait ? 15 : 1) + 20; i++) {
    const st = await api.canton("status", { token });
    if (!st.enabled || !st.party) return { signed, skipped: true };
    const next = st.toSign?.[0];
    if (!next) {
      if (wait && !signed && i < 15) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      return { signed };
    }
    const key = await deviceKey(recordId);
    if (!key?.fp || !(st.keys || []).some((k) => k.fp === key.fp)) return { signed, noKey: true };
    const p = await api.canton("act/prepare", { token, kind: next.kind, child: next.child });
    const { check } = await import("../src/canton-verify.js"); // loaded only when there's something to sign
    const checked = check(p.prepared, p.hash);
    if (!checked.ok) throw new Error(checked.reason);
    if (!(await ask({ kind: next.kind, title: "Sign " + SAY_KIND[next.kind] + " on Canton", lines: sayActs(checked), by: checked.actAs }))) return { signed, declined: true };
    await api.canton("act/execute", { token, signature: await signWithDeviceKey(recordId, p.hash), signedBy: key.fp });
    signed++;
  }
  return { signed };
}

/** The question before each signature: what it does, checked here, and Sign / Not now. */
export function CantonAsk({ question, onAnswer, ui }) {
  const { T, serif, Button } = ui;
  return (
    <div role="dialog" aria-label={question.title} style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(20,24,30,0.45)",
      display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div style={{ background: T.paper, width: "100%", maxWidth: 520, padding: "20px 18px 22px", borderRadius: "4px 4px 0 0" }}>
        <div style={{ fontFamily: serif, fontSize: 21, color: T.ink, marginBottom: 8 }}>{question.title}</div>
        <div data-testid="canton-ask" style={{ border: "1px solid " + T.rule, borderRadius: 2, background: T.white, padding: "10px 12px", fontSize: 14, color: T.ink, lineHeight: 1.6 }}>
          {question.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
        <div style={{ fontSize: 12, color: T.inkSoft, margin: "8px 0 14px", lineHeight: 1.5 }}>
          Checked in this browser: this is exactly the transaction your key would sign, acting as {question.by.map((b) => (/-A\d{5}/.test(b) ? "the holder of " + b : b)).join(", ")}.
        </div>
        <div className="space-y-2">
          <Button onClick={() => onAnswer(true)}>Sign with this browser's key</Button>
          <Button variant="quiet" onClick={() => onAnswer(false)}>Not now</Button>
        </div>
      </div>
    </div>
  );
}

// The three steps of a first setup, all signed here: the recovery key makes the party, then the
// recovery and device keys together add the device key.
async function onboard(recordId, token) {
  const recovery = newRecoveryKey();
  const device = await newDeviceKey(recordId);
  const s = await api.canton("onboard/start", { token, recoverySpki: recovery.spki, deviceSpki: device.spki, deviceLabel: deviceLabel() });
  const { hashes } = await api.canton("onboard/allocate", { token, recoverySignature: recovery.sign(s.multiHash) });
  const signatures = await Promise.all(hashes.map(async (h) => [
    { signature: recovery.sign(h), signedBy: s.recoveryFp },
    { signature: await signWithDeviceKey(recordId, h), signedBy: s.deviceFp }]));
  const done = await api.canton("onboard/finish", { token, signatures });
  await rememberFingerprint(recordId, s.deviceFp);
  return { code: recovery.code, party: done.party };
}

// A key change: this browser gets a new device key; the recovery code authorizes it.
async function changeKeys(recordId, token, mode, code) {
  const recovery = recoveryFromCode(code);
  const device = await newDeviceKey(recordId);
  const s = await api.canton("keys/start", { token, mode, newSpki: device.spki, label: deviceLabel() });
  const signatures = await Promise.all(s.hashes.map(async ({ hash, newKeySigns }) => [
    { signature: recovery.sign(hash), signedBy: s.recoveryFp },
    ...(newKeySigns ? [{ signature: await signWithDeviceKey(recordId, hash), signedBy: s.newFp }] : [])]));
  const done = await api.canton("keys/finish", { token, signatures });
  await rememberFingerprint(recordId, s.newFp);
  return done;
}

/** First setup: make the keys, then show the recovery code once and check it was kept. */
export function CantonSetup({ recordId, token, onDone, ui }) {
  const { T, serif, Button, Field, Rows, Note } = ui;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [made, setMade] = useState(null); // { code }
  const [check, setCheck] = useState("");
  const last = made?.code.split("-").slice(-1)[0];

  async function make() {
    setErr(""); setBusy(true);
    try { setMade(await onboard(recordId, token)); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  function printCode() {
    const w = window.open("", "_blank");
    if (!w) return setErr("Your browser blocked the print window. Allow pop-ups for this site, or write the code down.");
    w.document.write(`<!doctype html><title>Recovery code · ${recordId}</title><body style="font-family:Georgia,serif;padding:48px;color:#1B1F24">
      <div style="font:600 11px Helvetica,Arial;letter-spacing:.16em;text-transform:uppercase;color:#8B2A26">Confidential</div>
      <h1 style="font-weight:normal">Recovery code</h1><p>Assignment ${recordId}. Keep this offline, somewhere safe.
      It's the only way to add a new device or replace a lost one. Anyone holding it can act on this assignment, so don't share it.</p>
      <div style="font:24px 'Courier New',monospace;letter-spacing:.08em;border:2px solid #1B1F24;padding:18px;line-height:1.7">${made.code.split("-").reduce((a, g, i) => a + g + (i % 4 === 3 ? "<br>" : " "), "")}</div></body>`);
    w.document.close(); w.focus(); setTimeout(() => { try { w.print(); } catch { /* print by hand */ } }, 300);
  }

  if (!made) return (
    <div>
      <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Set up your keys</h1>
      <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 18px", maxWidth: "62ch" }}>
        This assignment is also recorded on the Canton network, where it's private to you, the issuer
        and the assignor. Your browser now makes the keys that act for you there. Nobody else holds them.
      </p>
      <Rows data={[
        ["Device key", "Made by this browser and kept in it. It can't be copied out, even by this page."],
        ["Recovery key", "Shown once as a code for you to print or write down and keep offline. It adds a new device or replaces a lost one."],
        ["If you lose both", "Nobody can restore them, not even the issuer. That's what keeps control with you."],
      ]} />
      {err && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, margin: "14px 0 0" }}>{err}</p>}
      <div className="mt-5"><Button disabled={busy} onClick={make}>{busy ? "Making your keys…" : "Make my keys"}</Button></div>
    </div>
  );
  return (
    <div>
      <h1 style={{ fontFamily: serif, fontSize: 27, color: T.ink, lineHeight: 1.25 }}>Your recovery code</h1>
      <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.6, margin: "10px 0 14px", maxWidth: "62ch" }}>
        Print it or write it down now and keep it offline, somewhere safe. It's shown only this once;
        this page forgets it when you continue.
      </p>
      <div data-testid="recovery-code" style={{ fontFamily: "'IBM Plex Mono', 'Courier New', monospace", fontSize: 18, letterSpacing: "0.06em", lineHeight: 1.8,
        color: T.ink, border: "2px solid " + T.ink, borderRadius: 2, padding: "14px 16px", background: T.white, wordBreak: "break-word" }}>
        {made.code.split("-").join(" ")}
      </div>
      <div className="mt-3"><Button variant="quiet" onClick={printCode}>Print the recovery code</Button></div>
      <div className="mt-4"><Note kind="caution">Anyone holding this code can act on your assignment. Don't photograph it, email it or store it on this device.</Note></div>
      <div className="mt-4">
        <Field label="To check you've kept it, type its last group" value={check} onChange={setCheck} placeholder="Four characters" mono />
      </div>
      <Button disabled={check.trim().toUpperCase() !== last} onClick={() => { setMade(null); onDone(); }}>I've kept it: continue</Button>
    </div>
  );
}

/** On the assignment: its keys, and adding this browser or replacing a lost device with the code. */
export function CantonKeys({ recordId, token, status, onChanged, ui }) {
  const { T, Button, Field, Note } = ui;
  const [mode, setMode] = useState(null); // "add" | "recover"
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [here, setHere] = useState(undefined);
  React.useEffect(() => { deviceKey(recordId).then((k) => setHere(k?.fp || null)).catch(() => setHere(null)); }, [recordId, status]);
  const devices = (status.keys || []).filter((k) => k.role === "device");
  const thisOne = here && devices.some((k) => k.fp === here);

  async function go() {
    setErr(""); setBusy(true);
    try {
      await changeKeys(recordId, token, mode, code);
      setMode(null); setCode("");
      onChanged(mode === "add" ? "This browser can now act on " + recordId + " on Canton." : "Done. Your lost device's key no longer works; this browser's key does.");
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="mt-6" data-testid="canton-keys">
      <div style={{ fontSize: 15, color: T.ink, marginBottom: 6 }}>Your keys on Canton</div>
      <div style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
        {(status.keys || []).map((k, i) => (
          <div key={k.fp} className="flex justify-between gap-3 px-3 py-2" style={{ borderTop: i ? "1px solid " + T.rule : "none", fontSize: 14 }}>
            <span style={{ color: T.ink }}>{k.role === "recovery" ? "Recovery code (offline)" : k.label}{k.fp === here ? " · this browser" : ""}</span>
            <span style={{ color: T.inkSoft, fontVariantNumeric: "tabular-nums" }}>{shortFp(k.fp)}</span>
          </div>
        ))}
      </div>
      {here !== undefined && !thisOne && (
        <div className="mt-3"><Note kind="caution">This browser has no key for this assignment. Add it with your recovery code to act here on Canton.</Note></div>
      )}
      {!mode && (
        <div className="mt-3 space-y-2">
          {!thisOne && <Button variant="quiet" onClick={() => setMode("add")}>Add this browser</Button>}
          <Button variant="quiet" onClick={() => setMode("recover")}>Lost a device? Replace it</Button>
        </div>
      )}
      {mode && (
        <div className="mt-3">
          <p style={{ fontSize: 14, color: T.inkSoft, lineHeight: 1.6, marginBottom: 10 }}>
            {mode === "add" ? "This browser makes its own key; your other devices keep theirs."
              : "This browser makes a new key, and every other device's key stops working."} Your recovery code authorizes it; it isn't sent anywhere.
          </p>
          <Field label="Recovery code" value={code} onChange={(v) => { setCode(v); setErr(""); }} placeholder="14 groups of four" mono />
          {err && <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, margin: "0 0 10px" }}>{err}</p>}
          <div className="space-y-2">
            <Button disabled={busy || code.replace(/[\s-]/g, "").length < 56} onClick={go}>{busy ? "Signing…" : mode === "add" ? "Add this browser" : "Replace my lost device"}</Button>
            <Button variant="quiet" onClick={() => { setMode(null); setCode(""); setErr(""); }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The assignee's own record as Canton holds it: the contract (its parties, amount, the signed
 * paper's fingerprint, who signed it) and every transaction that touched it. Read live from the
 * node for the signed-in assignee only. "Check your copy" hashes their signed paper in this browser
 * (it isn't uploaded) and compares it with the fingerprint on Canton.
 */
export function CantonRecord({ token, ui }) {
  const { T } = ui;
  const [rec, setRec] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState(null); // { ok, hash }
  const load = () => { setErr(""); api.canton("record", { token }).then(setRec).catch((e) => setErr(e.message)); };
  React.useEffect(() => { if (open && !rec) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const c = rec?.contract;
  const row = (k, v) => v ? <div style={{ display: "flex", gap: 10, padding: "4px 0", borderTop: "1px solid " + T.rule, fontSize: 13.5 }}>
    <span style={{ color: T.inkSoft, flex: "0 0 128px" }}>{k}</span><span style={{ minWidth: 0, overflowWrap: "anywhere", color: T.ink }}>{v}</span></div> : null;
  const when = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");
  async function checkCopy(file) {
    const hash = "0x" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
    setCheck({ ok: hash === c?.paper, hash });
  }
  return (
    <div className="mt-4" data-testid="canton-record" style={{ border: "1px solid " + T.rule, borderRadius: 2, padding: "10px 12px", background: T.white }}>
      <button onClick={() => setOpen(!open)} style={{ background: "none", border: 0, padding: 0, cursor: "pointer", fontSize: 14, fontWeight: 600, color: T.ink }}>
        {open ? "▾" : "▸"} Your record on Canton
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {err && <p style={{ color: T.red, fontSize: 13 }}>{err}</p>}
          {!rec && !err && <p style={{ color: T.inkSoft, fontSize: 13 }}>Reading it from the node…</p>}
          {rec && !rec.onCanton && <p style={{ color: T.inkSoft, fontSize: 13 }}>This record isn't on Canton yet.</p>}
          {rec?.onCanton && (
            <>
              <p style={{ color: T.inkSoft, fontSize: 13, margin: "0 0 6px" }}>Exactly what the Canton node holds for your record, read just now. Only you see this.</p>
              {c ? <div>
                {row("What it is", c.kind)}
                {row("Amount", dollars(c.units))}
                {row("Issuer", c.issuer)}
                {row("Assignor", c.assignor)}
                {row("Assignee", c.assignee)}
                {row("Signed by", c.signedBy.join(", "))}
                {row("Signed paper", <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{c.paper}</span>)}
                {c.carveOuts.length > 0 && row("Assigned out", c.carveOuts.length + " portion" + (c.carveOuts.length === 1 ? "" : "s") + ", each with its own paper")}
                {row("UCC-3", c.ucc3 && "Recorded · " + short(c.ucc3))}
                {row("Mailing", c.mailing && "Recorded · " + short(c.mailing))}
                {row("Delivery receipt", c.receipt && "Recorded · " + short(c.receipt))}
                {row("Locked", c.locked && c.locked + (c.pledgedTo ? " · pledged to " + c.pledgedTo : ""))}
                {row("Since", when(c.since))}
                {row("Contract", <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{c.id}</span>)}
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  <label style={{ color: T.ink }}>Check your copy of the signed paper: <input type="file" aria-label="Check your copy" onChange={(e) => e.target.files[0] && checkCopy(e.target.files[0])} /></label>
                  {check && <p data-testid="canton-check" style={{ margin: "6px 0 0", color: check.ok ? T.green || T.ink : T.red }}>
                    {check.ok ? "It matches: this is the paper Canton holds for your record." : "It doesn't match the paper on Canton (" + short(check.hash) + ")."}</p>}
                  <p style={{ color: T.inkSoft, margin: "4px 0 0" }}>Fingerprinted in this browser; the file isn't uploaded.</p>
                </div>
              </div> : <p style={{ color: T.inkSoft, fontSize: 13 }}>It has no live contract any more (it was closed); its history is below.</p>}
              <div style={{ marginTop: 10, fontSize: 13.5, fontWeight: 600, color: T.ink }}>History on Canton</div>
              <ol style={{ listStyle: "none", padding: 0, margin: "4px 0 0" }}>
                {rec.history.map((h) => (
                  <li key={h.transaction} style={{ padding: "4px 0", borderTop: "1px solid " + T.rule, fontSize: 13.5 }}>
                    <span style={{ color: T.inkSoft }}>{when(h.at)}</span> · {h.what}{h.by.length ? <span style={{ color: T.inkSoft }}> · by {h.by.join(", ")}</span> : null}
                  </li>
                ))}
              </ol>
              <button onClick={load} style={{ marginTop: 6, background: "none", border: 0, padding: 0, textDecoration: "underline", cursor: "pointer", color: T.ink, fontSize: 13 }}>Read it again</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
