// The printable mailing packet for a new assignee: an instruction letter with the assignment's
// entries filled in, and the transfer code on a page of its own, to seal in its own envelope.
// It goes in the one certified mailing with the signed instrument. Opens in a new window and prints.

// Where assignees sign in: the assignee portal on the public registry site.
export const ASSIGNEE_SITE = (import.meta.env?.VITE_ASSIGNEE_SITE || "https://registry.omni-stance.com").replace(/\/+$/, "");

import QRCode from "qrcode";

/** The link a packet's QR code opens: the assignee portal with the assignment ID filled in. */
export const assigneeLink = (site, id) => site.replace(/\/+$/, "") + "/assignee?id=" + encodeURIComponent(id);

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const money = (cents) => "$" + (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDate = (d = new Date()) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/**
 * rec:   the assignment record (id, bond, units, party, contact, position, address, assignor, created, docHash, filingNumber)
 * code:  its transfer code (omit to print the letter alone)
 * bond:  the bond record (title, total), for the proportion
 * from:  who is sending it (the issuer for its own assignments, the assignor for an assign-out)
 * issuer: the issuer's name, for questions
 * site:  the assignee portal's base URL
 * days:  the response period
 */
export function packetHtml({ rec, code, bond, from, issuer, site = ASSIGNEE_SITE, days = 30, qr = "" }) {
  const portal = site + "/assignee";
  const share = bond?.total ? ((Number(rec.units) / Number(bond.total)) * 100).toFixed(6) + "%" : "—";
  const rows = [
    ["Assignment ID", rec.id],
    ["Bond", rec.bond + (bond?.title ? " · " + bond.title : "")],
    ["Amount assigned to you", money(rec.units)],
    ["Share of the bond", share],
    ["Assigned by", rec.assignor],
    ["Assigned to", rec.party],
    ["Attention of", [rec.contact, rec.position].filter(Boolean).join(", ") || "—"],
    ["Dated", rec.created || "—"],
    ["Signed instrument fingerprint (SHA-256)", rec.docHash || "—"],
    rec.filingNumber ? ["UCC-3 filing number", rec.filingNumber] : null,
  ].filter(Boolean);
  const steps = [
    `Scan the code at the top right with your phone's camera (your assignment ID fills in), or go to <b>${esc(portal)}</b> and enter <b>${esc(rec.id)}</b>, then choose Continue.`,
    `Open the sealed envelope marked <b>Transfer code</b> and enter the code it holds. It works once.`,
    `Set up your passkey when asked: your phone or computer (face, fingerprint or PIN), a password manager, or a security key such as a YubiKey or Trezor. From then on it is how you sign in and approve every action. Nobody else can act for you.`,
    `Review the assignment and check the amount against the signed instrument in this mailing.`,
    `Record your delivery receipt: the certified mail number, the date you received this, and a copy of the receipt (USPS confirmation or signed return receipt).`,
    `Accept the assignment, or reject it with a written reason of at least 255 characters. Either is confirmed with your passkey and recorded on the public blockchain.`,
  ];
  const letter = `
  <section class="page">
    <header>
      <div class="left">
        <div class="brand">Interest Registry</div>
      <div class="to">
        <div>${esc(rec.party)}</div>
        ${rec.contact ? `<div>Attn: ${esc([rec.contact, rec.position].filter(Boolean).join(", "))}</div>` : ""}
        ${rec.address ? `<div class="addr">${esc(rec.address)}</div>` : ""}
      </div>
      </div>
      <div class="meta">
        <div>${esc(longDate())}</div>
        ${qr ? `<div class="qr">${qr}</div><div class="qr-cap">Scan to open ${esc(rec.id)}</div>` : ""}
      </div>
    </header>
    <h1>Notice of assignment and instructions</h1>
    <p>${esc(from)} has assigned you an interest in bond ${esc(rec.bond)}; the signed instrument is enclosed. The assignment
      is recorded in the Interest Registry and on the public blockchain, where anyone can check it.</p>
    <table class="entries">
      ${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td${k.includes("fingerprint") ? ' class="mono small"' : ""}>${esc(v)}</td></tr>`).join("")}
    </table>
    <h2>What to do</h2>
    <ol>${steps.map((s) => `<li>${s}</li>`).join("")}</ol>
    <div class="callout">
      <b>Respond within ${esc(days)} days.</b> If you neither accept nor reject within ${esc(days)} days of the date this was
      sent (the date on your certified mail receipt), the assignment takes effect as if you had accepted it.
    </div>
    <h2>Good to know</h2>
    <ul>
      <li>Anyone can check this assignment without signing in: choose <b>Verify</b> at ${esc(portal)} and enter the assignment ID.
        You can check your copy of the instrument there too.</li>
      <li>Keep the transfer code private. It works once; after your passkey is set up it no longer opens the assignment.</li>
      <li>Lost your passkey? Contact ${esc(issuer)}; after confirming your identity they reset it and mail you a new transfer code.</li>
      <li>Once it's in effect you can assign portions onward from the same page, and record the UCC-3 for each.</li>
    </ul>
    <table class="keep">
      <tr><th>For your records:</th><td>Certified mail number</td><td class="blank"></td><td>Date received</td><td class="blank short"></td></tr>
    </table>
    <footer>${esc(rec.id)} · Sent by ${esc(from)} · Questions: ${esc(issuer)}</footer>
  </section>`;
  const codePage = code ? `
  <section class="page code-page">
    <div class="fold">Fold along this line and seal in its own envelope, marked “Transfer code”.</div>
    <div class="confidential">Confidential</div>
    <h1>Transfer code</h1>
    <table class="entries narrow">
      <tr><th>For</th><td>${esc(rec.party)}</td></tr>
      <tr><th>Assignment ID</th><td class="mono">${esc(rec.id)}</td></tr>
      <tr><th>Where to use it</th><td>${esc(portal)}</td></tr>
    </table>
    <div class="code">${esc(code)}</div>
    <ol>
      <li>Enter your assignment ID at ${esc(portal)}, then this code.</li>
      <li>Set up your passkey straight away. From then on this code no longer works.</li>
    </ol>
    <p class="small">It works once and only for this assignment. Don't share it, photograph it or send it by email.
      Anyone holding it before you set up your passkey could claim the assignment.</p>
    <footer>${esc(rec.id)} · Transfer code page</footer>
  </section>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(rec.id)} · Mailing packet</title>
