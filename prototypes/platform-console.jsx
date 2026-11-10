import React, { useCallback, useEffect, useState } from "react";
import { T, serif, sans, Label, Chip, Button, Field, Area, Rows, Note } from "./issuer-console.jsx";
import { Shell, Heading, Lede, ErrorText, TextLink, ForgotPassword, NewPassword, resetToken } from "./issuer-account.jsx";
import { api, Loading, dollars } from "../src/registry.jsx";
import { SignatureQueue } from "./trezor-sign.jsx";

/* ================================================================
   Platform console — the platform's own back office.
   Staff review new issuers, then each bond they register, and keep a
   directory of every bond's totals. Holders never come here, and no
   holder names or contact details are shown.
   ================================================================ */

const POLL_MS = 5000;
// Every amount is stored in cents and shown in dollars.
const usd = dollars;
const day = (d) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

const ISSUER = {
  pending: ["Issued", "Applied, waiting for review"],
  approved: ["Accepted", "Approved"],
  suspended: ["Locked", "Suspended"],
};
const BOND = {
  pending: ["Issued", "Waiting for review"],
  approved: ["Accepted", "Live"],
  rejected: ["Locked", "Not approved"],
};

const Hash = ({ value, file }) => (
  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, wordBreak: "break-all" }}>
    {value || "—"}{file && <span style={{ display: "block", fontFamily: sans, color: T.inkSoft }}>{file}</span>}
  </span>
);

// The bond's UCC-1: the public filing details, and the filed copy's hash.
const ucc1Rows = (b) => b.ucc1Complete
  ? [["UCC-1", b.ucc1.number + " · " + b.ucc1.office + " · filed " + b.ucc1.date],
     ["UCC-1 filed copy", <Hash value={b.ucc1.hash} file={b.ucc1.file} />]]
  : [["UCC-1", "Not recorded yet"]];

const Card = ({ children, tone }) => (
  <div className="px-3 py-3 mb-3" style={{ background: T.white, borderRadius: 2,
    border: "1px solid " + (tone === "attention" ? T.amber : T.rule) }}>{children}</div>
);

const CardHead = ({ title, sub, chip }) => (
  <div className="flex justify-between items-start gap-3 mb-2">
    <span style={{ minWidth: 0 }}>
      <span style={{ display: "block", fontSize: 15, color: T.ink, fontWeight: 500, wordBreak: "break-word" }}>{title}</span>
      {sub && <span style={{ display: "block", fontSize: 13, color: T.inkSoft, marginTop: 2 }}>{sub}</span>}
    </span>
    {chip}
  </div>
);

/* ---------------- signed out ---------------- */

