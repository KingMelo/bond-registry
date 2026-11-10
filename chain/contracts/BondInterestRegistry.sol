// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Bond Interest Registry
/// @notice The public, tamper-evident mirror of the bond interest register.
///
/// The private bond stays off-chain. A defined interest in it is divided into
/// units (one unit is one cent), and each assignment of units is a record here.
/// The signed paper and the off-chain register are the legal record; this
/// contract proves the register's history and enforces its rules:
///
///  - No paper, no record: every write carries the hash of the document that
///    authorizes it, and a zero hash is refused.
///  - Units are conserved, per bond:
///        prior + live + unassigned + redeemed == total
///    checked after every write.
///  - Nobody holds tokens and nothing is transferable. There are no balances,
///    no payable functions and no token transfers.
///
/// Roles:
///  - PLATFORM registers each issuer once, with the address (a Safe) that acts for it,
///    and can suspend or reinstate it.
///  - Each issuer's address acts only on that issuer's bonds, and only it can move the
///    issuer to a new address. The platform can't.
///  - RELAYER (the platform's signing key) submits holder-initiated transitions and pays
///    their gas, but can't make them up: each one must carry a signature from the
///    holder's own device key (a passkey, P-256, checked with Polygon's RIP-7212
///    precompile). The only holder-side moves without one are an assignment taking
///    effect after its response period ends unanswered, and a new assignee asking for
///    access before they have a key.
///  - Redemption is the issuer's act alone (redeem): the bond's holder pays under the
///    fiduciary paperwork. Holders don't request it.
///  - GUARDIAN pauses and unpauses in an emergency.
///
/// IDs are bytes32. The platform uses keccak256 of the display ID, for example
/// keccak256("KPII-0001-BD") for a bond and keccak256("KPII-0001-BD-A00001")
/// for an assignment, and keccak256 of the issuer code for an issuer.
///
/// Non-upgradeable: a new version is deployed with its predecessor's address, and copies the
/// predecessor's state from the chain itself (importIssuer, importBond, importPrior,
/// importRecord) once the predecessor is paused for good. Nothing is re-signed or re-entered:
/// records arrive exactly as the predecessor holds them, holder device keys and their counters
/// included, so an upgrade can never rewrite history. Until finishImport, nothing else writes.
/// The getters this contract reads from the version it replaces (v4 and later have them all).
interface IPredecessorRegistry {
    function paused() external view returns (bool);
    function issuers(bytes32 issuerId) external view returns (address account, bool suspended);
    function priorInstruments(bytes32 bondId, bytes32 refHash) external view returns (uint128 units, bool recorded, bool reversed);
    function holderKeys(bytes32 assignmentId) external view returns (uint256 x, uint256 y, uint64 nonce);
    function mailedAt(bytes32 assignmentId) external view returns (uint64);
}

