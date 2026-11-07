import React, { useCallback, useEffect, useState } from "react";
import IssuerConsole, { T, serif, sans, Label, Chip, Button, Field, Rows, Note } from "./issuer-console.jsx";
import { api, Loading } from "../src/registry.jsx";

/* ================================================================
   Issuer accounts around the console: sign in, create an issuer,
   join a team, the one-time platform owner setup, the Team tab,
   and the platform owner's review of new issuers.
   ================================================================ */

const STATUS_LABEL = { pending: "Waiting for approval", approved: "Approved", suspended: "Suspended" };
const statusTone = { pending: "Issued", approved: "Accepted", suspended: "Locked" };

function Shell({ children }) {
  return (
    <div style={{ background: T.paper, minHeight: "100%", fontFamily: sans }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Spectral:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid ${T.ink}; outline-offset: 1px; }
        input:focus, textarea:focus { border-color: ${T.ink} !important; }`}</style>
      <div className="mx-auto" style={{ maxWidth: 560, padding: "20px 18px 56px" }}>{children}</div>
    </div>
  );
}

const Heading = ({ children }) => (
  <h1 style={{ fontFamily: serif, fontSize: 25, color: T.ink, lineHeight: 1.25, margin: "0 0 8px" }}>{children}</h1>
);
const Lede = ({ children }) => (
  <p style={{ color: T.inkSoft, fontSize: 14, lineHeight: 1.6, margin: "0 0 18px", maxWidth: "62ch" }}>{children}</p>
);
const ErrorText = ({ children }) =>
  children ? <p style={{ color: T.red, fontSize: 14, lineHeight: 1.55, marginBottom: 14 }}>{children}</p> : null;

function TextLink({ children, onClick }) {
  return (
    <button onClick={onClick} style={{ fontFamily: sans, fontSize: 14, color: T.ink, background: "none", border: "none",
      padding: 0, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>
      {children}
    </button>
  );
}

/* ---------------- signed out ---------------- */

function AuthScreens({ needsSetup, onDone }) {
  const [mode, setMode] = useState("signin");
  const [f, setF] = useState({ email: "", password: "", name: "", legalName: "", issuerCode: "", inviteCode: "", setupCode: "" });
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
      if (mode === "setup") await api.setup({ email: f.email, password: f.password, name: f.name, setupCode: f.setupCode });
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
            <div>New issuer? <TextLink onClick={() => go("signup")}>Create an issuer account</TextLink></div>
            <div>Joining a team? <TextLink onClick={() => go("join")}>Use an invite code</TextLink></div>
            {needsSetup && <div>First time on this platform? <TextLink onClick={() => go("setup")}>Set up the platform owner</TextLink></div>}
          </div>
        </div>
      )}

      {mode === "signup" && (
        <div>
          <Heading>Create an issuer account</Heading>
          <Lede>
            You'll be the issuer's owner. The platform owner reviews each new issuer; until then you can
            register bonds and record prior instruments, and nothing appears on the public registry.
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

      {mode === "setup" && (
        <div>
          <Heading>Set up the platform owner</Heading>
          <Lede>
            Done once. The platform owner approves new issuers and takes over the sample register.
            The setup code is the ADMIN_SETUP_CODE set on this service in Railway.
          </Lede>
          <Field label="Setup code" value={f.setupCode} onChange={set("setupCode")} type="password" autoComplete="off" />
          {you}
          <ErrorText>{err}</ErrorText>
          <Button disabled={busy} onClick={submit}>{busy ? "Setting up…" : "Create platform owner account"}</Button>
          <div className="mt-4"><TextLink onClick={() => go("signin")}>Back to sign in</TextLink></div>
        </div>
      )}
    </Shell>
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

/* ---------------- platform owner ---------------- */

function PlatformPanel({ onChanged }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => api.adminIssuers().then((r) => setList(r.issuers)).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function setStatus(i, status) {
    setErr("");
    try { await api.setIssuerStatus(i.id, status); await load(); onChanged?.(); } catch (e) { setErr(e.message); }
  }

  const pending = list?.filter((i) => i.status === "pending").length || 0;
  return (
    <div>
      <Heading>Issuers on the platform</Heading>
      <Lede>
        New issuers wait here for your review. Approving one lets it issue assignments and puts its bonds on
        the public registry. Suspending stops all changes; its records stay publicly verifiable.
      </Lede>
      <ErrorText>{err}</ErrorText>
      {list && list.length === 0 && <Note>No issuers yet.</Note>}
      {list?.map((i) => (
        <div key={i.id} className="px-3 py-3 mb-2"
          style={{ background: T.white, border: "1px solid " + (i.status === "pending" ? T.amber : T.rule), borderRadius: 2 }}>
          <div className="flex justify-between items-baseline gap-3">
            <span style={{ fontSize: 15, color: T.ink, fontWeight: 500, minWidth: 0 }}>{i.legalName}</span>
            <Chip s={statusTone[i.status]} text={STATUS_LABEL[i.status]} />
          </div>
          <div className="mt-2">
            <Rows data={[
              ["Issuer code", i.code],
              ["Owner", i.ownerName ? i.ownerName + " · " + i.ownerEmail : "—"],
              ["Team", i.members + (i.members === 1 ? " person" : " people")],
              ["Bonds", String(i.bonds)],
              ["Signed up", new Date(i.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })],
            ]} />
          </div>
          <div className="mt-3 flex gap-3">
            {i.status !== "approved" && <Button onClick={() => setStatus(i, "approved")}>{i.status === "suspended" ? "Reinstate" : "Approve"}</Button>}
            {i.status !== "suspended" && <Button variant="quiet" danger onClick={() => setStatus(i, "suspended")}>Suspend</Button>}
          </div>
        </div>
      ))}
      {pending > 0 && <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 8 }}>{pending} waiting for review.</div>}
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

  const loadMe = useCallback(() => api.me().then(setMe).catch((e) => setErr(e.message)), []);
  useEffect(() => { loadMe(); }, [loadMe]);

  if (!me) return <Loading error={err} />;
  if (!me.user) return <AuthScreens needsSetup={me.needsSetup} onDone={loadMe} />;

  const issuer = me.issuers.find((i) => i.id === picked) || me.issuers[0];
  const signOut = async () => { await api.logout().catch(() => {}); setMe(null); loadMe(); };
  const choose = (id) => { setPicked(id); remember(id); };

  const header = (
    <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 2, lineHeight: 1.5 }}>
      <span style={{ color: T.ink }}>{issuer ? issuer.legalName : "Platform owner"}</span>
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
        {" · "}<TextLink onClick={signOut}><span style={{ fontSize: 12 }}>Sign out</span></TextLink>
      </span>
    </div>
  );

  if (!issuer) {
    // A platform owner with no issuer of their own sees only the review list.
    return (
      <Shell>
        <div style={{ fontFamily: serif, fontSize: 21, color: T.ink, fontWeight: 500 }}>Registrar</div>
        {header}
        <div className="mt-5">
          {me.user.isAdmin ? <PlatformPanel /> : (
            <Note>Your account isn't part of an issuer. Ask your issuer's owner for an invite code.</Note>
          )}
        </div>
      </Shell>
    );
  }

  const extraTabs = [["team", "Team", () => <TeamPanel issuer={issuer} />]];
  if (me.user.isAdmin)
    extraTabs.push(["platform", "Platform", () => <PlatformPanel onChanged={loadMe} />]);

  return <IssuerConsole key={issuer.id} issuerId={issuer.id} header={header} extraTabs={extraTabs} />;
}
