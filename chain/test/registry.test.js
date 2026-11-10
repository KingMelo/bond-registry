const { expect } = require("chai");
const { ethers } = require("hardhat");
const { withHolders, NOAUTH } = require("./webauthn");

const id = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const h = (s) => ethers.sha256(ethers.toUtf8Bytes(s)); // stands in for a document's SHA-256
const Z = ethers.ZeroHash;
const S = { None: 0, AwaitingCredential: 1, CredentialRequested: 2, Issued: 3, Accepted: 4, Locked: 5,
  PendingRedemption: 6, Redeemed: 7, Superseded: 8, Cancelled: 9, Rejected: 10 };
const O = { Issuer: 0, AssignOut: 1, Replacement: 2 };

const ISS = id("KPII"), OTHER = id("ACME");
const BOND = id("KPII-0001-BD"), BOND2 = id("ACME-0001-BD");
const A1 = id("KPII-0001-BD-A00001"), A2 = id("KPII-0001-BD-A00002"), A3 = id("KPII-0001-BD-A00003");
const C1 = id("KPII-0001-BD-A00004"), C2 = id("KPII-0001-BD-A00005");
const TOTAL = 10_000_000_000n; // the test bond: $100,000,000.00 in cents

async function setup() {
  const [admin, platform, relayer, guardian, issuer, other, stranger] = await ethers.getSigners();
  const R = await ethers.getContractFactory("BondInterestRegistry");
  const reg = await R.deploy(admin.address, platform.address, relayer.address, guardian.address, ethers.ZeroAddress);
  await reg.connect(platform).registerIssuer(ISS, issuer.address);
  await reg.connect(platform).registerIssuer(OTHER, other.address);
  await reg.connect(issuer).anchorBond(BOND, ISS, TOTAL, h("instrument"), h("ucc1"));
  await reg.connect(other).anchorBond(BOND2, OTHER, TOTAL, h("instrument2"), h("ucc1-2"));
  const I = reg.connect(issuer), RL = withHolders(reg, relayer);
  return { reg, I, RL, admin, platform, relayer, guardian, issuer, other, stranger };
}

async function status(reg, a) { return Number((await reg.assignments(a)).status); }
async function totals(reg, b = BOND) {
  const t = await reg.bondTotals(b);
  return { total: t[0], prior: t[1], live: t[2], unassigned: t[3], redeemed: t[4], reconciled: t[5] };
}
/** Issued and accepted by its holder. */
async function accepted(I, RL, a, units) {
  await I.issueAssignment(BOND, a, units, h("doc " + a));
  await RL.accept(BOND, a, h("accept " + a));
}