contract BondInterestRegistry is AccessControl, Pausable {
    bytes32 public constant PLATFORM_ROLE = keccak256("PLATFORM_ROLE");
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    enum Status {
        None, // no such record
        AwaitingCredential, // v4 and earlier only: an assign-out waiting for the issuer (v5 opens it at once)
        CredentialRequested, // v4 and earlier only
        Issued,
        Accepted,
        Locked,
        PendingRedemption, // no longer reachable: redemption is the issuer's act (v5); kept so the numbers don't shift
        Redeemed, // terminal
        Superseded, // terminal
        Cancelled, // terminal
        Rejected // terminal: the holder refused the assignment
    }

    enum Origin {
        Issuer,
        AssignOut,
        Replacement
    }

    struct Issuer {
        address account; // the issuer's Safe; zero if never registered
        bool suspended;
    }

    struct Bond {
        bytes32 issuerId;
        bytes32 instrumentHash; // SHA-256 of the bond instrument
        bytes32 ucc1Ref; // hash of the UCC-1 filing details and filed copy
        uint128 total; // fixed at anchoring
        uint128 unassigned;
        uint128 live; // units held by records that are not terminal
        uint128 redeemed; // retired by redemption; never reissued
        uint128 prior; // carried by instruments issued before the registry
        uint64 anchoredAt;
    }

    struct Assignment {
        bytes32 bondId;
        bytes32 parentId; // zero for issuer-originated records
        uint128 units; // kept as history once terminal
        uint32 pendingChildren; // assign-outs not yet Accepted or Cancelled
        Origin origin;
        Status status;
        uint64 updatedAt;
        bytes32 docHash; // the signed assignment instrument
        bytes32 filingRef; // UCC-3 filing
        bytes32 deliveryRef; // certified mail numbers
    }

    struct PriorInstrument {
        uint128 units;
        bool recorded;
        bool reversed;
    }

    /// The holder's device key for a record: a P-256 public key, and a counter that makes
    /// each signature good for one action only.
    struct HolderKey {
        uint256 x;
        uint256 y;
        uint64 nonce;
    }

    /// A WebAuthn assertion: what a passkey produces when it signs. The challenge it signed is
    /// inside clientDataJSON; the contract rebuilds the challenge for the action and checks it.
    struct HolderAuth {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex; // where "challenge":"…" starts in clientDataJSON
        uint256 typeIndex; // where "type":"webauthn.get" starts
        uint256 r;
        uint256 s;
    }

    /// How long a holder has to reject an assignment after it is mailed. Past it, an
    /// unanswered assignment can be recorded as in effect without the holder's signature.
    uint256 public constant RESPONSE_PERIOD = 30 days;
    address internal constant P256_VERIFIER = address(0x100); // RIP-7212
    bytes32 internal constant HOLDER_TAG = keccak256("BondInterestRegistry/holder/v1");

    /// The version this one replaces, or zero. While `migrating`, only imports and finishImport write.
    address public immutable predecessor;
    bool public migrating;

    mapping(bytes32 => Issuer) public issuers;
    mapping(bytes32 => Bond) public bonds;
    mapping(bytes32 => Assignment) public assignments;
    /// @dev bondId => refHash (hash of the instrument's identifier) => entry
    mapping(bytes32 => mapping(bytes32 => PriorInstrument)) public priorInstruments;
    /// assignmentId => the holder's device key
    mapping(bytes32 => HolderKey) public holderKeys;
    /// assignmentId => when the issuer says it was mailed (unix seconds); starts the response period
    mapping(bytes32 => uint64) public mailedAt;

    // ---------------------------------------------------------------- events
    // Every event names the bond, the record (zero when the change is to the
    // bond itself), the authorizing document hash and who signed it.

    event IssuerRegistered(bytes32 indexed issuerId, address account);
    event IssuerAccountChanged(bytes32 indexed issuerId, address account, bytes32 docHash);
    event IssuerSuspended(bytes32 indexed issuerId, bytes32 docHash);
    event IssuerReinstated(bytes32 indexed issuerId, bytes32 docHash);

    event BondAnchored(bytes32 indexed bondId, bytes32 indexed issuerId, uint256 total, bytes32 instrumentHash, bytes32 ucc1Ref, address actor);
    event PriorInstrumentRecorded(bytes32 indexed bondId, bytes32 indexed refHash, uint256 units, bytes32 docHash, address actor);
    event PriorInstrumentReversed(bytes32 indexed bondId, bytes32 indexed refHash, uint256 units, bytes32 reasonHash, address actor);
    event AssignmentIssued(bytes32 indexed bondId, bytes32 indexed assignmentId, uint256 units, bytes32 docHash, address actor);
    event Accepted(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event AssignedOut(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 indexed childId, uint256 units, bytes32 docHash, address actor);
    event AssignOutCancelled(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event Locked(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event Unlocked(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event PasskeyRotated(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event Redeemed(bytes32 indexed bondId, bytes32 indexed assignmentId, uint256 units, bytes32 docHash, address actor);
    event AssignmentReplaced(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 indexed newId, bytes32 docHash, address actor);
    event Superseded(bytes32 indexed bondId, bytes32 indexed assignmentId);
    event AssignmentRejected(bytes32 indexed bondId, bytes32 indexed assignmentId, uint256 units, bytes32 reasonHash, address actor);
    event FilingRecorded(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 filingRef, address actor);
    event DeliveryRecorded(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 deliveryRef, uint64 mailedAt, address actor);
    event HolderKeyRegistered(bytes32 indexed bondId, bytes32 indexed assignmentId, uint256 x, uint256 y, bytes32 docHash, address actor);
    /// `what` is "issuer", "bond", "prior" or "record"; `id` the issuer, bond or record; `sub` the prior's refHash.
    event Imported(string what, bytes32 indexed id, bytes32 indexed sub);
    event ImportFinished(address actor);
    event HolderKeyCleared(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);

    // ---------------------------------------------------------------- errors

    error ZeroHash();
    error ZeroId();
    error ZeroAddress();
    error ZeroUnits();
    error UnknownIssuer(bytes32 issuerId);
    error IssuerExists(bytes32 issuerId);
    error IssuerIsSuspended(bytes32 issuerId);
    error NotIssuer(bytes32 issuerId, address caller);
    error BondExists(bytes32 bondId);
    error UnknownBond(bytes32 bondId);
    error RecordExists(bytes32 assignmentId);
    error UnknownRecord(bytes32 assignmentId);
    error WrongBond(bytes32 assignmentId, bytes32 bondId);
    error WrongStatus(bytes32 assignmentId, Status status);
    error WrongOrigin(bytes32 assignmentId);
    error NotEnoughUnits(uint256 available, uint256 requested);
    error PendingChildren(bytes32 assignmentId, uint32 pending);
    error PriorExists(bytes32 bondId, bytes32 refHash);
    error UnknownPrior(bytes32 bondId, bytes32 refHash);
    error PriorAlreadyReversed(bytes32 bondId, bytes32 refHash);
    error UnitsUnbalanced(bytes32 bondId);
    error NoHolderKey(bytes32 assignmentId);
    error HolderKeyExists(bytes32 assignmentId);
    error BadHolderSignature(bytes32 assignmentId);
    error ResponsePeriodOpen(bytes32 assignmentId, uint256 until);
    error BadMailingDate(uint256 mailedAt);
    error Migrating();
    error NotMigrating();
    error PredecessorNotPaused();
    error AlreadyImported(bytes32 id);
    error NotOnPredecessor(bytes32 id);

    // ------------------------------------------------------------- modifiers

    modifier nonZero(bytes32 h) {
        if (h == bytes32(0)) revert ZeroHash();
        _;
    }

    /// The caller is the active issuer that owns `bondId`.
    modifier onlyIssuerOf(bytes32 bondId) {
        _requireIssuerOf(bondId);
        _;
    }

    /// The relayer, acting on a bond whose issuer is active.
    modifier onlyRelayerOn(bytes32 bondId) {
        _checkRole(RELAYER_ROLE);
        _requireActiveBond(bondId);
        _;
    }

    /// Re-checks the units rule for the bond after the write.
    modifier balanced(bytes32 bondId) {
        _;
        Bond storage b = bonds[bondId];
        if (uint256(b.prior) + b.live + b.unassigned + b.redeemed != b.total) revert UnitsUnbalanced(bondId);
    }

    constructor(address admin, address platform, address relayer, address guardian, address predecessor_) {
        if (admin == address(0) || platform == address(0) || relayer == address(0) || guardian == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PLATFORM_ROLE, platform);
        _grantRole(RELAYER_ROLE, relayer);
        _grantRole(GUARDIAN_ROLE, guardian);
        predecessor = predecessor_;
        migrating = predecessor_ != address(0);
    }

    // ============================================================= migration
    // Copies the predecessor's state, read from the chain. Anyone may call these: the data can
    // only be what the predecessor holds, and only once it is paused, so it can't change after.

    modifier importing() {
        if (!migrating) revert NotMigrating();
        if (!IPredecessorRegistry(predecessor).paused()) revert PredecessorNotPaused();
        _;
    }

    function importIssuer(bytes32 issuerId) external importing {
        (address account, bool suspended) = IPredecessorRegistry(predecessor).issuers(issuerId);
        if (account == address(0)) revert NotOnPredecessor(issuerId);
        if (issuers[issuerId].account != address(0)) revert AlreadyImported(issuerId);
        issuers[issuerId] = Issuer({account: account, suspended: suspended});
        emit Imported("issuer", issuerId, bytes32(0));
    }

    /// The bond with its totals as the predecessor holds them; its records follow by importRecord.
    function importBond(bytes32 bondId) external importing {
        Bond memory b = abi.decode(_fromPredecessor(abi.encodeWithSignature("bonds(bytes32)", bondId)), (Bond));
        if (b.issuerId == bytes32(0)) revert NotOnPredecessor(bondId);
        if (bonds[bondId].issuerId != bytes32(0)) revert AlreadyImported(bondId);
        if (issuers[b.issuerId].account == address(0)) revert UnknownIssuer(b.issuerId);
        bonds[bondId] = b;
        emit Imported("bond", bondId, bytes32(0));
    }

    function importPrior(bytes32 bondId, bytes32 refHash) external importing {
        if (bonds[bondId].issuerId == bytes32(0)) revert UnknownBond(bondId);
        (uint128 units, bool recorded, bool reversed) = IPredecessorRegistry(predecessor).priorInstruments(bondId, refHash);
        if (!recorded) revert NotOnPredecessor(refHash);
        if (priorInstruments[bondId][refHash].recorded) revert AlreadyImported(refHash);
        priorInstruments[bondId][refHash] = PriorInstrument({units: units, recorded: true, reversed: reversed});
        emit Imported("prior", bondId, refHash);
    }

    /// One record exactly as the predecessor holds it, with its holder's device key, the key's
    /// counter and the mailing date. The holder keeps using the same device.
    function importRecord(bytes32 assignmentId) external importing {
        Assignment memory a = abi.decode(_fromPredecessor(abi.encodeWithSignature("assignments(bytes32)", assignmentId)), (Assignment));
        if (a.status == Status.None) revert NotOnPredecessor(assignmentId);
        if (assignments[assignmentId].status != Status.None) revert AlreadyImported(assignmentId);
        if (bonds[a.bondId].issuerId == bytes32(0)) revert UnknownBond(a.bondId);
        // v4 kept a new assign-out waiting for the issuer to activate it; from v5 it's open to the
        // assignee at once, so one still waiting arrives open.
        if (a.origin == Origin.AssignOut && (a.status == Status.AwaitingCredential || a.status == Status.CredentialRequested)) a.status = Status.Issued;
        assignments[assignmentId] = a;
        IPredecessorRegistry p = IPredecessorRegistry(predecessor);
        (uint256 x, uint256 y, uint64 nonce) = p.holderKeys(assignmentId);
        holderKeys[assignmentId] = HolderKey({x: x, y: y, nonce: nonce});
        mailedAt[assignmentId] = p.mailedAt(assignmentId);
        emit Imported("record", assignmentId, a.bondId);
    }

    /// Ends the migration: from here on the contract works normally and imports are closed.
    function finishImport() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!migrating) revert NotMigrating();
        migrating = false;
        emit ImportFinished(msg.sender);
    }

    function _fromPredecessor(bytes memory call) internal view returns (bytes memory out) {
        bool ok;
        (ok, out) = predecessor.staticcall(call);
        if (!ok) revert NotOnPredecessor(bytes32(0));
    }

    /// Every normal write checks this (whenNotPaused), so nothing but imports runs mid-migration.
    function _requireNotPaused() internal view override {
        if (migrating) revert Migrating();
        super._requireNotPaused();
    }

    // ============================================================== platform

    function registerIssuer(bytes32 issuerId, address account) external onlyRole(PLATFORM_ROLE) whenNotPaused {
        if (issuerId == bytes32(0)) revert ZeroId();
        if (account == address(0)) revert ZeroAddress();
        if (issuers[issuerId].account != address(0)) revert IssuerExists(issuerId);
        issuers[issuerId].account = account;
        emit IssuerRegistered(issuerId, account);
    }

    /// Moves an issuer to a new Safe, for example after a signer change.
    /// Moves an issuer to a new account (for example a new Safe). Only the issuer's current account
    /// can do this: the platform registers an issuer once and can suspend or reinstate it, but can
    /// never take over its on-chain identity. Lost keys are recovered inside the issuer's Safe
    /// (by its owners replacing a key), not here. Allowed while suspended, so a compromised account
    /// can be rotated out; the move doesn't lift the suspension.
    function setIssuerAccount(bytes32 issuerId, address account, bytes32 docHash) external whenNotPaused nonZero(docHash) {
        if (account == address(0)) revert ZeroAddress();
        Issuer storage iss = issuers[issuerId];
        if (iss.account == address(0)) revert UnknownIssuer(issuerId);
        if (iss.account != msg.sender) revert NotIssuer(issuerId, msg.sender);
        iss.account = account;
        emit IssuerAccountChanged(issuerId, account, docHash);
    }

    /// A suspended issuer's records stay readable, but nothing on its bonds can change.
    function suspendIssuer(bytes32 issuerId, bytes32 docHash) external onlyRole(PLATFORM_ROLE) whenNotPaused nonZero(docHash) {
        if (issuers[issuerId].account == address(0)) revert UnknownIssuer(issuerId);
        issuers[issuerId].suspended = true;
        emit IssuerSuspended(issuerId, docHash);
    }

    function reinstateIssuer(bytes32 issuerId, bytes32 docHash) external onlyRole(PLATFORM_ROLE) whenNotPaused nonZero(docHash) {
        if (issuers[issuerId].account == address(0)) revert UnknownIssuer(issuerId);
        issuers[issuerId].suspended = false;
        emit IssuerReinstated(issuerId, docHash);
    }

    // ============================================================== guardian

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    // ================================================================ issuer

    /// Anchors an approved bond. Its total, instrument hash and UCC-1 are fixed from here on.
    function anchorBond(bytes32 bondId, bytes32 issuerId, uint128 total, bytes32 instrumentHash, bytes32 ucc1Ref)
        external
        whenNotPaused
        nonZero(instrumentHash)
        nonZero(ucc1Ref)
    {
        if (bondId == bytes32(0)) revert ZeroId();
        Issuer storage iss = issuers[issuerId];
        if (iss.account == address(0)) revert UnknownIssuer(issuerId);
        if (iss.account != msg.sender) revert NotIssuer(issuerId, msg.sender);
        if (iss.suspended) revert IssuerIsSuspended(issuerId);
        if (bonds[bondId].issuerId != bytes32(0)) revert BondExists(bondId);
        if (total == 0) revert ZeroUnits();
        bonds[bondId] = Bond({
            issuerId: issuerId,
            instrumentHash: instrumentHash,
            ucc1Ref: ucc1Ref,
            total: total,
            unassigned: total,
            live: 0,
            redeemed: 0,
            prior: 0,
            anchoredAt: uint64(block.timestamp)
        });
        emit BondAnchored(bondId, issuerId, total, instrumentHash, ucc1Ref, msg.sender);
    }

    /// An instrument issued before the registry (a promissory note, say). It only takes
    /// its units off the bond. `refHash` is the hash of its identifier; `docHash` commits
    /// to the register entry, whose holder name and mailing number stay off-chain.
    function recordPriorInstrument(bytes32 bondId, bytes32 refHash, uint128 units, bytes32 docHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(refHash)
        nonZero(docHash)
        balanced(bondId)
    {
        PriorInstrument storage p = priorInstruments[bondId][refHash];
        if (p.recorded) revert PriorExists(bondId, refHash);
        if (units == 0) revert ZeroUnits();
        Bond storage b = bonds[bondId];
        if (units > b.unassigned) revert NotEnoughUnits(b.unassigned, units);
        b.unassigned -= units;
        b.prior += units;
        p.units = units;
        p.recorded = true;
        emit PriorInstrumentRecorded(bondId, refHash, units, docHash, msg.sender);
    }

    /// For an entry made in error. The entry stays, marked reversed; its units return to unassigned.
    function reversePriorInstrument(bytes32 bondId, bytes32 refHash, bytes32 reasonHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(reasonHash)
        balanced(bondId)
    {
        PriorInstrument storage p = priorInstruments[bondId][refHash];
        if (!p.recorded) revert UnknownPrior(bondId, refHash);
        if (p.reversed) revert PriorAlreadyReversed(bondId, refHash);
        Bond storage b = bonds[bondId];
        p.reversed = true;
        b.prior -= p.units;
        b.unassigned += p.units;
        emit PriorInstrumentReversed(bondId, refHash, p.units, reasonHash, msg.sender);
    }

    function issueAssignment(bytes32 bondId, bytes32 assignmentId, uint128 units, bytes32 docHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(docHash)
        balanced(bondId)
    {
        if (units == 0) revert ZeroUnits();
        Bond storage b = bonds[bondId];
        if (units > b.unassigned) revert NotEnoughUnits(b.unassigned, units);
        _create(bondId, assignmentId, bytes32(0), units, Origin.Issuer, Status.Issued, docHash);
        b.unassigned -= units;
        b.live += units;
        emit AssignmentIssued(bondId, assignmentId, units, docHash, msg.sender);
    }

    /// Records the certified mailing (its tracking number's hash) and the date it was mailed,
    /// which starts the holder's response period. The issuer attests the date; it can't be in
    /// the future.
    function setDeliveryRef(bytes32 bondId, bytes32 assignmentId, bytes32 deliveryRef, uint64 mailedOn)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(deliveryRef)
    {
        if (mailedOn == 0 || mailedOn > block.timestamp) revert BadMailingDate(mailedOn);
        Assignment storage a = _liveRecord(bondId, assignmentId);
        a.deliveryRef = deliveryRef;
        a.updatedAt = uint64(block.timestamp);
        mailedAt[assignmentId] = mailedOn;
        emit DeliveryRecorded(bondId, assignmentId, deliveryRef, mailedOn, msg.sender);
    }

    /// Recovery when a holder loses their device: clears the record's key so the holder can
    /// register a new one after the issuer verifies them and mails a new access code. The
    /// counter keeps going, so nothing the old key signed can be replayed.
    function clearHolderKey(bytes32 bondId, bytes32 assignmentId, bytes32 docHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(docHash)
    {
        _liveRecord(bondId, assignmentId);
        HolderKey storage k = holderKeys[assignmentId];
        if (k.x == 0 && k.y == 0) revert NoHolderKey(assignmentId);
        k.x = 0;
        k.y = 0;
        emit HolderKeyCleared(bondId, assignmentId, docHash, msg.sender);
    }

    function setFilingRef(bytes32 bondId, bytes32 assignmentId, bytes32 filingRef)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(filingRef)
    {
        Assignment storage a = _liveRecord(bondId, assignmentId);
        a.filingRef = filingRef;
        a.updatedAt = uint64(block.timestamp);
        emit FilingRecorded(bondId, assignmentId, filingRef, msg.sender);
    }

    /// The issuer cancels a disputed assign-out, any time before it takes effect.
    function issuerCancelAssignOut(bytes32 bondId, bytes32 childId, bytes32 reasonHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(reasonHash)
        balanced(bondId)
    {
        // A disputed transfer, before it takes effect.
        Assignment storage c = _inStatus(bondId, childId, Status.Issued);
        _cancelChild(bondId, childId, c, reasonHash);
    }



    /// `docHash` is the pledgee's release for a pledge, or the identity verification memo otherwise.
    function unlock(bytes32 bondId, bytes32 assignmentId, bytes32 docHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(docHash)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.Locked);
        _set(a, Status.Accepted);
        emit Unlocked(bondId, assignmentId, docHash, msg.sender);
    }

    /// Records that a locked record's passkey was reissued. The status doesn't change.
    function recordRotation(bytes32 bondId, bytes32 assignmentId, bytes32 docHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(docHash)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.Locked);
        a.updatedAt = uint64(block.timestamp);
        emit PasskeyRotated(bondId, assignmentId, docHash, msg.sender);
    }

    /// Records that a holding was paid out and retires its units for good. Redemption is the
    /// issuer's act: the bond's holder pays under the fiduciary paperwork, and the holder of the
    /// record doesn't ask for it here. Only a record in effect, unlocked, with nothing pending.
    /// `docHash` is the payment confirmation.
    function redeem(bytes32 bondId, bytes32 assignmentId, bytes32 docHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(docHash)
        balanced(bondId)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.Accepted);
        if (a.units == 0) revert ZeroUnits();
        if (a.pendingChildren != 0) revert PendingChildren(assignmentId, a.pendingChildren);
        Bond storage b = bonds[bondId];
        b.live -= a.units;
        b.redeemed += a.units;
        _set(a, Status.Redeemed);
        emit Redeemed(bondId, assignmentId, a.units, docHash, msg.sender);
    }


    /// Supersedes a record with a new one for the same units, for example a reissued
    /// instrument. A Locked record can't be replaced: unlock it first, with the
    /// pledgee's release, so a pledge can't be dropped by replacement.
    function replaceAssignment(bytes32 bondId, bytes32 assignmentId, bytes32 newId, bytes32 docHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(docHash)
        balanced(bondId)
    {
        Assignment storage old = _record(bondId, assignmentId);
        if (old.status != Status.Accepted && old.status != Status.Issued) revert WrongStatus(assignmentId, old.status);
        if (old.pendingChildren != 0) revert PendingChildren(assignmentId, old.pendingChildren);
        uint128 units = old.units;
        // An assign-out replaced before it was accepted resolves its parent's pending count,
        // since the replacement's parent is the old record, not the original assignor.
        bool resolvesParent = old.origin == Origin.AssignOut && old.status == Status.Issued;
        _set(old, Status.Superseded);
        _create(bondId, newId, assignmentId, units, Origin.Replacement, Status.Issued, docHash);
        if (resolvesParent) _childResolved(bondId, old.parentId);
        emit AssignmentReplaced(bondId, assignmentId, newId, docHash, msg.sender);
        emit Superseded(bondId, assignmentId);
    }

    // =============================================================== relayer
    // Holder-initiated transitions, each signed by the holder's device. The relayer can never
    // redeem, unlock, or cancel a child once its assignee has claimed it.

    /// Registers the holder's device key for a record, the first time they sign in. The
    /// assertion must come from that same key (signed over this call), proving the device
    /// holds it. Only one key at a time: replacing it takes the holder's own signature
    /// (rotateHolderKey) or the issuer clearing it for recovery.
    function registerHolderKey(bytes32 bondId, bytes32 assignmentId, uint256 x, uint256 y, bytes32 docHash, HolderAuth calldata auth)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
    {
        Assignment storage a = _liveRecord(bondId, assignmentId);
        if (a.status == Status.AwaitingCredential || a.status == Status.CredentialRequested) revert WrongStatus(assignmentId, a.status);
        HolderKey storage k = holderKeys[assignmentId];
        if (k.x != 0 || k.y != 0) revert HolderKeyExists(assignmentId);
        if (x == 0 && y == 0) revert NoHolderKey(assignmentId);
        _holderSigned(assignmentId, this.registerHolderKey.selector, keccak256(abi.encode(bondId, assignmentId, x, y, docHash)), auth, x, y);
        k.x = x;
        k.y = y;
        emit HolderKeyRegistered(bondId, assignmentId, x, y, docHash, msg.sender);
    }

    /// The holder moves to a new device: signed by the current key.
    function rotateHolderKey(bytes32 bondId, bytes32 assignmentId, uint256 x, uint256 y, bytes32 docHash, HolderAuth calldata auth)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
    {
        _liveRecord(bondId, assignmentId);
        if (x == 0 && y == 0) revert NoHolderKey(assignmentId);
        _byHolder(assignmentId, this.rotateHolderKey.selector, keccak256(abi.encode(bondId, assignmentId, x, y, docHash)), auth);
        HolderKey storage k = holderKeys[assignmentId];
        k.x = x;
        k.y = y;
        emit HolderKeyRegistered(bondId, assignmentId, x, y, docHash, msg.sender);
    }

    /// The holder acknowledges the assignment (signed), or the response period has ended with
    /// no rejection and it takes effect without a signature.
    function accept(bytes32 bondId, bytes32 assignmentId, bytes32 docHash, HolderAuth calldata auth)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.Issued);
        if (auth.r != 0) {
            _byHolder(assignmentId, this.accept.selector, keccak256(abi.encode(bondId, assignmentId, docHash)), auth);
        } else {
            uint256 m = mailedAt[assignmentId];
            if (m == 0 || block.timestamp < m + RESPONSE_PERIOD) revert ResponsePeriodOpen(assignmentId, m == 0 ? 0 : m + RESPONSE_PERIOD);
        }
        _set(a, Status.Accepted);
        if (a.origin == Origin.AssignOut) _childResolved(bondId, a.parentId);
        emit Accepted(bondId, assignmentId, docHash, msg.sender);
    }

    /// The holder assigns part or all of their units to a new party. The child is open at once:
    /// the new party claims it with the transfer code, then accepts or rejects it.
    function assignOut(bytes32 bondId, bytes32 parentId, bytes32 childId, uint128 units, bytes32 docHash, HolderAuth calldata auth)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
        balanced(bondId)
    {
        Assignment storage p = _inStatus(bondId, parentId, Status.Accepted);
        _byHolder(parentId, this.assignOut.selector, keccak256(abi.encode(bondId, parentId, childId, units, docHash)), auth);
        if (units == 0) revert ZeroUnits();
        if (units > p.units) revert NotEnoughUnits(p.units, units);
        p.units -= units;
        p.pendingChildren += 1;
        p.updatedAt = uint64(block.timestamp);
        // Open to the assignee at once: they claim it with the transfer code, then accept or reject.
        _create(bondId, childId, parentId, units, Origin.AssignOut, Status.Issued, docHash);
        emit AssignedOut(bondId, parentId, childId, units, docHash, msg.sender);
    }

    /// The holder refuses an assignment before it takes effect. Its units go back where they
    /// came from: to the assignor's record for an assign-out, otherwise to the bond's unassigned
    /// balance. An assignment the holder doesn't reject takes effect through `accept`, either
    /// when they acknowledge it or when the response period ends.
    function rejectAssignment(bytes32 bondId, bytes32 assignmentId, bytes32 reasonHash, HolderAuth calldata auth)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(reasonHash)
        balanced(bondId)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.Issued);
        _byHolder(assignmentId, this.rejectAssignment.selector, keccak256(abi.encode(bondId, assignmentId, reasonHash)), auth);
        if (a.pendingChildren != 0) revert PendingChildren(assignmentId, a.pendingChildren);
        if (a.origin == Origin.AssignOut) {
            Assignment storage p = assignments[a.parentId];
            if (isTerminal(p.status) || p.status == Status.PendingRedemption) revert WrongStatus(a.parentId, p.status);
            p.units += a.units;
            p.pendingChildren -= 1;
            p.updatedAt = uint64(block.timestamp);
        } else {
            Bond storage b = bonds[bondId];
            b.live -= a.units;
            b.unassigned += a.units;
        }
        _set(a, Status.Rejected);
        emit AssignmentRejected(bondId, assignmentId, a.units, reasonHash, msg.sender);
    }

    /// The assignor cancels an assign-out the assignee hasn't claimed yet, signed with the assignor's key.
    function cancelAssignOut(bytes32 bondId, bytes32 childId, bytes32 docHash, HolderAuth calldata auth)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
        balanced(bondId)
    {
        Assignment storage c = _inStatus(bondId, childId, Status.Issued);
        // Only until the assignee has claimed it (set up their device).
        if (holderKeys[childId].x != 0 || holderKeys[childId].y != 0) revert HolderKeyExists(childId);
        _byHolder(c.parentId, this.cancelAssignOut.selector, keccak256(abi.encode(bondId, childId, docHash)), auth);
        _cancelChild(bondId, childId, c, docHash);
    }


    /// `docHash` is the hash of the holder's lock notice.
    function lock(bytes32 bondId, bytes32 assignmentId, bytes32 docHash, HolderAuth calldata auth)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.Accepted);
        _byHolder(assignmentId, this.lock.selector, keccak256(abi.encode(bondId, assignmentId, docHash)), auth);
        _set(a, Status.Locked);
        emit Locked(bondId, assignmentId, docHash, msg.sender);
    }


    // ================================================================= views

    /// The four lines of the units rule, and whether they add up to the total.
    function bondTotals(bytes32 bondId)
        external
        view
        returns (uint256 total, uint256 prior, uint256 live, uint256 unassigned, uint256 redeemed, bool reconciled)
    {
        Bond storage b = bonds[bondId];
        total = b.total;
        prior = b.prior;
        live = b.live;
        unassigned = b.unassigned;
        redeemed = b.redeemed;
        reconciled = prior + live + unassigned + redeemed == total;
    }

    /// What the holder's key must sign for a call: bound to this chain, this contract, the record
    /// whose key signs, its current counter, the function and its arguments.
    function holderChallenge(bytes32 signerId, bytes4 selector, bytes32 argsHash) public view returns (bytes32) {
        return keccak256(abi.encode(HOLDER_TAG, block.chainid, address(this), signerId, holderKeys[signerId].nonce, selector, argsHash));
    }

    function isTerminal(Status s) public pure returns (bool) {
        return s == Status.Redeemed || s == Status.Superseded || s == Status.Cancelled || s == Status.Rejected;
    }

    // ============================================================== internal

    function _requireActiveBond(bytes32 bondId) internal view returns (Bond storage b) {
        b = bonds[bondId];
        if (b.issuerId == bytes32(0)) revert UnknownBond(bondId);
        if (issuers[b.issuerId].suspended) revert IssuerIsSuspended(b.issuerId);
    }

    function _requireIssuerOf(bytes32 bondId) internal view {
        Bond storage b = _requireActiveBond(bondId);
        if (issuers[b.issuerId].account != msg.sender) revert NotIssuer(b.issuerId, msg.sender);
    }

    function _record(bytes32 bondId, bytes32 id) internal view returns (Assignment storage a) {
        a = assignments[id];
        if (a.status == Status.None) revert UnknownRecord(id);
        if (a.bondId != bondId) revert WrongBond(id, bondId);
    }

    function _liveRecord(bytes32 bondId, bytes32 id) internal view returns (Assignment storage a) {
        a = _record(bondId, id);
        if (isTerminal(a.status)) revert WrongStatus(id, a.status);
    }

    function _inStatus(bytes32 bondId, bytes32 id, Status s) internal view returns (Assignment storage a) {
        a = _record(bondId, id);
        if (a.status != s) revert WrongStatus(id, a.status);
    }

    function _create(bytes32 bondId, bytes32 id, bytes32 parentId, uint128 units, Origin origin, Status status, bytes32 docHash)
        internal
    {
        if (id == bytes32(0)) revert ZeroId();
        if (assignments[id].status != Status.None) revert RecordExists(id);
        assignments[id] = Assignment({
            bondId: bondId,
            parentId: parentId,
            units: units,
            pendingChildren: 0,
            origin: origin,
            status: status,
            updatedAt: uint64(block.timestamp),
            docHash: docHash,
            filingRef: bytes32(0),
            deliveryRef: bytes32(0)
        });
    }

    function _set(Assignment storage a, Status s) internal {
        a.status = s;
        a.updatedAt = uint64(block.timestamp);
    }

    /// Cancels an assign-out child: its units go back to the parent. Units stay live
    /// throughout, so the bond's lines don't move.
    function _cancelChild(bytes32 bondId, bytes32 childId, Assignment storage c, bytes32 docHash) internal {
        if (c.origin != Origin.AssignOut) revert WrongOrigin(childId);
        Assignment storage p = assignments[c.parentId];
        // A parent with pending children can't be redeemed, replaced or superseded,
        // so it is always live here; checked anyway so units never reach a terminal record.
        if (isTerminal(p.status) || p.status == Status.PendingRedemption) revert WrongStatus(c.parentId, p.status);
        p.units += c.units;
        p.pendingChildren -= 1;
        p.updatedAt = uint64(block.timestamp);
        _set(c, Status.Cancelled);
        emit AssignOutCancelled(bondId, childId, docHash, msg.sender);
    }

    /// An assign-out child was accepted (or replaced before acceptance). The parent closes
    /// as Superseded once it has nothing left and nothing pending.
    function _childResolved(bytes32 bondId, bytes32 parentId) internal {
        Assignment storage p = assignments[parentId];
        p.pendingChildren -= 1;
        p.updatedAt = uint64(block.timestamp);
        if (p.units == 0 && p.pendingChildren == 0 && (p.status == Status.Accepted || p.status == Status.Locked)) {
            p.status = Status.Superseded;
            emit Superseded(bondId, parentId);
        }
    }

    // ------------------------------------------------------------ holder keys

    /// The record's own key must have signed this call.
    function _byHolder(bytes32 signerId, bytes4 selector, bytes32 argsHash, HolderAuth calldata auth) internal {
        HolderKey storage k = holderKeys[signerId];
        if (k.x == 0 && k.y == 0) revert NoHolderKey(signerId);
        _holderSigned(signerId, selector, argsHash, auth, k.x, k.y);
    }

    function _holderSigned(bytes32 signerId, bytes4 selector, bytes32 argsHash, HolderAuth calldata auth, uint256 x, uint256 y) internal {
        bytes32 challenge = holderChallenge(signerId, selector, argsHash);
        if (!_verifyWebAuthn(challenge, auth, x, y)) revert BadHolderSignature(signerId);
        holderKeys[signerId].nonce += 1;
    }

    /// Checks a WebAuthn assertion: the user was present and verified on the device, it is a
    /// sign-in ("webauthn.get") over exactly this challenge, and the P-256 signature over
    /// authenticatorData || sha256(clientDataJSON) is valid for the key.
    function _verifyWebAuthn(bytes32 challenge, HolderAuth calldata auth, uint256 x, uint256 y) internal view returns (bool) {
        bytes calldata ad = auth.authenticatorData;
        if (ad.length < 37) return false;
        uint8 flags = uint8(ad[32]);
        if (flags & 0x01 == 0 || flags & 0x04 == 0) return false; // user present, user verified
        bytes memory cd = bytes(auth.clientDataJSON);
        if (!_at(cd, auth.typeIndex, bytes('"type":"webauthn.get"'))) return false;
        if (!_at(cd, auth.challengeIndex, abi.encodePacked('"challenge":"', _base64url(challenge), '"'))) return false;
        bytes32 h = sha256(abi.encodePacked(ad, sha256(cd)));
        (bool ok, bytes memory out) = P256_VERIFIER.staticcall(abi.encode(h, auth.r, auth.s, x, y));
        return ok && out.length == 32 && abi.decode(out, (uint256)) == 1;
    }

    function _at(bytes memory hay, uint256 index, bytes memory needle) internal pure returns (bool) {
        if (index + needle.length > hay.length) return false;
        for (uint256 i = 0; i < needle.length; i++) if (hay[index + i] != needle[i]) return false;
        return true;
    }

    /// Unpadded base64url of 32 bytes (43 characters), as WebAuthn writes the challenge.
    function _base64url(bytes32 d) internal pure returns (bytes memory out) {
        bytes memory T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        out = new bytes(43);
        uint256 j;
        for (uint256 i = 0; i < 30; i += 3) {
            uint256 n = (uint256(uint8(d[i])) << 16) | (uint256(uint8(d[i + 1])) << 8) | uint256(uint8(d[i + 2]));
            out[j++] = T[(n >> 18) & 63];
            out[j++] = T[(n >> 12) & 63];
            out[j++] = T[(n >> 6) & 63];
            out[j++] = T[n & 63];
        }
        uint256 m = (uint256(uint8(d[30])) << 16) | (uint256(uint8(d[31])) << 8);
        out[40] = T[(m >> 18) & 63];
        out[41] = T[(m >> 12) & 63];
        out[42] = T[(m >> 6) & 63];
    }
}
