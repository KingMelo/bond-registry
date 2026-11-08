import React, { useCallback, useEffect, useState } from "react";
import IssuerConsole, { T, serif, sans, Label, Chip, Button, Field, Note } from "./issuer-console.jsx";
import { api, Loading } from "../src/registry.jsx";

/* ================================================================
   Issuer accounts around the console: sign in, create an issuer,
   join a team, and the Team tab. Reviews of issuers and bonds happen
   in the separate platform console.
   ================================================================ */

const STATUS_LABEL = { pending: "Waiting for approval", approved: "Approved", suspended: "Suspended" };

export function Shell({ children, width = 560 }) {
  return (
    <div style={{ background: T.paper, minHeight: "100%", fontFamily: sans }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Spectral:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid ${T.ink}; outline-offset: 1px; }
        input:focus, textarea:focus { border-color: ${T.ink} !important; }`}</style>
      <div className="mx-auto" style={{ maxWidth: width, padding: "20px 18px 56px" }}>{children}</div>
    </div>
  );
}

export const Heading = ({ children }) => (
  <h1 style={{ fontFamily: serif, fontSize: 25, color: T.ink, lineHeight: 1.25, margin: "0 0 8px" }}>{children}</h1>
);
export const Lede = ({ children }) => (
  <p style={{ color: T.inkSoft, fontSize: 14, lineHeight: 1.6, margin: "0 0 18px", maxWidth: "62ch" }}>{children}</p>
);
export const ErrorText = ({ children }) =>
  children ? <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, marginBottom: 14 }}>{children}</p> : null;

export function TextLink({ children, onClick }) {
  return (
    <button onClick={onClick} style={{ fontFamily: sans, fontSize: 14, color: T.ink, background: "none", border: "none",
      padding: 0, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>
      {children}
    </button>
  );
}

/* ---------------- signed out ---------------- */

/* ---------- password reset, shared by the issuer and platform consoles ---------- */

// The token from an emailed reset link (/?reset=…), if the page was opened from one.
export const resetToken = () => new URLSearchParams(window.location.search).get("reset");
const dropResetToken = () => window.history.replaceState(null, "", window.location.pathname);

export function ForgotPassword({ onBack }) {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  async function submit() {
    setBusy(true);
    try { await api.forgot(email.trim()); setSent(true); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  if (sent) return (
    <div>
      <Heading>Check your email</Heading>
      <Lede>
        If {email.trim()} has an account here, a link to choose a new password is on its way. It works
        once and expires in an hour. Nothing arrived? Check spam, then ask again after a minute.
      </Lede>
      <TextLink onClick={onBack}>Back to sign in</TextLink>
    </div>
  );
  return (
    <div>
      <Heading>Reset your password</Heading>
      <Lede>Enter the email you sign in with and we'll send you a link to choose a new password.</Lede>
      <Field label="Email" value={email} onChange={(v) => { setEmail(v); setErr(""); }} placeholder="you@example.com" autoComplete="email" />
      <ErrorText>{err}</ErrorText>
      <Button disabled={busy || !email.trim()} onClick={submit}>{busy ? "Sending…" : "Email me a reset link"}</Button>
      <div className="mt-4"><TextLink onClick={onBack}>Back to sign in</TextLink></div>
    </div>
  );
}

export function NewPassword({ token, onDone }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function submit() {
    if (pw !== pw2) return setErr("The two passwords don't match.");
    setBusy(true);
    try { await api.resetPassword(token, pw); setDone(true); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const finish = () => { dropResetToken(); onDone(); };
  if (done) return (
    <div>
      <Heading>Password changed</Heading>
      <Lede>Sign in with your new password. Any other signed-in sessions have been signed out.</Lede>
      <Button onClick={finish}>Go to sign in</Button>
    </div>
  );
  return (
    <div>
      <Heading>Choose a new password</Heading>
      <Lede>This link works once and expires an hour after it was sent.</Lede>
      <Field label="New password" value={pw} onChange={(v) => { setPw(v); setErr(""); }} type="password"
        autoComplete="new-password" hint="At least 10 characters." />
      <Field label="New password again" value={pw2} onChange={(v) => { setPw2(v); setErr(""); }} type="password"
        autoComplete="new-password" />
      <ErrorText>{err}</ErrorText>
      <Button disabled={busy || !pw || !pw2} onClick={submit}>{busy ? "Saving…" : "Save new password"}</Button>
      <div className="mt-4"><TextLink onClick={finish}>Back to sign in</TextLink></div>
    </div>
  );
}

function AuthScreens({ onDone }) {
  const [mode, setMode] = useState(resetToken() ? "reset" : "signin");
  const [f, setF] = useState({ email: "", password: "", name: "", legalName: "", issuerCode: "", inviteCode: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => { setF((x) => ({ ...x, [k]: v })); setErr(""); };
  const go = (m) => { setMode(m); setErr(""); };

  async function submit() {
    setBusy(true);
    try {
      if (mode === "signin") await api.login(f.email, f.password);
      if (mode === "signup") await api.signup({ email: f.email, password: f.password, name: f.name,
        legalName: f.legalName, issuerCode: f.issuerCode });
      if (mode === "join") await api.signup({ email: f.email, password: f.password, name: f.name, inviteCode: f.inviteCode });
      await onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const code = f.issuerCode.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
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
      <div style={{ fontFamily: serif, fontSize: 21, color: T.ink, fontWeight: 500, marginBottom: 22 }}>Registrar</div>

      {mode === "signin" && (
        <div>
          <Heading>Sign in</Heading>
          <Lede>The console for issuers registered on the interest registry.</Lede>
          <Field label="Email" value={f.email} onChange={set("email")} placeholder="you@example.com" autoComplete="email" />
          <Field label="Password" value={f.password} onChange={set("password")} type="password" autoComplete="current-password" />
          <ErrorText>{err}</ErrorText>
          <Button disabled={busy} onClick={submit}>{busy ? "Signing in…" : "Sign in"}</Button>
          <div className="mt-5 space-y-2" style={{ fontSize: 14, color: T.inkSoft }}>
            <div>Forgot your password? <TextLink onClick={() => go("forgot")}>Reset it</TextLink></div>
            <div>New issuer? <TextLink onClick={() => go("signup")}>Create an issuer account</TextLink></div>
            <div>Joining a team? <TextLink onClick={() => go("join")}>Use an invite code</TextLink></div>
          </div>
        </div>
      )}

      {mode === "forgot" && <ForgotPassword onBack={() => go("signin")} />}
      {mode === "reset" && <NewPassword token={resetToken()} onDone={() => go("signin")} />}

      {mode === "signup" && (
        <div>
          <Heading>Create an issuer account</Heading>
          <Lede>
            You'll be the issuer's owner. The platform reviews each new issuer before it can register
            bonds, and then reviews each bond before anything is issued or shown on the public registry.
          </Lede>
          <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, margin: "4px 0 12px" }}>Issuer</div>
          <Field label="Legal name" value={f.legalName} onChange={set("legalName")} placeholder="Acme Capital Trust" />
          <Field label="Issuer code" value={code} onChange={set("issuerCode")} placeholder="ACME" mono
            hint={"3 to 6 letters or digits, permanent. Your bonds will be numbered " + (code || "ACME") + "-0001-BD, "
              + (code || "ACME") + "-0002-BD and so on."} />
          <div style={{ fontFamily: serif, fontSize: 17, color: T.ink, margin: "8px 0 12px" }}>You</div>
          {you}
          <ErrorText>{err}</ErrorText>
          <Button disabled={busy} onClick={submit}>{busy ? "Creating…" : "Create issuer account"}</Button>
          <div className="mt-4"><TextLink onClick={() => go("signin")}>Back to sign in</TextLink></div>
        </div>
      )}

      {mode === "join" && (
        <div>
          <Heading>Join your issuer's team</Heading>
          <Lede>Your issuer's owner creates an invite code in their Team tab. Each code works once and lasts seven days.</Lede>
          <Field label="Invite code" value={f.inviteCode} onChange={set("inviteCode")} placeholder="XXXX-XXXX-XXXX" mono />
          {you}
          <ErrorText>{err}</ErrorText>
          <Button disabled={busy} onClick={submit}>{busy ? "Joining…" : "Join the team"}</Button>
          <div className="mt-4"><TextLink onClick={() => go("signin")}>Back to sign in</TextLink></div>
        </div>
      )}

    </Shell>
  );
}

/* ---------------- another issuer ---------------- */

// For someone already signed in: start an issuer without a new account.
function NewIssuer({ me, onDone, onCancel }) {
  const [legalName, setLegalName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  async function submit() {
    setBusy(true); setErr("");
    try { const r = await api.createIssuer(legalName, clean); await onDone(r.id); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div>
      <Heading>Create an issuer</Heading>
      <Lede>
        {me.user.platformOwner
          ? "You're the platform owner, so this issuer is approved straight away and its bonds go live as soon as you register them."
          : "You'll be its owner. The platform reviews each new issuer before it can register bonds, and then each bond."}
      </Lede>
      <Field label="Legal name" value={legalName} onChange={(v) => { setLegalName(v); setErr(""); }} placeholder="Acme Capital Trust" />
      <Field label="Issuer code" value={clean} onChange={(v) => { setCode(v); setErr(""); }} placeholder="ACME" mono
        hint={"3 to 6 letters or digits, permanent. Bonds will be numbered " + (clean || "ACME") + "-0001-BD and so on."} />
      <ErrorText>{err}</ErrorText>
      <Button disabled={busy} onClick={submit}>{busy ? "Creating…" : "Create issuer"}</Button>
      {onCancel && <div className="mt-3"><Button variant="quiet" onClick={onCancel}>Cancel</Button></div>}
    </div>
  );
}

/* ---------------- team ---------------- */

function TeamPanel({ issuer }) {
  const [members, setMembers] = useState(null);
  const [invite, setInvite] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.team(issuer.id).then((r) => setMembers(r.members)).catch((e) => setErr(e.message));
  }, [issuer.id, invite]);

  async function makeInvite() {
    setErr("");
    try { setInvite(await api.invite(issuer.id)); } catch (e) { setErr(e.message); }
  }

  return (
    <div>
      <Heading>Team</Heading>
      <Lede>
        Everyone on {issuer.legalName}'s team can act in this console. When the 2-of-3 multisig is
        connected, each signer will be a team member.
      </Lede>
      {members && (
        <div style={{ border: "1px solid " + T.rule, borderRadius: 2 }}>
          {members.map((m, i) => (
            <div key={m.email} className="flex justify-between items-center gap-3 px-3 py-2"
              style={{ background: i % 2 ? T.band : T.white, fontSize: 14 }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ color: T.ink }}>{m.name}</span>
                <span style={{ display: "block", fontSize: 12, color: T.inkSoft, wordBreak: "break-all" }}>{m.email}</span>
              </span>
              <Chip s={m.role === "owner" ? "Accepted" : "Superseded"} text={m.role === "owner" ? "Owner" : "Member"} />
            </div>
          ))}
        </div>
      )}
      <ErrorText>{err}</ErrorText>
      {issuer.role === "owner" && (
        <div className="mt-4">
          {invite ? (
            <div>
              <Label>Invite code</Label>
              <div className="px-3 py-4 mb-3 text-center" style={{ border: "2px solid " + T.ink, borderRadius: 2, background: T.white,
                fontSize: 22, letterSpacing: "0.08em", color: T.ink, fontVariantNumeric: "tabular-nums", userSelect: "all" }}>
                {invite.code}
              </div>
              <Note kind="caution">
                Shown once. Give it to your teammate yourself; it works once and expires in {invite.expiresInDays} days.
                They choose <strong style={{ fontWeight: 600 }}>Use an invite code</strong> on the sign-in page.
              </Note>
              <div className="mt-3"><Button variant="quiet" onClick={() => setInvite(null)}>Done</Button></div>
            </div>
          ) : (
            <Button variant="quiet" onClick={makeInvite}>Invite a teammate</Button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- signed in ---------------- */

const REMEMBER = "registrar:issuer";
const remembered = () => { try { return localStorage.getItem(REMEMBER); } catch { return null; } };
const remember = (id) => { try { localStorage.setItem(REMEMBER, id); } catch { /* not available */ } };

export default function IssuerApp() {
  const [me, setMe] = useState(null);
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState(remembered);
  const [creating, setCreating] = useState(false);

  const loadMe = useCallback(() => api.me().then(setMe).catch((e) => setErr(e.message)), []);
  useEffect(() => { loadMe(); }, [loadMe]);

  if (!me) return <Loading error={err} />;
  if (!me.user || resetToken()) return <AuthScreens onDone={loadMe} />;

  const issuer = me.issuers.find((i) => i.id === picked) || me.issuers[0];
  const signOut = async () => { await api.logout().catch(() => {}); setMe(null); loadMe(); };
  const choose = (id) => { setPicked(id); remember(id); };

  const header = (
    <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 2, lineHeight: 1.5 }}>
      <span style={{ color: T.ink }}>{issuer ? issuer.legalName : me.user.email}</span>
      {issuer && issuer.status !== "approved" && <span> · {STATUS_LABEL[issuer.status].toLowerCase()}</span>}
      <span style={{ display: "block" }}>
        {me.user.name}
        {me.issuers.length > 1 && (
          <>
            {" · "}
            <select value={issuer.id} onChange={(e) => choose(e.target.value)} aria-label="Switch issuer"
              style={{ fontFamily: sans, fontSize: 12, color: T.ink, background: T.paper, border: "1px solid " + T.rule, borderRadius: 2 }}>
              {me.issuers.map((i) => <option key={i.id} value={i.id}>{i.code}</option>)}
            </select>
          </>
        )}
        {issuer && <>{" · "}<TextLink onClick={() => setCreating(true)}><span style={{ fontSize: 12 }}>New issuer</span></TextLink></>}
        {" · "}<TextLink onClick={signOut}><span style={{ fontSize: 12 }}>Sign out</span></TextLink>
      </span>
    </div>
  );

  const created = async (id) => { choose(id); setCreating(false); await loadMe(); };
  if (!issuer || creating) {
    return (
      <Shell>
        <div style={{ fontFamily: serif, fontSize: 21, color: T.ink, fontWeight: 500 }}>Registrar</div>
        {header}
        <div className="mt-5">
          {!issuer && !me.user.platformOwner && (
            <div className="mb-4">
              <Note>This account isn't part of an issuer yet. Create one below, or ask an issuer's owner for an invite code.</Note>
            </div>
          )}
          <NewIssuer me={me} onDone={created} onCancel={issuer ? () => setCreating(false) : null} />
        </div>
      </Shell>
    );
  }

  const extraTabs = [["team", "Team", () => <TeamPanel issuer={issuer} />]];

  return <IssuerConsole key={issuer.id} issuerId={issuer.id} header={header} extraTabs={extraTabs}
    onIssuerStatus={(st) => { if (st !== issuer.status) loadMe(); }} />;
}