describe("BondInterestRegistry", () => {
  describe("setup and roles", () => {
    it("grants each role to its own address", async () => {
      const { reg, admin, platform, relayer, guardian } = await setup();
      expect(await reg.hasRole(await reg.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await reg.hasRole(await reg.PLATFORM_ROLE(), platform.address)).to.equal(true);
      expect(await reg.hasRole(await reg.RELAYER_ROLE(), relayer.address)).to.equal(true);
      expect(await reg.hasRole(await reg.GUARDIAN_ROLE(), guardian.address)).to.equal(true);
    });

    it("refuses a zero address in the constructor", async () => {
      const [a] = await ethers.getSigners();
      const R = await ethers.getContractFactory("BondInterestRegistry");
      await expect(R.deploy(a.address, ethers.ZeroAddress, a.address, a.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(R, "ZeroAddress");
    });

    it("only the platform registers issuers, once each", async () => {
      const { reg, platform, stranger } = await setup();
      await expect(reg.connect(stranger).registerIssuer(id("NEW"), stranger.address)).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
      await expect(reg.connect(platform).registerIssuer(ISS, stranger.address)).to.be.revertedWithCustomError(reg, "IssuerExists");
      await expect(reg.connect(platform).registerIssuer(id("NEW"), ethers.ZeroAddress)).to.be.revertedWithCustomError(reg, "ZeroAddress");
    });

    it("an issuer moves its own account; the old address loses access", async () => {
      const { reg, issuer, stranger } = await setup();
      await expect(reg.connect(issuer).setIssuerAccount(ISS, stranger.address, h("signer change")))
        .to.emit(reg, "IssuerAccountChanged").withArgs(ISS, stranger.address, h("signer change"));
      await expect(reg.connect(issuer).issueAssignment(BOND, A1, 100, h("d"))).to.be.revertedWithCustomError(reg, "NotIssuer");
      await reg.connect(stranger).issueAssignment(BOND, A1, 100, h("d"));
      // and only the new account can move it again
      await expect(reg.connect(issuer).setIssuerAccount(ISS, issuer.address, h("take back"))).to.be.revertedWithCustomError(reg, "NotIssuer");
    });

    it("nobody else can move an issuer's account: not the platform, admin, relayer or another issuer", async () => {
      const { reg, admin, platform, relayer, guardian, stranger } = await setup();
      for (const who of [platform, admin, relayer, guardian, stranger])
        await expect(reg.connect(who).setIssuerAccount(ISS, who.address, h("takeover"))).to.be.revertedWithCustomError(reg, "NotIssuer");
      // even an account holding every role
      await reg.connect(admin).grantRole(await reg.PLATFORM_ROLE(), admin.address);
      await expect(reg.connect(admin).setIssuerAccount(ISS, admin.address, h("takeover"))).to.be.revertedWithCustomError(reg, "NotIssuer");
      await expect(reg.connect(stranger).setIssuerAccount(id("NOPE"), stranger.address, h("x"))).to.be.revertedWithCustomError(reg, "UnknownIssuer");
    });

    it("a suspended issuer can rotate its account, and stays suspended", async () => {
      const { reg, platform, issuer, stranger } = await setup();
      await reg.connect(platform).suspendIssuer(ISS, h("suspend"));
      await reg.connect(issuer).setIssuerAccount(ISS, stranger.address, h("rotate"));
      expect((await reg.issuers(ISS)).suspended).to.equal(true);
      await expect(reg.connect(stranger).issueAssignment(BOND, A1, 100, h("d"))).to.be.revertedWithCustomError(reg, "IssuerIsSuspended");
    });

    it("moving an account needs a document hash and a real address", async () => {
      const { reg, issuer } = await setup();
      await expect(reg.connect(issuer).setIssuerAccount(ISS, issuer.address, ethers.ZeroHash)).to.be.revertedWithCustomError(reg, "ZeroHash");
      await expect(reg.connect(issuer).setIssuerAccount(ISS, ethers.ZeroAddress, h("x"))).to.be.revertedWithCustomError(reg, "ZeroAddress");
    });

    it("the relayer can't act as an issuer, and an issuer can't act as the relayer", async () => {
      const { reg, I, RL } = await setup();
      await expect(RL.issueAssignment(BOND, A1, 100, h("d"))).to.be.revertedWithCustomError(reg, "NotIssuer");
      await I.issueAssignment(BOND, A1, 100, h("d"));
      await expect(I.accept(BOND, A1, h("a"), NOAUTH)).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
    });

    it("an issuer can't touch another issuer's bonds", async () => {
      const { reg, I } = await setup();
      await expect(I.issueAssignment(BOND2, A1, 100, h("d"))).to.be.revertedWithCustomError(reg, "NotIssuer");
      await expect(I.anchorBond(id("ACME-0002-BD"), OTHER, 1, h("i"), h("u"))).to.be.revertedWithCustomError(reg, "NotIssuer");
    });
  });

  describe("anchoring", () => {
    it("records the bond with every unit unassigned", async () => {
      const { reg } = await setup();
      const t = await totals(reg);
      expect([t.total, t.unassigned, t.live, t.prior, t.redeemed, t.reconciled]).to.deep.equal([TOTAL, TOTAL, 0n, 0n, 0n, true]);
      const b = await reg.bonds(BOND);
      expect(b.issuerId).to.equal(ISS);
      expect(b.instrumentHash).to.equal(h("instrument"));
      expect(b.ucc1Ref).to.equal(h("ucc1"));
    });

    it("emits BondAnchored", async () => {
      const { reg, I, issuer } = await setup();
      const B = id("KPII-0002-BD");
      await expect(I.anchorBond(B, ISS, 942887, h("i"), h("u")))
        .to.emit(reg, "BondAnchored").withArgs(B, ISS, 942887, h("i"), h("u"), issuer.address);
    });

    it("refuses a second anchor, a zero total, and a missing instrument or UCC-1", async () => {
      const { reg, I } = await setup();
      await expect(I.anchorBond(BOND, ISS, 1, h("i"), h("u"))).to.be.revertedWithCustomError(reg, "BondExists");
      await expect(I.anchorBond(id("B"), ISS, 0, h("i"), h("u"))).to.be.revertedWithCustomError(reg, "ZeroUnits");
      await expect(I.anchorBond(id("B"), ISS, 1, Z, h("u"))).to.be.revertedWithCustomError(reg, "ZeroHash");
      await expect(I.anchorBond(id("B"), ISS, 1, h("i"), Z)).to.be.revertedWithCustomError(reg, "ZeroHash");
      await expect(I.anchorBond(Z, ISS, 1, h("i"), h("u"))).to.be.revertedWithCustomError(reg, "ZeroId");
    });

    it("refuses an unregistered issuer", async () => {
      const { reg, stranger } = await setup();
      await expect(reg.connect(stranger).anchorBond(id("B"), id("NOPE"), 1, h("i"), h("u"))).to.be.revertedWithCustomError(reg, "UnknownIssuer");
    });
  });

  describe("amounts in cents", () => {
    it("takes $10.40 off a $100,000,000.00 bond exactly", async () => {
      const { reg, I, RL } = await setup();
      const cents = (dollars) => BigInt(Math.round(Number(dollars) * 100)); // "10.40" -> 1040
      await I.recordPriorInstrument(BOND, id("PN-1040"), cents("10.40"), h("e"));
      await accepted(I, RL, A1, cents("9428.87"));
      await RL.assignOut(BOND, A1, C1, cents("10.40"), h("d"));
      const t = await totals(reg);
      expect(t.prior).to.equal(1040n);                          // $10.40
      expect((await reg.assignments(A1)).units).to.equal(941847n); // $9,428.87 - $10.40 = $9,418.47
      expect((await reg.assignments(C1)).units).to.equal(1040n);   // $10.40
      expect(t.unassigned).to.equal(TOTAL - 1040n - 942887n);     // $99,990,560.73
      expect(t.reconciled).to.equal(true);
    });
  });

  describe("prior instruments", () => {
    it("takes the units off the bond and refuses a duplicate", async () => {
      const { reg, I, issuer } = await setup();
      const ref = id("PN-2024-007");
      await expect(I.recordPriorInstrument(BOND, ref, 942887, h("entry")))
        .to.emit(reg, "PriorInstrumentRecorded").withArgs(BOND, ref, 942887, h("entry"), issuer.address);
      const t = await totals(reg);
      expect(t.prior).to.equal(942887n);
      expect(t.unassigned).to.equal(TOTAL - 942887n);
      expect(t.reconciled).to.equal(true);
      await expect(I.recordPriorInstrument(BOND, ref, 1, h("again"))).to.be.revertedWithCustomError(reg, "PriorExists");
    });

    it("refuses more than the unassigned balance, zero units and zero hashes", async () => {
      const { reg, I } = await setup();
      await expect(I.recordPriorInstrument(BOND, id("PN"), TOTAL + 1n, h("e"))).to.be.revertedWithCustomError(reg, "NotEnoughUnits");
      await expect(I.recordPriorInstrument(BOND, id("PN"), 0, h("e"))).to.be.revertedWithCustomError(reg, "ZeroUnits");
      await expect(I.recordPriorInstrument(BOND, Z, 1, h("e"))).to.be.revertedWithCustomError(reg, "ZeroHash");
      await expect(I.recordPriorInstrument(BOND, id("PN"), 1, Z)).to.be.revertedWithCustomError(reg, "ZeroHash");
    });

    it("a reversal returns the units once; the entry stays, marked reversed", async () => {
      const { reg, I } = await setup();
      const ref = id("PN-1");
      await I.recordPriorInstrument(BOND, ref, 5000, h("e"));
      await expect(I.reversePriorInstrument(BOND, ref, h("entered in error"))).to.emit(reg, "PriorInstrumentReversed");
      const p = await reg.priorInstruments(BOND, ref);
      expect([p.units, p.recorded, p.reversed]).to.deep.equal([5000n, true, true]);
      expect((await totals(reg)).unassigned).to.equal(TOTAL);
      await expect(I.reversePriorInstrument(BOND, ref, h("again"))).to.be.revertedWithCustomError(reg, "PriorAlreadyReversed");
      await expect(I.reversePriorInstrument(BOND, id("PN-404"), h("r"))).to.be.revertedWithCustomError(reg, "UnknownPrior");
      await expect(I.recordPriorInstrument(BOND, ref, 1, h("e"))).to.be.revertedWithCustomError(reg, "PriorExists");
    });
  });

  describe("issuing and accepting", () => {
    it("issue moves units from unassigned to live; accept by the relayer", async () => {
      const { reg, I, RL } = await setup();
      await expect(I.issueAssignment(BOND, A1, 200000, h("doc"))).to.emit(reg, "AssignmentIssued");
      let a = await reg.assignments(A1);
      expect([Number(a.status), Number(a.origin), a.units, a.parentId, a.docHash]).to.deep.equal([S.Issued, O.Issuer, 200000n, Z, h("doc")]);
      const t = await totals(reg);
      expect([t.live, t.unassigned]).to.deep.equal([200000n, TOTAL - 200000n]);
      await expect(RL.accept(BOND, A1, h("acc"))).to.emit(reg, "Accepted");
      expect(await status(reg, A1)).to.equal(S.Accepted);
    });

    it("refuses a duplicate ID, zero units, too many units, a zero ID or hash", async () => {
      const { reg, I } = await setup();
      await I.issueAssignment(BOND, A1, 1, h("d"));
      await expect(I.issueAssignment(BOND, A1, 1, h("d"))).to.be.revertedWithCustomError(reg, "RecordExists");
      await expect(I.issueAssignment(BOND, A2, 0, h("d"))).to.be.revertedWithCustomError(reg, "ZeroUnits");
      await expect(I.issueAssignment(BOND, A2, TOTAL, h("d"))).to.be.revertedWithCustomError(reg, "NotEnoughUnits");
      await expect(I.issueAssignment(BOND, Z, 1, h("d"))).to.be.revertedWithCustomError(reg, "ZeroId");
      await expect(I.issueAssignment(BOND, A2, 1, Z)).to.be.revertedWithCustomError(reg, "ZeroHash");
    });

    it("an ID can't be reused across bonds", async () => {
      const { reg, I, other } = await setup();
      await I.issueAssignment(BOND, A1, 1, h("d"));
      await expect(reg.connect(other).issueAssignment(BOND2, A1, 1, h("d"))).to.be.revertedWithCustomError(reg, "RecordExists");
    });

    it("accept only from Issued, on the right bond", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 100);
      await expect(RL.accept(BOND, A1, h("a"))).to.be.revertedWithCustomError(reg, "WrongStatus");
      await expect(RL.accept(BOND, A2, h("a"))).to.be.revertedWithCustomError(reg, "UnknownRecord");
      await I.issueAssignment(BOND, A2, 100, h("d"));
      await expect(RL.accept(BOND2, A2, h("a"))).to.be.revertedWithCustomError(reg, "WrongBond");
    });

    it("delivery and filing references are stored without changing status", async () => {
      const { reg, I } = await setup();
      await I.issueAssignment(BOND, A1, 100, h("d"));
      await expect(I.setDeliveryRef(BOND, A1, h("mail"), 1)).to.emit(reg, "DeliveryRecorded");
      await expect(I.setFilingRef(BOND, A1, h("ucc3"))).to.emit(reg, "FilingRecorded");
      const a = await reg.assignments(A1);
      expect([a.deliveryRef, a.filingRef, Number(a.status)]).to.deep.equal([h("mail"), h("ucc3"), S.Issued]);
      await expect(I.setFilingRef(BOND, A1, Z)).to.be.revertedWithCustomError(reg, "ZeroHash");
    });
  });

  describe("assign out", () => {
    async function withChild() {
      const ctx = await setup();
      await accepted(ctx.I, ctx.RL, A1, 200000);
      await ctx.RL.assignOut(BOND, A1, C1, 30000, h("assignment to D"));
      return ctx;
    }

    it("moves units to a child that's open to its assignee at once, and counts it as pending", async () => {
      const { reg } = await withChild();
      const p = await reg.assignments(A1), c = await reg.assignments(C1);
      expect([p.units, p.pendingChildren, Number(p.status)]).to.deep.equal([170000n, 1n, S.Accepted]);
      expect([c.units, Number(c.status), Number(c.origin), c.parentId]).to.deep.equal([30000n, S.Issued, O.AssignOut, A1]);
      expect((await totals(reg)).live).to.equal(200000n);
    });

    it("refuses more than the parent holds, zero units, and a parent that isn't Accepted", async () => {
      const { reg, I, RL } = await withChild();
      await expect(RL.assignOut(BOND, A1, C2, 170001, h("d"))).to.be.revertedWithCustomError(reg, "NotEnoughUnits");
      await expect(RL.assignOut(BOND, A1, C2, 0, h("d"))).to.be.revertedWithCustomError(reg, "ZeroUnits");
      await expect(RL.assignOut(BOND, C1, C2, 1, h("d"))).to.be.revertedWithCustomError(reg, "WrongStatus");
      await I.issueAssignment(BOND, A2, 100, h("d"));
      await expect(RL.assignOut(BOND, A2, C2, 1, h("d"))).to.be.revertedWithCustomError(reg, "WrongStatus");
    });

    it("the new holder claims it and accepts, with no issuer step in between", async () => {
      const { reg, RL } = await withChild();
      await RL.accept(BOND, C1, h("acc")); // the helper sets up the assignee's device, then signs
      expect(await status(reg, C1)).to.equal(S.Accepted);
      expect((await reg.assignments(A1)).pendingChildren).to.equal(0n);
      expect(await status(reg, A1)).to.equal(S.Accepted); // still holds 170,000
    });

    it("the old credential steps are gone", async () => {
      const { reg } = await withChild();
      for (const fn of ["requestCredential", "issueCredential", "rejectCredentialRequest"]) expect(reg.interface.getFunction(fn)).to.equal(null);
    });

    it("a parent that assigns everything out closes as Superseded when the child is accepted", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 30000);
      await RL.assignOut(BOND, A1, C1, 30000, h("all of it"));
      expect(await status(reg, A1)).to.equal(S.Accepted);
      await expect(RL.accept(BOND, C1, h("a"))).to.emit(reg, "Superseded").withArgs(BOND, A1);
      expect(await status(reg, A1)).to.equal(S.Superseded);
      expect((await totals(reg)).live).to.equal(30000n);
    });

    it("the assignor can cancel only until the assignee claims it", async () => {
      const { reg, RL } = await withChild();
      await expect(RL.cancelAssignOut(BOND, C1, h("cancel"))).to.emit(reg, "AssignOutCancelled");
      const p = await reg.assignments(A1);
      expect([p.units, p.pendingChildren]).to.deep.equal([200000n, 0n]);
      expect(await status(reg, C1)).to.equal(S.Cancelled);
      // Once the assignee has set up their device on it, it's theirs to accept or reject.
      await RL.assignOut(BOND, A1, C2, 1000, h("d"));
      const { newKey, signFor } = require("./webauthn");
      const k = newKey(), args = [BOND, C2, k.x, k.y, h("assignee device")];
      await RL.registerHolderKey(...args, await signFor(reg, k, C2, "registerHolderKey", args));
      await expect(RL.cancelAssignOut(BOND, C2, h("cancel"))).to.be.revertedWithCustomError(reg, "HolderKeyExists");
    });

    it("the issuer can cancel a disputed child before it takes effect, not after", async () => {
      const { reg, I, RL } = await withChild();
      await expect(I.issuerCancelAssignOut(BOND, C1, h("dispute"))).to.emit(reg, "AssignOutCancelled");
      expect((await reg.assignments(A1)).units).to.equal(200000n);
      await RL.assignOut(BOND, A1, C2, 1000, h("d"));
      await RL.accept(BOND, C2, h("a"));
      await expect(I.issuerCancelAssignOut(BOND, C2, h("late"))).to.be.revertedWithCustomError(reg, "WrongStatus");
    });

    it("an issuer-originated record can't be cancelled as an assign-out", async () => {
      const { reg, I } = await setup();
      await I.issueAssignment(BOND, A1, 100, h("d"));
      await expect(I.issuerCancelAssignOut(BOND, A1, h("r"))).to.be.revertedWithCustomError(reg, "WrongOrigin");
    });
  });

  describe("rejection", () => {
    it("a holder can refuse an issued assignment; its units go back to unassigned", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 1000000, h("doc"));
      await expect(RL.rejectAssignment(BOND, A1, h("not my agreement")))
        .to.emit(reg, "AssignmentRejected").withArgs(BOND, A1, 1000000, h("not my agreement"), await RL.runner.getAddress());
      expect(await status(reg, A1)).to.equal(S.Rejected);
      const t = await totals(reg);
      expect([t.live, t.unassigned, t.reconciled]).to.deep.equal([0n, TOTAL, true]);
      expect((await reg.assignments(A1)).units).to.equal(1000000n); // kept as history
    });

    it("a refused assign-out goes back to the assignor's record", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 1000);
      await RL.assignOut(BOND, A1, C1, 400, h("d"));
      await RL.rejectAssignment(BOND, C1, h("refused"));
      const p = await reg.assignments(A1);
      expect([p.units, p.pendingChildren, Number(p.status)]).to.deep.equal([1000n, 0n, S.Accepted]);
      expect((await totals(reg)).live).to.equal(1000n);
    });

    it("only from Issued, only by the relayer, never twice, and a reason is required", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 100);
      await expect(RL.rejectAssignment(BOND, A1, h("late"))).to.be.revertedWithCustomError(reg, "WrongStatus");
      await I.issueAssignment(BOND, A2, 100, h("d"));
      await expect(I.rejectAssignment(BOND, A2, h("x"), NOAUTH)).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
      await expect(RL.rejectAssignment(BOND, A2, Z)).to.be.revertedWithCustomError(reg, "ZeroHash");
      await RL.rejectAssignment(BOND, A2, h("no"));
      await expect(RL.rejectAssignment(BOND, A2, h("again"))).to.be.revertedWithCustomError(reg, "WrongStatus");
      await expect(RL.accept(BOND, A2, h("a"))).to.be.revertedWithCustomError(reg, "WrongStatus");
    });
  });

  describe("lock and unlock", () => {
    it("the relayer locks; only the issuer unlocks", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 100);
      await expect(RL.lock(BOND, A1, h("notice"))).to.emit(reg, "Locked");
      await expect(RL.unlock(BOND, A1, h("release"))).to.be.revertedWithCustomError(reg, "NotIssuer");
      expect(await status(reg, A1)).to.equal(S.Locked);
      await expect(I.unlock(BOND, A1, h("release"))).to.emit(reg, "Unlocked");
      expect(await status(reg, A1)).to.equal(S.Accepted);
    });

    it("a locked record can't assign out, redeem or be replaced", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 100);
      await RL.lock(BOND, A1, h("n"));
      await expect(RL.assignOut(BOND, A1, C1, 1, h("d"))).to.be.revertedWithCustomError(reg, "WrongStatus");
      await expect(I.redeem(BOND, A1, h("d"))).to.be.revertedWithCustomError(reg, "WrongStatus");
      await expect(I.replaceAssignment(BOND, A1, A2, h("d"))).to.be.revertedWithCustomError(reg, "WrongStatus");
      await expect(RL.lock(BOND, A1, h("n"))).to.be.revertedWithCustomError(reg, "WrongStatus");
    });
  });

  describe("redemption", () => {
    it("the issuer redeems a record in effect: its units are retired for good", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 50000);
      await expect(RL.redeem(BOND, A1, h("paid"))).to.be.revertedWithCustomError(reg, "NotIssuer");
      await expect(I.redeem(BOND, A1, h("paid"))).to.emit(reg, "Redeemed").withArgs(BOND, A1, 50000, h("paid"), await I.runner.getAddress());
      const t = await totals(reg);
      expect([t.live, t.redeemed, t.reconciled]).to.deep.equal([0n, 50000n, true]);
      expect(await status(reg, A1)).to.equal(S.Redeemed);
      expect((await reg.assignments(A1)).units).to.equal(50000n); // kept as history
      await expect(I.redeem(BOND, A1, h("again"))).to.be.revertedWithCustomError(reg, "WrongStatus");
    });

    it("needs the payment document, and only from in effect", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 100, h("d"));
      await expect(I.redeem(BOND, A1, h("paid"))).to.be.revertedWithCustomError(reg, "WrongStatus"); // still Issued
      await RL.accept(BOND, A1, h("a"));
      await expect(I.redeem(BOND, A1, Z)).to.be.revertedWithCustomError(reg, "ZeroHash");
    });

    it("refused with pending children or zero units", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 100);
      await RL.assignOut(BOND, A1, C1, 40, h("d"));
      await expect(I.redeem(BOND, A1, h("r"))).to.be.revertedWithCustomError(reg, "PendingChildren");
      await RL.assignOut(BOND, A1, C2, 60, h("d"));
      await RL.cancelAssignOut(BOND, C1, h("c"));
      await RL.cancelAssignOut(BOND, C2, h("c"));
      await I.redeem(BOND, A1, h("r")); // all 100 back, nothing pending
    });

    it("refuses a record with nothing left that still waits on a child", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 100);
      await RL.assignOut(BOND, A1, C1, 100, h("d"));
      await expect(I.redeem(BOND, A1, h("r"))).to.be.revertedWithCustomError(reg, "ZeroUnits");
    });
  });

  describe("replacement", () => {
    it("supersedes the old record and issues the same units to a new one", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 7000);
      await expect(I.replaceAssignment(BOND, A1, A2, h("reissue"))).to.emit(reg, "AssignmentReplaced").withArgs(BOND, A1, A2, h("reissue"), await I.runner.getAddress());
      expect(await status(reg, A1)).to.equal(S.Superseded);
      const n = await reg.assignments(A2);
      expect([Number(n.status), Number(n.origin), n.units, n.parentId]).to.deep.equal([S.Issued, O.Replacement, 7000n, A1]);
      expect((await totals(reg)).live).to.equal(7000n);
    });

    it("refused with pending children, from a terminal record, or onto an existing ID", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 100);
      await RL.assignOut(BOND, A1, C1, 10, h("d"));
      await expect(I.replaceAssignment(BOND, A1, A2, h("d"))).to.be.revertedWithCustomError(reg, "PendingChildren");
      await RL.cancelAssignOut(BOND, C1, h("c"));
      await I.issueAssignment(BOND, A3, 5, h("d"));
      await expect(I.replaceAssignment(BOND, A1, A3, h("d"))).to.be.revertedWithCustomError(reg, "RecordExists");
      await I.replaceAssignment(BOND, A1, A2, h("d"));
      await expect(I.replaceAssignment(BOND, A1, id("X"), h("d"))).to.be.revertedWithCustomError(reg, "WrongStatus");
    });

    it("replacing an unaccepted assign-out resolves the assignor's pending count", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 100);
      await RL.assignOut(BOND, A1, C1, 100, h("all"));
      await I.replaceAssignment(BOND, C1, C2, h("reissue"));
      expect((await reg.assignments(A1)).pendingChildren).to.equal(0n);
      expect(await status(reg, A1)).to.equal(S.Superseded); // nothing left, nothing pending
      await RL.accept(BOND, C2, h("a")); // its parent is C1 by origin Replacement: no second decrement
      expect(await status(reg, C2)).to.equal(S.Accepted);
    });
  });

  describe("terminal records", () => {
    it("no function accepts a Redeemed, Superseded or Cancelled record", async () => {
      const { reg, I, RL } = await setup();
      await accepted(I, RL, A1, 100);
      await I.redeem(BOND, A1, h("paid"));
      await accepted(I, RL, A2, 100);
      await I.replaceAssignment(BOND, A2, A3, h("d"));
      await RL.assignOut(BOND, id("none"), C1, 1, h("d")).catch(() => {});
      for (const t of [A1, A2]) {
        await expect(RL.accept(BOND, t, h("x"))).to.be.revertedWithCustomError(reg, "WrongStatus");
        await expect(RL.assignOut(BOND, t, C1, 1, h("x"))).to.be.revertedWithCustomError(reg, "WrongStatus");
        await expect(RL.lock(BOND, t, h("x"))).to.be.revertedWithCustomError(reg, "WrongStatus");
        await expect(I.unlock(BOND, t, h("x"))).to.be.revertedWithCustomError(reg, "WrongStatus");
        await expect(I.redeem(BOND, t, h("x"))).to.be.revertedWithCustomError(reg, "WrongStatus");
        await expect(I.replaceAssignment(BOND, t, C2, h("x"))).to.be.revertedWithCustomError(reg, "WrongStatus");
        await expect(I.setFilingRef(BOND, t, h("x"))).to.be.revertedWithCustomError(reg, "WrongStatus");
        await expect(I.setDeliveryRef(BOND, t, h("x"), 1)).to.be.revertedWithCustomError(reg, "WrongStatus");
      }
    });
  });

  describe("suspension and pause", () => {
    it("a suspended issuer's bonds can't change, by the issuer or the relayer", async () => {
      const { reg, I, RL, platform } = await setup();
      await accepted(I, RL, A1, 100);
      await expect(reg.connect(platform).suspendIssuer(ISS, h("notice"))).to.emit(reg, "IssuerSuspended");
      await expect(I.issueAssignment(BOND, A2, 1, h("d"))).to.be.revertedWithCustomError(reg, "IssuerIsSuspended");
      await expect(RL.lock(BOND, A1, h("n"))).to.be.revertedWithCustomError(reg, "IssuerIsSuspended");
      await expect(I.anchorBond(id("KPII-0002-BD"), ISS, 1, h("i"), h("u"))).to.be.revertedWithCustomError(reg, "IssuerIsSuspended");
      expect(await status(reg, A1)).to.equal(S.Accepted); // still readable
      await reg.connect(platform).reinstateIssuer(ISS, h("cleared"));
      await RL.lock(BOND, A1, h("n"));
    });

    it("the guardian pauses every write; only the guardian unpauses", async () => {
      const { reg, I, RL, guardian, platform, stranger } = await setup();
      await expect(reg.connect(stranger).pause()).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
      await reg.connect(guardian).pause();
      await expect(I.issueAssignment(BOND, A1, 1, h("d"))).to.be.revertedWithCustomError(reg, "EnforcedPause");
      await expect(RL.accept(BOND, A1, h("d"))).to.be.revertedWithCustomError(reg, "EnforcedPause");
      await expect(reg.connect(platform).registerIssuer(id("NEW"), stranger.address)).to.be.revertedWithCustomError(reg, "EnforcedPause");
      await reg.connect(guardian).unpause();
      await I.issueAssignment(BOND, A1, 1, h("d"));
    });
  });

  describe("no tokens", () => {
    it("refuses plain value transfers", async () => {
      const { reg, stranger } = await setup();
      await expect(stranger.sendTransaction({ to: await reg.getAddress(), value: 1 })).to.be.reverted;
    });
  });

  // A long random run of every action, valid or not. After each step the units rule
  // must hold, and the contract's live total must equal the sum over live records.
  describe("randomized invariant run", () => {
    it("keeps prior + live + unassigned + redeemed == total through 1,500 random actions", async function () {
      this.timeout(600_000);
      const { reg, I, RL } = await setup();
      let seed = 20261108;
      // The high bits: this generator's low bits repeat in short cycles (badly when n is a power of 2).
      const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
      const ids = []; let next = 1, priors = 0;
      // Mostly recent records, so multi-step paths (accept, then redeem) actually happen.
      const anyId = () => (!ids.length ? id("none") : rnd(4) ? ids[Math.max(0, ids.length - 1 - rnd(6))] : ids[rnd(ids.length)]);
      const fresh = () => { const x = id("R" + next++); ids.push(x); return x; };
      // Mostly up to $50,000; now and then up to $20M, so the bond does run low.
      const amount = () => BigInt(1 + (rnd(10) ? rnd(5_000_000) : rnd(2_000_000_000)));
      const actions = [
        () => I.issueAssignment(BOND, fresh(), amount(), h("d")),
        () => RL.accept(BOND, anyId(), h("a")),
        () => RL.rejectAssignment(BOND, anyId(), h("refused")),
        () => RL.assignOut(BOND, anyId(), fresh(), amount(), h("o")),
        () => RL.cancelAssignOut(BOND, anyId(), h("c")),
        () => I.issuerCancelAssignOut(BOND, anyId(), h("c")),
        () => I.setFilingRef(BOND, anyId(), h("f")),
        () => RL.lock(BOND, anyId(), h("l")),
        () => I.unlock(BOND, anyId(), h("u")),
        () => I.redeem(BOND, anyId(), h("paid")),
        // A fresh record carried all the way to redemption, so every run retires something.
        async () => { const x = fresh(); await I.issueAssignment(BOND, x, amount(), h("d")); await RL.accept(BOND, x, h("a"));
          return I.redeem(BOND, x, h("paid")); },
        () => I.replaceAssignment(BOND, anyId(), fresh(), h("rp")),
        () => I.recordPriorInstrument(BOND, id("PN-" + priors++), amount(), h("p")),
        () => I.reversePriorInstrument(BOND, id("PN-" + rnd(priors + 1)), h("rv")),
      ];
      let ok = 0;
      for (let step = 0; step < 1500; step++) {
        try { await actions[rnd(actions.length)](); ok++; } catch { /* refused: fine */ }
        const t = await totals(reg);
        expect(t.reconciled, "units rule at step " + step).to.equal(true);
      }
      let live = 0n;
      for (const x of ids) {
        const a = await reg.assignments(x);
        if (Number(a.status) !== S.None && ![S.Redeemed, S.Superseded, S.Cancelled, S.Rejected].includes(Number(a.status))) live += a.units;
        if (Number(a.status) === S.Superseded) expect(a.pendingChildren).to.equal(0n);
      }
      const t = await totals(reg);
      expect(t.live).to.equal(live);
      console.log(`      ${ok} of 1,500 random actions went through; ${ids.length} records; live ${live}, redeemed ${t.redeemed}, prior ${t.prior}`);
      expect(ok).to.be.greaterThan(200); // the run exercised real transitions
      expect(t.redeemed > 0n && t.prior > 0n, "run reached redemption and prior instruments").to.equal(true);
    });
  });
});
