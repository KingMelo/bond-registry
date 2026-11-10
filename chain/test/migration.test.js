// Moving to a new contract version: the new one copies the old one's state from the chain.
// The predecessor here is v4 exactly as deployed on Amoy (contracts/legacy), with holder-signed records.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { newKey, signFor } = require("./webauthn");

const id = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const h = (s) => ethers.sha256(ethers.toUtf8Bytes(s));
const ISS = id("KJPII"), BOND = id("KJPII-0001-BD");
const A1 = id("KJPII-0001-BD-A00001"), A2 = id("KJPII-0001-BD-A00002"), A3 = id("KJPII-0001-BD-A00003"), C1 = id("KJPII-0001-BD-A00004");
const P1 = id("PN-1"), P2 = id("PN-2");
const TOTAL = 10_000_000_000n;
const S = { None: 0, AwaitingCredential: 1, Issued: 3, Accepted: 4, Locked: 5, Redeemed: 7, Rejected: 10 };

async function enroll(reg, RL, rec) {
  const key = newKey(), args = [BOND, rec, key.x, key.y, h("device " + rec)];
  await RL.registerHolderKey(...args, await signFor(reg, key, rec, "registerHolderKey", args));
  return key;
}

/** v4 with a realistic history: priors (one reversed), a holder-signed acceptance, a pending assign-out, a rejection, a lock. */
async function oldRegistry() {
  const [admin, platform, relayer, guardian, issuer, stranger] = await ethers.getSigners();
  const old = await (await ethers.getContractFactory("BondInterestRegistryV4")).deploy(admin.address, platform.address, relayer.address, guardian.address);
  const I = old.connect(issuer), RL = old.connect(relayer);
  await old.connect(platform).registerIssuer(ISS, issuer.address);
  await I.anchorBond(BOND, ISS, TOTAL, h("instrument"), h("ucc1"));
  await I.recordPriorInstrument(BOND, P1, 99_908_282n, h("p1"));
  await I.recordPriorInstrument(BOND, P2, 500n, h("p2"));
  await I.reversePriorInstrument(BOND, P2, h("entered in error"));
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  // A1: issued, mailed, holder sets up a device and acknowledges, then assigns $10.40 out.
  await I.issueAssignment(BOND, A1, 1_000_000n, h("doc A1"));
  await I.setFilingRef(BOND, A1, h("ucc3 A1"));
  await I.setDeliveryRef(BOND, A1, h("mail A1"), now - 3600);
  const k1 = await enroll(old, RL, A1);
  await RL.accept(BOND, A1, h("ack"), await signFor(old, k1, A1, "accept", [BOND, A1, h("ack")]));
  const out = [BOND, A1, C1, 1040n, h("out")];
  await RL.assignOut(...out, await signFor(old, k1, A1, "assignOut", out));
  // A2: rejected by its holder. A3: in effect, then locked.
  await I.issueAssignment(BOND, A2, 300_000n, h("doc A2"));
  const k2 = await enroll(old, RL, A2);
  await RL.rejectAssignment(BOND, A2, h("not ours"), await signFor(old, k2, A2, "rejectAssignment", [BOND, A2, h("not ours")]));
  await I.issueAssignment(BOND, A3, 50_000n, h("doc A3"));
  const k3 = await enroll(old, RL, A3);
  await RL.accept(BOND, A3, h("a3"), await signFor(old, k3, A3, "accept", [BOND, A3, h("a3")]));
  await RL.lock(BOND, A3, h("pledge"), await signFor(old, k3, A3, "lock", [BOND, A3, h("pledge")]));
  return { old, k1, k3, admin, platform, relayer, guardian, issuer, stranger };
}

async function newRegistry(o) {
  const reg = await (await ethers.getContractFactory("BondInterestRegistry"))
    .deploy(o.admin.address, o.platform.address, o.relayer.address, o.guardian.address, await o.old.getAddress());
  return reg;
}
async function importAll(reg) {
  await reg.importIssuer(ISS);
  await reg.importBond(BOND);
  for (const p of [P1, P2]) await reg.importPrior(BOND, p);
  for (const r of [A1, A2, A3, C1]) await reg.importRecord(r);
}
const same = async (a, b, fn, ...args) => expect((await b[fn](...args)).toArray()).to.deep.equal((await a[fn](...args)).toArray(), fn);

