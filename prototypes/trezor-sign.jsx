// Approving chain writes with a Trezor.
//
// The issuer's (or platform's) Safe holds the role; each write waits for its owners to sign the
// Safe transaction. This signs it on a Trezor through Trezor Connect (trezor.io's own pop-up),
// so the key never leaves the device and the device shows what is being signed.
import React, { useCallback, useEffect, useState } from "react";

const FN_SAY = {
  registerIssuer: "Register the issuer", anchorBond: "Anchor the bond", recordPriorInstrument: "Record a prior instrument",
  reversePriorInstrument: "Reverse a prior instrument", issueAssignment: "Issue an assignment", replaceAssignment: "Replace an assignment",
  setFilingRef: "Record the UCC-3 filing", setDeliveryRef: "Record the certified mailing", rejectCredentialRequest: "Reject an access request",
  issueCredential: "Activate a new holder", issuerCancelAssignOut: "Cancel an assign-out", unlock: "Unlock a record",
  recordRotation: "Record a passkey reissue", redeem: "Record a redemption",
  suspendIssuer: "Suspend an issuer", reinstateIssuer: "Reinstate an issuer",
  clearHolderKey: "Reset a holder's device key",
  pause: "Freeze the registry contract (for a move to a new version)", unpause: "Unfreeze the registry contract",
};
export const sayFn = (fn) => FN_SAY[fn] || fn;
/** What one approval does: a single write, or each write a batch carries, in order. */
const sayItem = (it) => (it.calls && it.calls.length > 1 ? it.calls.map((c) => sayFn(c.fn)).join(" + ") : sayFn(it.fn));

let connect = null;
async function trezor() {
  if (connect) return connect;
  const mod = await import("@trezor/connect-web");
  const TrezorConnect = mod.default || mod;
  await TrezorConnect.init({
    lazyLoad: true,
    manifest: { appName: "Bond Interest Registry", appUrl: window.location.origin, email: window.__TREZOR_EMAIL__ || "registry@" + window.location.hostname },
  });
  connect = TrezorConnect;
  return connect;
}

// Standard Ethereum accounts on the device: m/44'/60'/0'/0/i.
const PATHS = Array.from({ length: 10 }, (_, i) => `m/44'/60'/0'/0/${i}`);

/** Finds which account on the connected Trezor is an owner of the Safe. */
async function ownerPath(owners) {
  const T = await trezor();
  const r = await T.ethereumGetAddress({ bundle: PATHS.map((path) => ({ path, showOnTrezor: false })) });
  if (!r.success) throw new Error(r.payload?.error || "The Trezor didn't answer.");
  const want = owners.map((o) => o.toLowerCase());
  const hit = r.payload.find((p) => want.includes(String(p.address).toLowerCase()));
  if (!hit) throw new Error("None of the first ten accounts on this Trezor is an owner of the Safe.");
  return { path: hit.serializedPath || PATHS[r.payload.indexOf(hit)], address: hit.address };
}

/** Signs one Safe transaction on the Trezor and returns the signature. */
export async function signOnTrezor(item) {
  const { path, address } = await ownerPath(item.owners);
  const T = await trezor();
  const td = item.typedData;
  const r = await T.ethereumSignTypedData({
    path,
    data: { types: td.types, primaryType: td.primaryType, domain: td.domain, message: td.message },
    metamask_v4_compat: true,
    // Used only by devices that can't show the structured data, which sign these hashes instead.
    domain_separator_hash: td.domainSeparatorHash,
    message_hash: td.messageHash,
  });
  if (!r.success) throw new Error(r.payload?.error || "Signing was cancelled.");
  return { signature: r.payload.signature, address };
}

/**
 * The list of writes waiting on a Safe, oldest first. Only the oldest can be signed: the Safe
 * runs them in order.
 */