function PlatformAuth({ needsSetup, onDone }) {
  const [mode, setMode] = useState(resetToken() ? "reset" : needsSetup ? "setup" : "signin");
  const [f, setF] = useState({ email: "", password: "", name: "", setupCode: "", inviteCode: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => { setF((x) => ({ ...x, [k]: v })); setErr(""); };
  const go = (m) => { setMode(m); setErr(""); };

  async function submit() {
    setBusy(true);
    try {
      if (mode === "signin") await api.login(f.email, f.password);
      if (mode === "setup") await api.setup({ email: f.email, password: f.password, name: f.name, setupCode: f.setupCode });
      if (mode === "join") await api.signup({ email: f.email, password: f.password, name: f.name, inviteCode: f.inviteCode });
      await onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const you = (
    <>
      <Field label="Your name" value={f.name} onChange={set("name")} placeholder="Full name" autoComplete="name" />
      <Field label="Email" value={f.email} onChange={set("email")} placeholder="you@example.com" autoComplete="email" />
      <Field label="Password" value={f.password} onChange={set("password")} type="password" autoComplete="new-password"
        hint="At least 10 characters." />
    </>
  );

  return (
    <Shell>
      <div style={{ fontFamily: serif, fontSize: 21, color: T.ink, fontWeight: 500, marginBottom: 22 }}>Platform</div>
      {mode === "signin" && (
        <div>
          <Heading>Sign in</Heading>
          <Lede>For platform staff. Issuers use the issuer console; holders use the public registry.</Lede>
          <Field label="Email" value={f.email} onChange={set("email")} placeholder="you@example.com" autoComplete="email" />
          <Field label="Password" value={f.password} onChange={set("password")} type="password" autoComplete="current-password" />
          <ErrorText>{err}</ErrorText>
          <Button disabled={busy} onClick={submit}>{busy ? "Signing in…" : "Sign in"}</Button>
          <div className="mt-5 space-y-2" style={{ fontSize: 14, color: T.inkSoft }}>
            <div>Forgot your password? <TextLink onClick={() => go("forgot")}>Reset it</TextLink></div>
            <div>Joining the platform team? <TextLink onClick={() => go("join")}>Use an invite code</TextLink></div>
            {needsSetup && <div>First time? <TextLink onClick={() => go("setup")}>Set up the platform owner</TextLink></div>}
          </div>
        </div>
      )}
      {mode === "forgot" && <ForgotPassword onBack={() => go("signin")} />}
      {mode === "reset" && <NewPassword token={resetToken()} onDone={() => go("signin")} />}
      {mode === "setup" && (
        <div>
          <Heading>Set up the platform owner</Heading>
          <Lede>
            Done once. The owner reviews issuers and bonds, invites platform staff, and takes over the sample
            register. The setup code is ADMIN_SETUP_CODE on this service in Railway.
          </Lede>
          <Field label="Setup code" value={f.setupCode} onChange={set("setupCode")} type="password" autoComplete="off" />
          {you}
          <ErrorText>{err}</ErrorText>
          <Button disabled={busy} onClick={submit}>{busy ? "Setting up…" : "Create platform owner account"}</Button>
          <div className="mt-4"><TextLink onClick={() => go("signin")}>Back to sign in</TextLink></div>
        </div>
      )}
      {mode === "join" && (
        <div>
          <Heading>Join the platform team</Heading>
          <Lede>The platform owner creates invite codes in the Staff tab. Each works once and lasts seven days.</Lede>
          <Field label="Invite code" value={f.inviteCode} onChange={set("inviteCode")} placeholder="XXXX-XXXX-XXXX" mono />
          {you}
          <ErrorText>{err}</ErrorText>
          <Button disabled={busy} onClick={submit}>{busy ? "Joining…" : "Join"}</Button>
          <div className="mt-4"><TextLink onClick={() => go("signin")}>Back to sign in</TextLink></div>
        </div>
      )}
    </Shell>
  );
}

/* ---------------- review ---------------- */

function IssuerCard({ i, onStatus, busy }) {
  const [tone, label] = ISSUER[i.status];
  return (
    <Card tone={i.status === "pending" ? "attention" : undefined}>
      <CardHead title={i.legalName} sub={"Issuer code " + i.code + (i.trusted ? " · platform owner's issuer, no reviews needed" : "")}
        chip={<Chip s={tone} text={label} />} />
      <Rows data={[
        ["Owner", i.ownerName ? i.ownerName + " · " + i.ownerEmail : "—"],
        ["Team", i.members + (i.members === 1 ? " person" : " people")],
        ["Bonds", i.bonds ? i.liveBonds + " live of " + i.bonds : "None yet"],
        ["Applied", day(i.createdAt)],
        i.reviewer && ["Last reviewed", day(i.reviewedAt) + " by " + i.reviewer],
      ]} />
      <div className="mt-3 flex flex-wrap gap-3">
        {i.status !== "approved" && (
          <div style={{ flex: "1 1 160px" }}>
            <Button disabled={busy} onClick={() => onStatus(i, "approved")}>{i.status === "suspended" ? "Reinstate" : "Approve issuer"}</Button>
          </div>
        )}
        {i.status !== "suspended" && (
          <div style={{ flex: "1 1 160px" }}>
            <Button variant="quiet" danger disabled={busy} onClick={() => onStatus(i, "suspended")}>
              {i.status === "pending" ? "Decline" : "Suspend"}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function BondFigures({ b }) {
  return (
    <Rows data={[
      ["Total", usd(b.total)],
      ["Prior instruments", b.priorCount ? usd(b.priorUnits) + " · " + b.priorCount + (b.priorCount === 1 ? " note" : " notes") : "None"],
      ["Assigned to holders", usd(b.assigned)],
      ["Redeemed and retired", usd(b.redeemed)],
      ["Unassigned", usd(b.unassigned)],
      ["Holder records", b.allRecords ? b.liveRecords + " live of " + b.allRecords : "None"],
      ["Registered", b.registered || "—"],
      b.reviewer && ["Reviewed", day(b.reviewedAt) + " by " + b.reviewer],
      b.review === "rejected" && b.reviewNote && ["Reason given", b.reviewNote],
    ]} />
  );
}

function BondReviewCard({ b, onDone }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function decide(decision) {
    setBusy(true); setErr("");
    try { await api.reviewBond(b.id, decision, note); await onDone(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Card tone="attention">
      <CardHead title={b.id + (b.title ? " · " + b.title : "")} sub={b.issuer.legalName + " (" + b.issuer.code + ")"}
        chip={<Chip s="Issued" text="Waiting for review" />} />
      <BondFigures b={b} />
      <div className="mt-3">
        <Label>Documents</Label>
        <Rows data={[
          ["Bond instrument", <Hash value={b.instrumentHash} file={b.instrumentFile} />],
          ...ucc1Rows(b),
          b.masterHash && ["Master collateral assignment", <Hash value={b.masterHash} file={b.masterFile} />],
        ]} />
        <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 6, lineHeight: 1.5 }}>
          {b.ucc1Complete
            ? "Ask the issuer for the signed documents and check that each file's SHA-256 matches, and look up the UCC-1 at the filing office, before approving."
            : "Waiting for the issuer's UCC-1. The bond can't be approved until it's recorded."}
        </div>
      </div>
      <div className="mt-4">
        <Area label="Reason, if not approving" value={note} onChange={(v) => { setNote(v); setErr(""); }} rows={2}
          placeholder="UCC-1 collateral description doesn't match the bond" />
        <ErrorText>{err}</ErrorText>
        <div className="flex flex-wrap gap-3">
          <div style={{ flex: "1 1 160px" }}><Button disabled={busy || !b.ucc1Complete} onClick={() => decide("approved")}>Approve bond</Button></div>
          <div style={{ flex: "1 1 160px" }}>
            <Button variant="quiet" danger disabled={busy || !note.trim()} onClick={() => decide("rejected")}>Don't approve</Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ---------------- staff ---------------- */

const FN_LABEL = {
  registerIssuer: "Register issuer", anchorBond: "Anchor bond", recordPriorInstrument: "Record prior instrument",
  reversePriorInstrument: "Reverse prior instrument", issueAssignment: "Issue assignment", assignOut: "Assign out",
  replaceAssignment: "Replace assignment", setFilingRef: "Record UCC-3 filing", setDeliveryRef: "Record mailing",
  accept: "Took effect", rejectAssignment: "Rejected by holder", registerHolderKey: "Holder device key", rotateHolderKey: "Holder device key changed", clearHolderKey: "Holder device key reset", requestCredential: "Request credential", rejectCredentialRequest: "Reject credential request",
  issueCredential: "Issue credential", cancelAssignOut: "Cancel assign-out", issuerCancelAssignOut: "Cancel assign-out (issuer)",
  lock: "Lock", unlock: "Unlock", recordRotation: "Record passkey rotation", redeem: "Redeemed",
  suspendIssuer: "Suspend issuer",
  reinstateIssuer: "Reinstate issuer", unsupported: "No matching contract call",
};

// The on-chain mirror: what's waiting, what went through, and anything the contract refused.
function ChainPanel({ me, flash }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => api.chainSummary().then(setS).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, [load]);
  if (!s) return <Loading error={err} />;
  if (!s.enabled) return (
    <div>
      <Heading>Chain</Heading>
      <Lede>The on-chain mirror is off on this console: CHAIN_CONTRACT isn't set.</Lede>
    </div>
  );
  const n = (k) => s.counts[k] || 0;
  const retry = async (seq) => {
    try { await api.chainRetry(seq); flash("Queued again."); await load(); } catch (e) { flash(e.message); }
  };
  return (
    <div>
      <Heading>Chain</Heading>
      <Lede>
        Every change the contract tracks is written to it in order, one bond at a time. If the
        contract refuses a write, later writes for that bond wait until it's fixed and retried.
      </Lede>
      {s.platformSafe && me.role === "owner" && (
        <SignatureQueue load={api.platformSigning} submit={api.platformSign} T={T} sans={sans} serif={serif} onDone={load} />
      )}
      <Rows data={[
        ["Contract", <a href={s.explorer + "/address/" + s.contract} target="_blank" rel="noreferrer"
          style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 2 }}>{s.contract.slice(0, 10) + "…" + s.contract.slice(-6)}</a>],
        ["Recorded", String(n("confirmed"))],
        ["Waiting to be written", String(n("queued") + n("sent"))],
        n("signing") > 0 && ["Waiting for signatures", String(n("signing"))],
        s.platformSafe && ["Platform role held by", "Safe " + s.platformSafe],
        ["Refused", String(n("failed"))],
        s.last && ["Last transaction", <a href={s.explorer + "/tx/" + s.last.tx} target="_blank" rel="noreferrer"
          style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 2 }}>{new Date(s.last.updated_at).toLocaleString()}</a>],
      ]} />
      {s.failed.length > 0 && (
        <div className="mt-5">
          <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, marginBottom: 8 }}>Refused writes</div>
          {s.failed.map((f) => (
            <div key={f.seq} className="px-3 py-3 mb-2" style={{ border: "1px solid " + T.red, borderRadius: 2, background: T.white }}>
              <div style={{ fontSize: 14, color: T.ink }}>{FN_LABEL[f.fn] || f.fn} · {f.ref}</div>
              <div style={{ fontSize: 13, color: T.red, marginTop: 4, lineHeight: 1.5, wordBreak: "break-word" }}>{f.error}</div>
              {me.role === "owner" && (
                <div className="mt-2"><Button variant="quiet" onClick={() => retry(f.seq)}>Retry</Button></div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StaffPanel({ me }) {
  const [staff, setStaff] = useState(null);
  const [invite, setInvite] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.staff().then((r) => setStaff(r.staff)).catch((e) => setErr(e.message)); }, [invite]);
  return (
    <div>
      <Heading>Platform staff</Heading>
      <Lede>Everyone here can review issuers and bonds. Only the owner can invite staff.</Lede>
      {staff && (
        <div style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
          {staff.map((m, i) => (
            <div key={m.email} className="flex justify-between items-center gap-3 px-3 py-2"
              style={{ background: i % 2 ? T.band : T.white, fontSize: 14 }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ color: T.ink }}>{m.name}</span>
                <span style={{ display: "block", fontSize: 12, color: T.inkSoft, wordBreak: "break-all" }}>{m.email}</span>
              </span>
              <Chip s={m.role === "owner" ? "Accepted" : "Superseded"} text={m.role === "owner" ? "Owner" : "Staff"} />
            </div>
          ))}
        </div>
      )}
      <ErrorText>{err}</ErrorText>
      {me.role === "owner" && (
        <div className="mt-4">
          {invite ? (
            <div>
              <Label>Invite code</Label>
              <div className="px-3 py-4 mb-3 text-center" style={{ border: "2px solid " + T.ink, borderRadius: 2, background: T.white,
                fontSize: 22, letterSpacing: "0.08em", color: T.ink, fontVariantNumeric: "tabular-nums", userSelect: "all" }}>
                {invite.code}
              </div>
              <Note kind="caution">
                Shown once. It works once and expires in {invite.expiresInDays} days. They choose
                <strong style={{ fontWeight: 600 }}> Use an invite code</strong> on this console's sign-in page.
              </Note>
              <div className="mt-3"><Button variant="quiet" onClick={() => setInvite(null)}>Done</Button></div>
            </div>
          ) : (
            <Button variant="quiet" onClick={() => api.staffInvite().then(setInvite).catch((e) => setErr(e.message))}>
              Invite staff
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- console ---------------- */

export default function PlatformApp() {
  const [me, setMe] = useState(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("review");
  const [issuers, setIssuers] = useState(null);
  const [bonds, setBonds] = useState(null);
  const [version, setVersion] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [fStatus, setFStatus] = useState("all");
  const [fIssuer, setFIssuer] = useState("all");

  const loadMe = useCallback(() => api.me().then(setMe).catch((e) => setErr(e.message)), []);
  useEffect(() => { loadMe(); }, [loadMe]);

  const load = useCallback(async () => {
    const [i, b, s] = await Promise.all([api.platformIssuers(), api.platformBonds(), api.summary()]);
    setIssuers(i.issuers); setBonds(b.bonds); setVersion(s.version);
  }, []);

  useEffect(() => {
    if (!me?.user) return;
    load().catch((e) => setErr(e.message));
    // New applications and bonds arrive without a reload.
    const t = setInterval(async () => {
      try { const s = await api.summary(); if (s.version !== version) await load(); } catch { /* next tick */ }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [me, load, version]);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2800); };

  if (!me) return <Loading error={err} />;
  if (!me.user || resetToken()) return <PlatformAuth needsSetup={me.needsSetup} onDone={loadMe} />;
  if (!issuers || !bonds) return <Loading error={err} />;

  async function setStatus(i, status) {
    setBusy(true);
    try {
      await api.setIssuerStatus(i.id, status); await load();
      flash(i.legalName + (status === "approved" ? " approved. They can register bonds now." : " suspended."));
    } catch (e) { flash(e.message); } finally { setBusy(false); }
  }
  const afterBondReview = async () => { await load(); flash("Review recorded."); };
  const signOut = async () => { await api.logout().catch(() => {}); setMe(null); loadMe(); };

  const pendingIssuers = issuers.filter((i) => i.status === "pending");
  const pendingBonds = bonds.filter((b) => b.review === "pending" && b.issuer.status === "approved");
  const waiting = pendingIssuers.length + pendingBonds.length;

  const shown = bonds.filter((b) =>
    (fStatus === "all" || b.review === fStatus) && (fIssuer === "all" || b.issuer.id === fIssuer));
  const live = bonds.filter((b) => b.review === "approved");

  const tabs = [["review", "Review"], ["issuers", "Issuers"], ["bonds", "Bond directory"], ["chain", "Chain"], ["staff", "Staff"]];
  const select = { fontFamily: sans, fontSize: 14, color: T.ink, background: T.white, border: "1px solid " + T.rule,
    borderRadius: 2, padding: "8px 10px", width: "100%" };

  return (
    <Shell width={760}>
      <div className="flex items-baseline justify-between gap-4">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: serif, fontSize: 21, color: T.ink, fontWeight: 500 }}>Platform</div>
          <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 2 }}>
            {me.user.name} · {me.user.role === "owner" ? "owner" : "staff"} · <TextLink onClick={signOut}><span style={{ fontSize: 12 }}>Sign out</span></TextLink>
          </div>
        </div>
        <div className="text-right" style={{ fontSize: 12, color: T.inkSoft, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
          {issuers.filter((i) => i.status === "approved").length} approved issuers
          <span style={{ display: "block" }}>{live.length} live bonds · {usd(live.reduce((t, b) => t + b.total, 0))}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 mt-4 mb-5" style={{ borderBottom: "1px solid " + T.rule }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ fontFamily: sans, fontSize: 14, color: tab === k ? T.ink : T.inkSoft, padding: "0 0 8px",
              borderBottom: "2px solid " + (tab === k ? T.ink : "transparent"), background: "none", cursor: "pointer" }}>
            {l}{k === "review" && waiting > 0 && <span style={{ color: T.red }}> · {waiting}</span>}
          </button>
        ))}
      </div>

      {tab === "review" && (
        <div>
          <Heading>Waiting for review</Heading>
          <Lede>
            Approving an issuer lets them register bonds. Each bond then comes back here; approving it lets the
            issuer issue against it and puts it on the public registry.
          </Lede>
          {waiting === 0 && (
            <div className="px-3 py-5 text-center" style={{ border: "1px solid " + T.rule, borderRadius: 2, fontSize: 14, color: T.inkSoft }}>
              Nothing waiting.
            </div>
          )}
          {pendingIssuers.length > 0 && (
            <>
              <div style={{ fontFamily: serif, fontSize: 18, color: T.ink, margin: "4px 0 10px" }}>Issuer applications</div>
              {pendingIssuers.map((i) => <IssuerCard key={i.id} i={i} onStatus={setStatus} busy={busy} />)}
            </>
          )}
          {pendingBonds.length > 0 && (
            <>
              <div style={{ fontFamily: serif, fontSize: 18, color: T.ink, margin: "14px 0 10px" }}>Bonds</div>
              {pendingBonds.map((b) => <BondReviewCard key={b.id} b={b} onDone={afterBondReview} />)}
            </>
          )}
        </div>
      )}

      {tab === "issuers" && (
        <div>
          <Heading>Issuers</Heading>
          <Lede>Suspending an issuer stops every change it could make. Its live records stay publicly verifiable.</Lede>
          {issuers.map((i) => <IssuerCard key={i.id} i={i} onStatus={setStatus} busy={busy} />)}
        </div>
      )}

      {tab === "bonds" && (
        <div>
          <Heading>Bond directory</Heading>
          <Lede>
            Every bond on the platform, with its units accounted for. Holder names and contact details stay
            between issuers and their holders and are not shown here.
          </Lede>
          <div className="flex flex-wrap gap-3 mb-4">
            <div style={{ flex: "1 1 200px" }}>
              <Label>Status</Label>
              <select id="filter-status" value={fStatus} onChange={(e) => setFStatus(e.target.value)} style={select}>
                <option value="all">All bonds</option>
                <option value="approved">Live</option>
                <option value="pending">Waiting for review</option>
                <option value="rejected">Not approved</option>
              </select>
            </div>
            <div style={{ flex: "1 1 200px" }}>
              <Label>Issuer</Label>
              <select id="filter-issuer" value={fIssuer} onChange={(e) => setFIssuer(e.target.value)} style={select}>
                <option value="all">All issuers</option>
                {issuers.map((i) => <option key={i.id} value={i.id}>{i.legalName} ({i.code})</option>)}
              </select>
            </div>
          </div>
          <div style={{ fontSize: 13, color: T.inkSoft, marginBottom: 12, fontVariantNumeric: "tabular-nums" }}>
            {shown.length} {shown.length === 1 ? "bond" : "bonds"} · {usd(shown.reduce((t, b) => t + b.total, 0))} total ·{" "}
            {usd(shown.reduce((t, b) => t + b.assigned, 0))} assigned to holders
          </div>
          {shown.length === 0 && <Note>No bonds match these filters.</Note>}
          {shown.map((b) => {
            const [tone, label] = BOND[b.review];
            return (
              <Card key={b.id}>
                <CardHead title={b.id + (b.title ? " · " + b.title : "")}
                  sub={b.issuer.legalName + (b.issuer.status === "suspended" ? " · issuer suspended" : "")}
                  chip={<Chip s={tone} text={label} />} />
                <BondFigures b={b} />
                <div className="mt-2">
                  <Rows data={[
                    ["Instrument hash", <Hash value={b.instrumentHash} />],
                    ...ucc1Rows(b),
                    b.legacyHash && ["Earlier second document", <Hash value={b.legacyHash} file={b.legacyFile} />],
                  ]} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {tab === "chain" && <ChainPanel me={me.user} flash={flash} />}
      {tab === "staff" && <StaffPanel me={me.user} />}

      {toast && (
        <div className="fixed left-0 right-0 flex justify-center px-4" style={{ bottom: 18, zIndex: 60 }}>
          <div className="px-4 py-3" style={{ background: T.ink, color: T.paper, borderRadius: 2,
            fontSize: 14, maxWidth: 520, fontFamily: sans, lineHeight: 1.5 }}>{toast}</div>
        </div>
      )}
    </Shell>
  );
}
