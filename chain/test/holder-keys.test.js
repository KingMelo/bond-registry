// Holder device keys (v4): every holder action needs a signature from the holder's own passkey.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { newKey, assert, signFor, NOAUTH } = require("./webauthn");

const id = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const h = (s) => ethers.sha256(ethers.toUtf8Bytes(s));
const S = { AwaitingCredential: 1, CredentialRequested: 2, Issued: 3, Accepted: 4, Locked: 5, PendingRedemption: 6, Rejected: 10, Cancelled: 9 };
const ISS = id("KPII"), BOND = id("KPII-0001-BD");
const A1 = id("KPII-0001-BD-A00001"), A2 = id("KPII-0001-BD-A00002"), C1 = id("KPII-0001-BD-A00003");
const DAY = 86400;

async function setup() {
  const [admin, platform, relayer, guardian, issuer, stranger] = await ethers.getSigners();
  const reg = await (await ethers.getContractFactory("BondInterestRegistry")).deploy(admin.address, platform.address, relayer.address, guardian.address);
  await reg.connect(platform).registerIssuer(ISS, issuer.address);
  await reg.connect(issuer).anchorBond(BOND, ISS, 10_000_000_000n, h("instrument"), h("ucc1"));
  const I = reg.connect(issuer), RL = reg.connect(relayer);
  return { reg, I, RL, platform, issuer, stranger };
}
const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
const later = async (secs) => { await network.provider.send("evm_increaseTime", [secs]); await network.provider.send("evm_mine"); };

/** Registers a fresh device key for `rec`, as the holder's first sign-in does. */
async function enroll(reg, RL, rec, doc = h("device " + rec)) {
  const key = newKey(), args = [BOND, rec, key.x, key.y, doc];
  await RL.registerHolderKey(...args, await signFor(reg, key, rec, "registerHolderKey", args));
  return key;
}
const sign = (reg, key, signer, fn, args, o) => signFor(reg, key, signer, fn, args, o);

