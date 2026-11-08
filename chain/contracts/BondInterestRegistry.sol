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
///  - PLATFORM registers issuers and the address (a 2-of-3 Safe) that acts for each.
///  - Each issuer's address acts only on that issuer's bonds.
///  - RELAYER (the platform's signing key) makes holder-initiated transitions only.
///  - GUARDIAN pauses and unpauses in an emergency.
///
/// IDs are bytes32. The platform uses keccak256 of the display ID, for example
/// keccak256("KPII-0001-BD") for a bond and keccak256("KPII-0001-BD-A00001")
/// for an assignment, and keccak256 of the issuer code for an issuer.
///
/// Non-upgradeable: a new version is deployed and records migrated with a
/// published mapping, so an upgrade can never rewrite history.
contract BondInterestRegistry is AccessControl, Pausable {
    bytes32 public constant PLATFORM_ROLE = keccak256("PLATFORM_ROLE");
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    enum Status {
        None, // no such record
        AwaitingCredential,
        CredentialRequested,
        Issued,
        Accepted,
        Locked,
        PendingRedemption,
        Redeemed, // terminal
        Superseded, // terminal
        Cancelled // terminal
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

    mapping(bytes32 => Issuer) public issuers;
    mapping(bytes32 => Bond) public bonds;
    mapping(bytes32 => Assignment) public assignments;
    /// @dev bondId => refHash (hash of the instrument's identifier) => entry
    mapping(bytes32 => mapping(bytes32 => PriorInstrument)) public priorInstruments;

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
    event CredentialRequested(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event CredentialRequestRejected(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event CredentialIssued(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event Locked(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event Unlocked(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event PasskeyRotated(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event RedemptionRequested(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event Redeemed(bytes32 indexed bondId, bytes32 indexed assignmentId, uint256 units, bytes32 docHash, address actor);
    event RedemptionRejected(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 docHash, address actor);
    event AssignmentReplaced(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 indexed newId, bytes32 docHash, address actor);
    event Superseded(bytes32 indexed bondId, bytes32 indexed assignmentId);
    event FilingRecorded(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 filingRef, address actor);
    event DeliveryRecorded(bytes32 indexed bondId, bytes32 indexed assignmentId, bytes32 deliveryRef, address actor);

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
    error FilingNotRecorded(bytes32 assignmentId);
    error PriorExists(bytes32 bondId, bytes32 refHash);
    error UnknownPrior(bytes32 bondId, bytes32 refHash);
    error PriorAlreadyReversed(bytes32 bondId, bytes32 refHash);
    error UnitsUnbalanced(bytes32 bondId);

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

    constructor(address admin, address platform, address relayer, address guardian) {
        if (admin == address(0) || platform == address(0) || relayer == address(0) || guardian == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PLATFORM_ROLE, platform);
        _grantRole(RELAYER_ROLE, relayer);
        _grantRole(GUARDIAN_ROLE, guardian);
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
    function setIssuerAccount(bytes32 issuerId, address account, bytes32 docHash)
        external
        onlyRole(PLATFORM_ROLE)
        whenNotPaused
        nonZero(docHash)
    {
        if (account == address(0)) revert ZeroAddress();
        if (issuers[issuerId].account == address(0)) revert UnknownIssuer(issuerId);
        issuers[issuerId].account = account;
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

    function setDeliveryRef(bytes32 bondId, bytes32 assignmentId, bytes32 deliveryRef)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(deliveryRef)
    {
        Assignment storage a = _liveRecord(bondId, assignmentId);
        a.deliveryRef = deliveryRef;
        a.updatedAt = uint64(block.timestamp);
        emit DeliveryRecorded(bondId, assignmentId, deliveryRef, msg.sender);
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

    /// The issuer cancels a disputed assign-out, before or after the assignee has come forward.
    function issuerCancelAssignOut(bytes32 bondId, bytes32 childId, bytes32 reasonHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(reasonHash)
        balanced(bondId)
    {
        Assignment storage c = _record(bondId, childId);
        if (c.status != Status.AwaitingCredential && c.status != Status.CredentialRequested) revert WrongStatus(childId, c.status);
        _cancelChild(bondId, childId, c, reasonHash);
    }

    function rejectCredentialRequest(bytes32 bondId, bytes32 assignmentId, bytes32 reasonHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(reasonHash)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.CredentialRequested);
        _set(a, Status.AwaitingCredential);
        emit CredentialRequestRejected(bondId, assignmentId, reasonHash, msg.sender);
    }

    /// Activates the new holder of an assign-out. The UCC-3 must be on record first.
    function issueCredential(bytes32 bondId, bytes32 assignmentId, bytes32 docHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(docHash)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.CredentialRequested);
        if (a.filingRef == bytes32(0)) revert FilingNotRecorded(assignmentId);
        _set(a, Status.Issued);
        emit CredentialIssued(bondId, assignmentId, docHash, msg.sender);
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

    function approveRedemption(bytes32 bondId, bytes32 assignmentId, bytes32 docHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(docHash)
        balanced(bondId)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.PendingRedemption);
        Bond storage b = bonds[bondId];
        b.live -= a.units;
        b.redeemed += a.units;
        _set(a, Status.Redeemed);
        emit Redeemed(bondId, assignmentId, a.units, docHash, msg.sender);
    }

    function rejectRedemption(bytes32 bondId, bytes32 assignmentId, bytes32 reasonHash)
        external
        whenNotPaused
        onlyIssuerOf(bondId)
        nonZero(reasonHash)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.PendingRedemption);
        _set(a, Status.Accepted);
        emit RedemptionRejected(bondId, assignmentId, reasonHash, msg.sender);
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
    // Holder-initiated transitions. The relayer can never redeem, unlock, activate a
    // new holder, or cancel a child once its assignee has come forward.

    function accept(bytes32 bondId, bytes32 assignmentId, bytes32 docHash)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.Issued);
        _set(a, Status.Accepted);
        if (a.origin == Origin.AssignOut) _childResolved(bondId, a.parentId);
        emit Accepted(bondId, assignmentId, docHash, msg.sender);
    }

    /// The holder assigns part or all of their units to a new party. The child waits,
    /// locked, until the new party comes forward and the issuer activates them.
    function assignOut(bytes32 bondId, bytes32 parentId, bytes32 childId, uint128 units, bytes32 docHash)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
        balanced(bondId)
    {
        Assignment storage p = _inStatus(bondId, parentId, Status.Accepted);
        if (units == 0) revert ZeroUnits();
        if (units > p.units) revert NotEnoughUnits(p.units, units);
        p.units -= units;
        p.pendingChildren += 1;
        p.updatedAt = uint64(block.timestamp);
        _create(bondId, childId, parentId, units, Origin.AssignOut, Status.AwaitingCredential, docHash);
        emit AssignedOut(bondId, parentId, childId, units, docHash, msg.sender);
    }

    /// The assignor cancels an assign-out nobody has claimed yet.
    function cancelAssignOut(bytes32 bondId, bytes32 childId, bytes32 docHash)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
        balanced(bondId)
    {
        Assignment storage c = _inStatus(bondId, childId, Status.AwaitingCredential);
        _cancelChild(bondId, childId, c, docHash);
    }

    function requestCredential(bytes32 bondId, bytes32 assignmentId, bytes32 docHash)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.AwaitingCredential);
        _set(a, Status.CredentialRequested);
        emit CredentialRequested(bondId, assignmentId, docHash, msg.sender);
    }

    /// `docHash` is the hash of the holder's lock notice.
    function lock(bytes32 bondId, bytes32 assignmentId, bytes32 docHash)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.Accepted);
        _set(a, Status.Locked);
        emit Locked(bondId, assignmentId, docHash, msg.sender);
    }

    function requestRedemption(bytes32 bondId, bytes32 assignmentId, bytes32 docHash)
        external
        whenNotPaused
        onlyRelayerOn(bondId)
        nonZero(docHash)
    {
        Assignment storage a = _inStatus(bondId, assignmentId, Status.Accepted);
        if (a.units == 0) revert ZeroUnits();
        if (a.pendingChildren != 0) revert PendingChildren(assignmentId, a.pendingChildren);
        _set(a, Status.PendingRedemption);
        emit RedemptionRequested(bondId, assignmentId, docHash, msg.sender);
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

    function isTerminal(Status s) public pure returns (bool) {
        return s == Status.Redeemed || s == Status.Superseded || s == Status.Cancelled;
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
}
