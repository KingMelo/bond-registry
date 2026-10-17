// Sample register shared by the holder portal and the issuer console.
// Loaded into an empty database, and again by the issuer's "Reset demo".

export const BONDS = [
  { id: "KPII-0001-BD", face: 100000000, total: 100000000, unassigned: 99765000, redeemed: 0, prior: [],
    registered: "Mar 4, 2026", instrumentHash: "0xa41b7c…88e2", declarationHash: "0xd90f23…1c55" },
  { id: "KPII-0002-BD", face: 100000000, total: 100000000, unassigned: 99950000, redeemed: 0, prior: [],
    registered: "May 19, 2026", instrumentHash: "0xb72e04…3af1", declarationHash: "0x6c1a89…7d20" },
  { id: "KPII-0003-BD", face: 100000000, total: 100000000, unassigned: 100000000, redeemed: 0, prior: [],
    registered: "Sep 1, 2026", instrumentHash: "0x0e55ab…9140", declarationHash: "0x33d71f…b602" },
];

const base = {
  credLocked: false, lockKind: null, lockReason: null, lockedOn: null,
  unlockRequested: false, rotationRequested: false,
};

export const ASSIGNMENTS = [
  { ...base, bond: "KPII-0001-BD", id: "KPII-0001-BD-A00001", parent: null, origin: "Issuer", assignor: "Issuer of record",
    party: "Company A", contact: "D. Hargrove", position: "Authorized Representative",
    address: "Company A\nAttn: D. Hargrove\n501 Mercer Street\nColumbus, OH 43215",
    units: 170000, issuedUnits: 200000, status: "Accepted", created: "Mar 6, 2026", accepted: "Mar 11, 2026",
    docHash: "0x83a4c7…2d17", filingRef: "0x5f21ab…9c40", deliveryRef: "0x1b77de…04a2", tx: "0x712c9f…a4e1",
    instrumentMail: "RE 123 456 789 US", passkeyMail: "RE 123 456 790 US" },

  { ...base, bond: "KPII-0001-BD", id: "KPII-0001-BD-A00002", parent: null, origin: "Issuer", assignor: "Issuer of record",
    party: "Company B", contact: "L. Whitfield", position: "Managing Member",
    address: "Company B\nAttn: L. Whitfield\n22 Canal Road\nProvidence, RI 02903",
    units: 30000, issuedUnits: 30000, status: "Accepted", created: "Jun 18, 2026", accepted: "Jun 22, 2026",
    docHash: "0xc1f802…9b40", filingRef: "0x77a3e1…5512", deliveryRef: "0x9e44bc…7731", tx: "0x9d410b…77c3",
    instrumentMail: "9407 1000 0000 0000 0000 02", passkeyMail: "9407 1000 0000 0000 0000 09" },

  { ...base, bond: "KPII-0001-BD", id: "KPII-0001-BD-A00003", parent: "KPII-0001-BD-A00001", origin: "AssignOut",
    assignor: "Company A", party: "Company D", contact: "M. Osei", position: "Treasurer",
    address: "Company D\nAttn: M. Osei\n88 Front Avenue\nAustin, TX 78701",
    units: 30000, issuedUnits: 30000, status: "AwaitingCredential", created: "Sep 14, 2026", accepted: null,
    docHash: "0x4a8813…0fd2", filingRef: null, deliveryRef: null, tx: "0x55b2e3…1a09",
    instrumentMail: null, passkeyMail: null },

  { ...base, bond: "KPII-0001-BD", id: "KPII-0001-BD-A00004", parent: null, origin: "Issuer", assignor: "Issuer of record",
    party: "Company C", contact: "R. Alvarez", position: "Chief Financial Officer",
    address: "Company C\nAttn: R. Alvarez\n1400 Harbor Street\nWilmington, DE 19801",
    units: 5000, issuedUnits: 5000, status: "Issued", created: "Oct 2, 2026", accepted: null,
    docHash: "0x62de91…c7b8", filingRef: "0x30ba77…e1d9", deliveryRef: "0x8c02fa…66b4", tx: "0x3f81aa…02de",
    instrumentMail: "9407 1000 0000 0000 0000 18", passkeyMail: "9407 1000 0000 0000 0000 25" },

  { ...base, bond: "KPII-0002-BD", id: "KPII-0002-BD-A00001", parent: null, origin: "Issuer", assignor: "Issuer of record",
    party: "Company E", contact: "P. Nakamura", position: "Director of Finance",
    address: "Company E\nAttn: P. Nakamura\n9 Bridgeway\nSavannah, GA 31401",
    units: 50000, issuedUnits: 50000, status: "Locked", created: "May 22, 2026", accepted: "May 26, 2026",
    docHash: "0x7f3d20…aa18", filingRef: "0x118cc4…6e37", deliveryRef: "0x44b9f0…2d81", tx: "0x2c7d18…90b5",
    instrumentMail: "9407 1000 0000 0000 0000 07", passkeyMail: "9407 1000 0000 0000 0000 11",
    lockKind: "compromise", lockReason: "Passkey may be compromised", lockedOn: "Oct 11, 2026", rotationRequested: true },
];

// Demo passkeys. Only their hashes are stored.
export const PASSKEYS = {
  "KPII-0001-BD-A00001": "7KQM-R4XW-9TPH-C2NV",
  "KPII-0001-BD-A00002": "HD3F-W8ZK-QM6R-T2YB",
  "KPII-0001-BD-A00004": "N4VP-K9TC-X3HW-R7MJ",
  "KPII-0002-BD-A00001": "W7RK-3MPX-QH9T-F2CN",
};

// Oldest first; the API returns newest first.
export const EVENTS = [
  { bond: "KPII-0001-BD", id: "—", t: "Mar 4, 2026 07:54", ev: "BondAnchored", actor: "ISSUER", ref: "0xa41b7c…88e2" },
  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00001", t: "Mar 6, 2026 08:02", ev: "AssignmentIssued", actor: "ISSUER", ref: "0x83a4c7…2d17" },
  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00001", t: "Mar 11, 2026 09:18", ev: "Accepted", actor: "RELAYER", ref: "—" },
  { bond: "KPII-0002-BD", id: "KPII-0002-BD-A00001", t: "May 22, 2026 10:12", ev: "AssignmentIssued", actor: "ISSUER", ref: "0x7f3d20…aa18" },
  { bond: "KPII-0002-BD", id: "KPII-0002-BD-A00001", t: "May 26, 2026 14:40", ev: "Accepted", actor: "RELAYER", ref: "—" },
  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00002", t: "Jun 22, 2026 11:30", ev: "Accepted", actor: "RELAYER", ref: "—" },
  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00003", t: "Sep 14, 2026 14:22", ev: "AssignedOut", actor: "RELAYER", ref: "0x4a8813…0fd2" },
  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00004", t: "Oct 2, 2026 09:41", ev: "AssignmentIssued", actor: "ISSUER", ref: "0x62de91…c7b8" },
  { bond: "KPII-0001-BD", id: "KPII-0001-BD-A00004", t: "Oct 2, 2026 10:05", ev: "DeliveryRecorded", actor: "ISSUER", ref: "0x8c02fa…66b4" },
  { bond: "KPII-0002-BD", id: "KPII-0002-BD-A00001", t: "Oct 11, 2026 08:47", ev: "Locked", actor: "RELAYER", ref: "—" },
];