describe("holder device keys", () => {
  describe("registering a key", () => {
    it("needs a signature from the key being registered, and only one key at a time", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      const key = newKey(), impostor = newKey(), args = [BOND, A1, key.x, key.y, h("dev")];
      // signed by some other key: refused
      await expect(RL.registerHolderKey(...args, await sign(reg, key, A1, "registerHolderKey", args, { signWith: impostor })))
        .to.be.revertedWithCustomError(reg, "BadHolderSignature");
      await expect(RL.registerHolderKey(...args, await sign(reg, key, A1, "registerHolderKey", args)))
        .to.emit(reg, "HolderKeyRegistered").withArgs(BOND, A1, key.x, key.y, h("dev"), await RL.runner.getAddress());
      const k = await reg.holderKeys(A1);
      expect(k.x).to.equal(key.x); expect(k.y).to.equal(key.y); expect(k.nonce).to.equal(1n);
      // a second key can't simply be registered over it
      const k2 = newKey(), args2 = [BOND, A1, k2.x, k2.y, h("dev2")];
      await expect(RL.registerHolderKey(...args2, await sign(reg, k2, A1, "registerHolderKey", args2)))
        .to.be.revertedWithCustomError(reg, "HolderKeyExists");
    });

    it("only the relayer submits it, and not before the new holder is activated", async () => {
      const { reg, I, RL, stranger } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      const key = newKey(), args = [BOND, A1, key.x, key.y, h("dev")];
      const auth = await sign(reg, key, A1, "registerHolderKey", args);
      await expect(reg.connect(stranger).registerHolderKey(...args, auth)).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
      await expect(I.registerHolderKey(...args, auth)).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
      // an assign-out child that nobody has claimed yet
      const pk = await enroll(reg, RL, A1);
      await RL.accept(BOND, A1, h("a"), await sign(reg, pk, A1, "accept", [BOND, A1, h("a")]));
      const out = [BOND, A1, C1, 40n, h("o")];
      await RL.assignOut(...out, await sign(reg, pk, A1, "assignOut", out));
      const ck = newKey(), cargs = [BOND, C1, ck.x, ck.y, h("dev c")];
      await expect(RL.registerHolderKey(...cargs, await sign(reg, ck, C1, "registerHolderKey", cargs)))
        .to.be.revertedWithCustomError(reg, "WrongStatus");
    });
  });

  describe("signed holder actions", () => {
    it("the relayer can't act for a holder without their signature", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      await expect(RL.rejectAssignment(BOND, A1, h("no"), { ...NOAUTH, r: 1n })).to.be.revertedWithCustomError(reg, "NoHolderKey");
      await expect(RL.accept(BOND, A1, h("a"), NOAUTH)).to.be.revertedWithCustomError(reg, "ResponsePeriodOpen");
      const key = await enroll(reg, RL, A1);
      // the relayer's own forgery: a different key's signature
      const forged = await sign(reg, key, A1, "rejectAssignment", [BOND, A1, h("no")], { signWith: newKey() });
      await expect(RL.rejectAssignment(BOND, A1, h("no"), forged)).to.be.revertedWithCustomError(reg, "BadHolderSignature");
      expect(await reg.assignments(A1).then((a) => Number(a.status))).to.equal(S.Issued);
    });

    it("a signature covers exactly one call: its function, its arguments, and only once", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      const key = await enroll(reg, RL, A1);
      const auth = await sign(reg, key, A1, "rejectAssignment", [BOND, A1, h("reason A")]);
      // the same signature with a different reason
      await expect(RL.rejectAssignment(BOND, A1, h("reason B"), auth)).to.be.revertedWithCustomError(reg, "BadHolderSignature");
      // or for a different function
      await expect(RL.accept(BOND, A1, h("reason A"), auth)).to.be.revertedWithCustomError(reg, "BadHolderSignature");
      await expect(RL.rejectAssignment(BOND, A1, h("reason A"), auth)).to.emit(reg, "AssignmentRejected");
      // the counter moved, so the signature is spent
      expect((await reg.holderKeys(A1)).nonce).to.equal(2n);
    });

    it("checks the WebAuthn details: user verified, a sign-in, the right challenge", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      const key = await enroll(reg, RL, A1);
      const args = [BOND, A1, h("a")];
      for (const o of [{ flags: 0x01 }, { flags: 0x04 }, { type: "webauthn.create" }, { challenge: ethers.id("something else") }])
        await expect(RL.accept(...args, await sign(reg, key, A1, "accept", args, o))).to.be.revertedWithCustomError(reg, "BadHolderSignature");
      await expect(RL.accept(...args, await sign(reg, key, A1, "accept", args))).to.emit(reg, "Accepted");
    });

    it("one record's key can't sign for another record", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      await I.issueAssignment(BOND, A2, 1000, h("d2"));
      const k1 = await enroll(reg, RL, A1);
      await enroll(reg, RL, A2);
      const args = [BOND, A2, h("no")];
      await expect(RL.rejectAssignment(...args, await sign(reg, k1, A2, "rejectAssignment", args))).to.be.revertedWithCustomError(reg, "BadHolderSignature");
    });

    it("assign-outs are signed by the assignor; the new holder can't cancel them", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      const pk = await enroll(reg, RL, A1);
      await RL.accept(BOND, A1, h("a"), await sign(reg, pk, A1, "accept", [BOND, A1, h("a")]));
      const out = [BOND, A1, C1, 1040n, h("o")];
      await expect(RL.assignOut(...out, await sign(reg, newKey(), A1, "assignOut", out))).to.be.revertedWithCustomError(reg, "BadHolderSignature");
      await expect(RL.assignOut(BOND, A1, C1, 40n, h("o"), await sign(reg, pk, A1, "assignOut", [BOND, A1, C1, 40n, h("o")]))).to.emit(reg, "AssignedOut");
      const c = [BOND, C1, h("cancel")];
      await expect(RL.cancelAssignOut(...c, await sign(reg, newKey(), A1, "cancelAssignOut", c))).to.be.revertedWithCustomError(reg, "BadHolderSignature");
      await expect(RL.cancelAssignOut(...c, await sign(reg, pk, A1, "cancelAssignOut", c))).to.emit(reg, "AssignOutCancelled");
    });

    it("locking needs the holder's signature; redeeming is the issuer's alone", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      const k = await enroll(reg, RL, A1);
      await RL.accept(BOND, A1, h("a"), await sign(reg, k, A1, "accept", [BOND, A1, h("a")]));
      await expect(RL.lock(BOND, A1, h("l"), { ...NOAUTH, r: 1n })).to.be.revertedWithCustomError(reg, "BadHolderSignature");
      await RL.lock(BOND, A1, h("l"), await sign(reg, k, A1, "lock", [BOND, A1, h("l")]));
      await I.unlock(BOND, A1, h("u"));
      await expect(RL.redeem(BOND, A1, h("paid"))).to.be.revertedWithCustomError(reg, "NotIssuer");
      await expect(I.redeem(BOND, A1, h("paid"))).to.emit(reg, "Redeemed");
    });
  });

  describe("the response period", () => {
    it("an unanswered assignment takes effect without a signature only 30 days after it was mailed", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      await expect(I.setDeliveryRef(BOND, A1, h("mail"), (await now()) + 3600)).to.be.revertedWithCustomError(reg, "BadMailingDate");
      await expect(I.setDeliveryRef(BOND, A1, h("mail"), 0)).to.be.revertedWithCustomError(reg, "BadMailingDate");
      const mailed = (await now()) - 2 * DAY;
      await expect(I.setDeliveryRef(BOND, A1, h("mail"), mailed)).to.emit(reg, "DeliveryRecorded").withArgs(BOND, A1, h("mail"), mailed, await I.runner.getAddress());
      expect(await reg.mailedAt(A1)).to.equal(BigInt(mailed));
      await expect(RL.accept(BOND, A1, h("deemed"), NOAUTH)).to.be.revertedWithCustomError(reg, "ResponsePeriodOpen").withArgs(A1, BigInt(mailed + 30 * DAY));
      await later(28 * DAY + 60);
      await expect(RL.accept(BOND, A1, h("deemed"), NOAUTH)).to.emit(reg, "Accepted");
    });

    it("a holder can still reject right up to the end of the period", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      await I.setDeliveryRef(BOND, A1, h("mail"), await now());
      const k = await enroll(reg, RL, A1);
      await later(29 * DAY);
      await expect(RL.rejectAssignment(BOND, A1, h("no"), await sign(reg, k, A1, "rejectAssignment", [BOND, A1, h("no")]))).to.emit(reg, "AssignmentRejected");
    });
  });

  describe("changing keys", () => {
    it("the holder moves to a new device with the old one's signature", async () => {
      const { reg, I, RL } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      const old = await enroll(reg, RL, A1), next = newKey();
      const args = [BOND, A1, next.x, next.y, h("new phone")];
      await expect(RL.rotateHolderKey(...args, await sign(reg, next, A1, "rotateHolderKey", args))).to.be.revertedWithCustomError(reg, "BadHolderSignature");
      await RL.rotateHolderKey(...args, await sign(reg, old, A1, "rotateHolderKey", args));
      const a = [BOND, A1, h("a")];
      await expect(RL.accept(...a, await sign(reg, old, A1, "accept", a))).to.be.revertedWithCustomError(reg, "BadHolderSignature");
      await expect(RL.accept(...a, await sign(reg, next, A1, "accept", a))).to.emit(reg, "Accepted");
    });

    it("only the issuer clears a lost key; the counter keeps going so old signatures stay dead", async () => {
      const { reg, I, RL, platform, stranger } = await setup();
      await I.issueAssignment(BOND, A1, 1000, h("d"));
      const lost = await enroll(reg, RL, A1);
      const stale = await sign(reg, lost, A1, "rejectAssignment", [BOND, A1, h("no")]); // signed, never sent
      for (const who of [RL, reg.connect(platform), reg.connect(stranger)])
        await expect(who.clearHolderKey(BOND, A1, h("id check"))).to.be.revertedWithCustomError(reg, "NotIssuer");
      await expect(I.clearHolderKey(BOND, A1, h("id check"))).to.emit(reg, "HolderKeyCleared");
      await expect(I.clearHolderKey(BOND, A1, h("again"))).to.be.revertedWithCustomError(reg, "NoHolderKey");
      await expect(RL.rejectAssignment(BOND, A1, h("no"), stale)).to.be.revertedWithCustomError(reg, "NoHolderKey");
      const fresh = await enroll(reg, RL, A1, h("new device"));
      await expect(RL.rejectAssignment(BOND, A1, h("no"), stale)).to.be.revertedWithCustomError(reg, "BadHolderSignature");
      await expect(RL.rejectAssignment(BOND, A1, h("no"), await sign(reg, fresh, A1, "rejectAssignment", [BOND, A1, h("no")]))).to.emit(reg, "AssignmentRejected");
    });
  });
});