describe("migration to a new contract", () => {
  it("imports wait until the old contract is paused, and nothing else runs meanwhile", async () => {
    const o = await oldRegistry(), reg = await newRegistry(o);
    expect(await reg.migrating()).to.equal(true);
    expect(await reg.predecessor()).to.equal(await o.old.getAddress());
    await expect(reg.importIssuer(ISS)).to.be.revertedWithCustomError(reg, "PredecessorNotPaused");
    await o.old.connect(o.guardian).pause();
    // normal writes are refused until the import is finished
    await expect(reg.connect(o.platform).registerIssuer(id("NEW"), o.stranger.address)).to.be.revertedWithCustomError(reg, "Migrating");
    await importAll(reg);
    await expect(reg.connect(o.issuer).issueAssignment(BOND, id("X"), 1n, h("x"))).to.be.revertedWithCustomError(reg, "Migrating");
  });

  it("copies every issuer, bond, prior instrument and record exactly, device keys and counters included", async () => {
    const o = await oldRegistry(), reg = await newRegistry(o);
    await o.old.connect(o.guardian).pause();
    await importAll(reg);
    await same(o.old, reg, "issuers", ISS);
    await same(o.old, reg, "bonds", BOND);
    await same(o.old, reg, "bondTotals", BOND);
    for (const p of [P1, P2]) await same(o.old, reg, "priorInstruments", BOND, p);
    for (const r of [A1, A2, A3, C1]) {
      if (r !== C1) await same(o.old, reg, "assignments", r);
      await same(o.old, reg, "holderKeys", r);
      expect(await reg.mailedAt(r)).to.equal(await o.old.mailedAt(r));
    }
    // v4's assign-out waiting for the issuer arrives open to its assignee; everything else identical.
    const [c4, c5] = [(await o.old.assignments(C1)).toArray(), (await reg.assignments(C1)).toArray()];
    expect(Number(c4[5])).to.equal(S.AwaitingCredential);
    expect(Number(c5[5])).to.equal(S.Issued);
    c4[5] = c5[5];
    expect(c5).to.deep.equal(c4);
    expect((await reg.holderKeys(A1)).nonce).to.equal(3n); // registration, acknowledgement, assign-out
    expect((await reg.bondTotals(BOND)).reconciled).to.equal(true);
  });

  it("refuses doubles, gaps and anything the old contract doesn't hold", async () => {
    const o = await oldRegistry(), reg = await newRegistry(o);
    await o.old.connect(o.guardian).pause();
    await expect(reg.importBond(BOND)).to.be.revertedWithCustomError(reg, "UnknownIssuer"); // issuer first
    await reg.importIssuer(ISS);
    await expect(reg.importIssuer(ISS)).to.be.revertedWithCustomError(reg, "AlreadyImported");
    await expect(reg.importRecord(A1)).to.be.revertedWithCustomError(reg, "UnknownBond"); // bond first
    await reg.importBond(BOND);
    await expect(reg.importRecord(id("KJPII-0001-BD-A09999"))).to.be.revertedWithCustomError(reg, "NotOnPredecessor");
    await expect(reg.importPrior(BOND, id("PN-NEVER"))).to.be.revertedWithCustomError(reg, "NotOnPredecessor");
    await expect(reg.importIssuer(id("NOBODY"))).to.be.revertedWithCustomError(reg, "NotOnPredecessor");
    await reg.importRecord(A1);
    await expect(reg.importRecord(A1)).to.be.revertedWithCustomError(reg, "AlreadyImported");
  });

  it("only the admin finishes; after that imports close and the registry works normally", async () => {
    const o = await oldRegistry(), reg = await newRegistry(o);
    await o.old.connect(o.guardian).pause();
    await importAll(reg);
    for (const who of [o.platform, o.relayer, o.issuer, o.stranger])
      await expect(reg.connect(who).finishImport()).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
    await expect(reg.connect(o.admin).finishImport()).to.emit(reg, "ImportFinished");
    expect(await reg.migrating()).to.equal(false);
    await expect(reg.importRecord(A1)).to.be.revertedWithCustomError(reg, "NotMigrating");
    await expect(reg.connect(o.admin).finishImport()).to.be.revertedWithCustomError(reg, "NotMigrating");
    // the issuer acts as before
    await reg.connect(o.issuer).unlock(BOND, A3, h("release"));
    await expect(reg.connect(o.issuer).redeem(BOND, A3, h("paid"))).to.emit(reg, "Redeemed");
    expect((await reg.bondTotals(BOND)).reconciled).to.equal(true);
  });

  it("holders keep their device: the same key signs on the new contract, and old signatures don't carry over", async () => {
    const o = await oldRegistry(), reg = await newRegistry(o);
    // A signature made for the old contract, never sent.
    const lockArgs = [BOND, A1, h("lock")];
    const staleOld = await signFor(o.old, o.k1, A1, "lock", lockArgs);
    await o.old.connect(o.guardian).pause();
    await importAll(reg);
    await reg.connect(o.admin).finishImport();
    const RL = reg.connect(o.relayer);
    await expect(RL.lock(...lockArgs, staleOld)).to.be.revertedWithCustomError(reg, "BadHolderSignature");
    // The child's assignor cancels with the same device key, now signing for the new contract.
    const c = [BOND, C1, h("cancel")];
    await expect(RL.cancelAssignOut(...c, await signFor(reg, o.k1, A1, "cancelAssignOut", c))).to.emit(reg, "AssignOutCancelled");
    expect((await reg.assignments(A1)).units).to.equal(1_000_000n);
    await expect(RL.lock(...lockArgs, await signFor(reg, o.k1, A1, "lock", lockArgs))).to.emit(reg, "Locked");
    expect((await reg.holderKeys(A1)).nonce).to.equal(5n);
  });

  it("a fresh deployment (no predecessor) starts open, and refuses imports", async () => {
    const [a] = await ethers.getSigners();
    const reg = await (await ethers.getContractFactory("BondInterestRegistry")).deploy(a.address, a.address, a.address, a.address, ethers.ZeroAddress);
    expect(await reg.migrating()).to.equal(false);
    await expect(reg.importIssuer(ISS)).to.be.revertedWithCustomError(reg, "NotMigrating");
  });

  it("the next version can import from this one the same way", async () => {
    const o = await oldRegistry(), v5 = await newRegistry(o);
    await o.old.connect(o.guardian).pause();
    await importAll(v5);
    await v5.connect(o.admin).finishImport();
    await v5.connect(o.guardian).pause();
    const v6 = await (await ethers.getContractFactory("BondInterestRegistry"))
      .deploy(o.admin.address, o.platform.address, o.relayer.address, o.guardian.address, await v5.getAddress());
    await importAll(v6);
    for (const r of [A1, A2, A3, C1]) await same(v5, v6, "assignments", r);
    await same(v5, v6, "bondTotals", BOND);
  });
});
