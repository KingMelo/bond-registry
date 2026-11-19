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
    } else if (a.choice !== "Archive") lines.push(a.choice + " on " + a.template + ".");
  }
  return lines;
}
const SAY_KIND = { accept: "your acceptance", reject: "your rejection", assignOut: "your assign-out", reclaim: "taking back the units" };

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