export function SignatureQueue({ load, submit, T, sans, serif, onDone, onCount }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const refresh = useCallback(() => load().then((d) => { setData(d); onCount && onCount(d?.items?.length || 0); })
    .catch((e) => setErr(e.message)), [load, onCount]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh]);
  if (!data || !data.safe) return null;
  const items = data.items || [], recent = data.recent || [];
  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  async function approve(item) {
    setBusy(true); setErr(""); setMsg("Connect your Trezor and confirm on the device…");
    try {
      const { signature } = await signOnTrezor(item);
      await submit(item.seq, signature);
      const next = items.find((x) => x.seq !== item.seq);
      setMsg("Approved: " + sayItem(item) + " (" + item.ref + "). It's being sent to the chain; it appears under Recently approved once it's in."
        + (next ? " Next in line: " + sayItem(next) + ", Safe nonce " + next.nonce + ". It's a separate approval." : ""));
      await refresh(); onDone && onDone();
    } catch (e) { setErr(e.message); setMsg(""); } finally { setBusy(false); }
  }
  return (
    <div className="mb-6 px-3 py-3" style={{ border: "1px solid " + (items.length ? T.ink : T.rule), borderRadius: 2, background: T.white, fontFamily: sans }}>
      <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 4 }}>
        {items.length ? items.length + (items.length === 1 ? " action waits" : " actions wait") + " for your signature, one approval each" : "Nothing waiting for your signature"}
      </div>
      <div style={{ fontSize: 13, color: T.inkSoft, lineHeight: 1.55, marginBottom: items.length ? 10 : 0 }}>
        Signed by your Safe {data.safe.slice(0, 6)}…{data.safe.slice(-4)}
        {items[0] ? " · " + items[0].threshold + " of " + items[0].owners.length + " owner" + (items[0].owners.length === 1 ? "" : "s") + " needed" : ""}. Signing is free; the platform pays the gas.
      </div>
      {items.map((it, i) => (
        <div key={it.seq} className="flex justify-between items-center gap-3 py-2" style={{ borderTop: "1px solid " + T.rule, fontSize: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: T.ink }}>{sayItem(it)}</div>
            {it.calls?.length > 1 && <div style={{ fontSize: 12, color: T.inkSoft }}>One approval for {it.calls.length} writes, made together in one transaction.</div>}
            <div style={{ fontSize: 12, color: T.inkSoft, wordBreak: "break-all" }}>
              {i + 1} of {items.length} · {it.ref} · Safe nonce {it.nonce}{it.signedBy.length ? " · signed, being sent" : ""}
            </div>
            {i === 0 && <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 2, wordBreak: "break-all" }}>
              On your Trezor, check: verifying contract {short(it.safe)} (your Safe), to {short(it.typedData.message.to)}
              {it.typedData.message.operation === 1 ? " (Safe's MultiSend, which makes each write in turn), operation 1" : " (the registry)"}, nonce {it.nonce}.</div>}
          </div>
          {i === 0 ? (
            <button disabled={busy} onClick={() => approve(it)}
              style={{ fontFamily: sans, fontSize: 14, fontWeight: 500, padding: "8px 14px", borderRadius: 2, whiteSpace: "nowrap",
                background: T.ink, color: T.paper, border: "1px solid " + T.ink, opacity: busy ? 0.5 : 1, cursor: busy ? "default" : "pointer" }}>
              {busy ? "Waiting for Trezor…" : "Approve with Trezor"}
            </button>
          ) : <span style={{ fontSize: 12, color: T.inkSoft, whiteSpace: "nowrap" }}>Next in line</span>}
        </div>
      ))}
      {msg && <div style={{ fontSize: 13, color: T.ink, marginTop: 8, lineHeight: 1.5 }}>{msg}</div>}
      {recent.length > 0 && (
        <div className="mt-3 pt-2" style={{ borderTop: "1px solid " + T.rule }}>
          <div style={{ fontSize: 12, color: T.inkSoft, marginBottom: 4 }}>Recently approved</div>
          {recent.map((r) => (
            <div key={r.seq} className="flex justify-between gap-3" style={{ fontSize: 13, color: T.ink, padding: "3px 0" }}>
              <span style={{ minWidth: 0, wordBreak: "break-all" }}>{sayFn(r.fn)} · {r.ref} · nonce {r.nonce}</span>
              <span style={{ whiteSpace: "nowrap", color: r.status === "failed" ? T.red : T.inkSoft }}>
                {r.status === "failed" ? "Refused" : r.status === "sent" ? "Sending…" : r.link ? <a href={r.link} target="_blank" rel="noreferrer" style={{ color: T.ink }}>On-chain ↗</a> : "On-chain"}
              </span>
            </div>
          ))}
        </div>
      )}
      {err && <div style={{ fontSize: 13, color: T.red, marginTop: 8, lineHeight: 1.5 }}>{err}</div>}
    </div>
  );
}