<style>
  @page { size: letter; margin: 0.55in 0.65in; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, "Times New Roman", serif; color: #1B1F24; font-size: 10pt; line-height: 1.38; margin: 0; }
  .page { page-break-after: always; break-after: page; position: relative; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1.5px solid #1B1F24; padding-bottom: 5px; margin-bottom: 12px; }
  .brand { font-size: 15pt; letter-spacing: 0.02em; }
  .meta { font-family: Helvetica, Arial, sans-serif; font-size: 9.5pt; color: #4A515B; text-align: right; }
  .qr { width: 0.95in; height: 0.95in; margin: 6px 0 2px auto; } .qr svg { width: 100%; height: 100%; display: block; }
  .qr-cap { font-size: 7pt; color: #6B7280; }
  header { align-items: flex-start !important; }
  .to { font-family: Helvetica, Arial, sans-serif; font-size: 9.5pt; margin-top: 12px; }
  .addr { white-space: pre-line; }
  h1 { font-size: 14pt; font-weight: normal; margin: 0 0 5px; }
  h2 { font-size: 11.5pt; font-weight: normal; margin: 11px 0 4px; border-bottom: 1px solid #C9CDD2; padding-bottom: 2px; }
  p, li { font-size: 9.6pt; } p { margin: 0 0 8px; }
  ol, ul { margin: 3px 0; padding-left: 18px; } li { margin: 2px 0; }
  table { border-collapse: collapse; width: 100%; font-family: Helvetica, Arial, sans-serif; font-size: 8.8pt; }
  .entries th, .entries td { border: 1px solid #C9CDD2; padding: 2px 7px; text-align: left; vertical-align: top; }
  .entries th { width: 36%; font-weight: normal; color: #4A515B; background: #F4F5F3; }
  .entries.narrow th { width: 30%; }
  .mono { font-family: "Courier New", monospace; } .small { font-size: 8.5pt; word-break: break-all; }
  .callout { margin: 9px 0; padding: 6px 9px; border-left: 3px solid #8A6A1C; background: #F6F0E0; font-size: 9.5pt; }
  .keep { margin-top: 8px; } .keep th { text-align: left; padding: 7px 8px 2px 0; font-weight: normal; color: #4A515B; white-space: nowrap; } .keep td { white-space: nowrap; padding-right: 6px; }
  .keep td { padding: 7px 6px 2px 0; } .keep td.blank { border-bottom: 1px solid #1B1F24; width: 34%; } .keep td.short { width: 18%; }
  footer { margin-top: 12px; font-family: Helvetica, Arial, sans-serif; font-size: 7.5pt; color: #6B7280; border-top: 1px solid #C9CDD2; padding-top: 3px; }
  .fold { font-family: Helvetica, Arial, sans-serif; font-size: 8pt; color: #6B7280; text-align: center; border-bottom: 1px dashed #9AA0A6; padding-bottom: 4px; margin-bottom: 28px; }
  .confidential { font-family: Helvetica, Arial, sans-serif; text-transform: uppercase; letter-spacing: 0.18em; font-size: 9pt; color: #8B2A26; margin-bottom: 4px; }
  .code { margin: 28px 0; padding: 22px 10px; border: 2.5px solid #1B1F24; text-align: center; font-family: "Courier New", monospace; font-size: 30pt; letter-spacing: 0.12em; }
  @media screen { body { background: #E8EAEC; } .page { background: #fff; max-width: 8.5in; margin: 16px auto; padding: 0.7in 0.7in 1in; box-shadow: 0 1px 4px rgba(0,0,0,.15); } }
</style></head><body>${letter}${codePage}</body></html>`;
}

/** Opens the packet in a new window and asks the browser to print it. */
/** The QR code (an SVG) for an assignment's link. */
export const qrSvg = (text) => QRCode.toString(text, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#1B1F24", light: "#FFFFFF" } });

export function printPacket(opts) {
  // Opened straight away (in the click), then filled once the QR code is drawn, so pop-up blockers allow it.
  const w = window.open("", "_blank");
  if (!w) throw new Error("Your browser blocked the print window. Allow pop-ups for this site and try again.");
  w.document.write("<p style='font-family:sans-serif;padding:24px'>Preparing the mailing packet…</p>");
  const site = opts.site || ASSIGNEE_SITE;
  qrSvg(assigneeLink(site, opts.rec.id)).catch(() => "").then((qr) => {
    w.document.open();
    w.document.write(packetHtml({ ...opts, site, qr }));
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* the window stays open for printing by hand */ } }, 350);
  });
  return w;
}
