// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface ISoulKey {
    function burnByVault(uint256 tokenId) external;

    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title MasterKeyVault
 * @notice Master contract: holds all funds, manages registered SoulKey game
 *         contracts, and handles refunds. Deploy once; register many games.
 *         No time locks, Multisig is required. Critical functions withdrawAll,
 *         registerGame should not rely on a single EOA.
 *
 * Reserve lifecycle per payment:
 *   Locked → ReleasedByClaim   (CD key claimed — refund permanently blocked)
 *   Locked → ReleasedByExpiry  (14-day window expired — refund permanently blocked)
 *   Locked → Refunded          (permissionless, NFT minter triggered refund within window;
 *                              fee retained)
 *
 * Anti-DoS: refunds deduct a configurable fee (default 5%). This makes
 * supply-griefing (mint all → refund before expiry) economically irrational.
 *
 * releaseReserveOnExpiry is permissionless once the window has passed so
 * reserve unlocking never depends on owner liveness.
 */
contract MasterKeyVault is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    address public constant ETH_TOKEN = address(0);
    uint256 public constant REFUND_WINDOW = 14 days;
    uint256 public constant MAX_REFUND_FEE_BPS = 1000; // 10% hard cap
    uint256 public constant MAX_BATCH_SIZE = 100;

    // ============ Types ============

    /**
     * @notice Tracks the lifecycle state of a single payment.
     * Locked           — window active, refund still possible
     * ReleasedByClaim  — CD key was claimed; reserve freed, refund blocked
     * ReleasedByExpiry — 14-day window elapsed; reserve freed, refund blocked
     * Refunded         — token holder processed a refund within the window;
     *                    fee retained, remainder returned
     */
    enum ReserveStatus {
        Locked,
        ReleasedByClaim,
        ReleasedByExpiry,
        Refunded
    }

    struct PaymentRecord {
        address paymentToken; // address(0) = ETH
        uint48 paidAt;
        ReserveStatus status;
        uint256 amount;
        address payer;
    }

    // ============ State Variables ============

    IERC20 public USDT;
    IERC20 public USDC;

    /// @notice Fee retained from refunds in basis points (default 500 = 5%)
    uint256 public refundFeeBps = 500;

    /// @notice Tracks all token addresses ever used as payment to guard emergencyWithdraw
    mapping(address => bool) private _isManagedToken;

    mapping(address => bool) public registeredGames;

    /// @notice On-chain receipt per mint: (soulKeyContract => tokenId => PaymentRecord)
    mapping(address => mapping(uint256 => PaymentRecord)) public paymentRecords;

    /// @notice Funds currently locked as refund reserves — never withdrawable until released
    uint256 public reservedETH;
    mapping(address => uint256) public reservedERC20;

    // ============ Events ============

    event GameRegistered(address indexed soulKeyContract);
    event GameDeregistered(address indexed soulKeyContract);
    event PaymentCollected(
        address indexed soulKeyContract,
        uint256 indexed tokenId,
        address indexed payer,
        address paymentToken,
        uint256 amount
    );
    event RefundIssued(
        address indexed soulKeyContract,
        uint256 indexed tokenId,
        address indexed recipient,
        address paymentToken,
        uint256 refundedAmount,
        uint256 feeRetained,
        string reason
    );
    event ReserveReleased(
        address indexed soulKeyContract,
        uint256 indexed tokenId,
        address paymentToken,
        uint256 amount,
        ReserveStatus releaseReason
    );
    event RefundFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event PaymentTokenUpdated(
        address indexed token,
        address indexed newAddress
    );
    event ManagedTokenCleared(address token);

    // ============ Errors ============

    error NotRegisteredGame();
    error ZeroAddress();
    error AlreadyProcessed();
    error NoPaymentRecord();
    error RefundTransferFailed();
    error InsufficientVaultBalance();
    error RefundWindowExpired();
    error RefundWindowActive();
    error ReserveNotLocked();
    error CannotWithdrawManagedToken();
    error ArrayLengthMismatch();
    error FeeTooHigh();
    error ReserveNotZero();
    error ClaimantMismatch();
    error BatchTooLarge();
    error NotTokenOwner();

    // ============ Modifiers ============

    modifier onlyRegisteredGame() {
        if (!registeredGames[msg.sender]) revert NotRegisteredGame();
        _;
    }

    // ============ Constructor ============

    constructor(address usdtAddress, address usdcAddress) Ownable(msg.sender) {
        if (usdtAddress == address(0) || usdcAddress == address(0))
            revert ZeroAddress();
        USDT = IERC20(usdtAddress);
        USDC = IERC20(usdcAddress);
        _isManagedToken[usdtAddress] = true;
        _isManagedToken[usdcAddress] = true;
    }

    // ============ Token Address Getters ============

    function getUSDT() external view returns (address) {
        return address(USDT);
    }

    function getUSDC() external view returns (address) {
        return address(USDC);
    }

    // ============ Game Registry ============

    function registerGame(address soulKeyContract) external onlyOwner {
        if (soulKeyContract == address(0)) revert ZeroAddress();
        registeredGames[soulKeyContract] = true;
        emit GameRegistered(soulKeyContract);
    }

    function deregisterGame(address soulKeyContract) external onlyOwner {
        registeredGames[soulKeyContract] = false;
        emit GameDeregistered(soulKeyContract);
    }

    // ============ Payment Collection ============

    /**
     * @notice Called by a registered SoulKey contract after a successful mint.
     *         Locks the payment in the refund reserve.
     *
     * @dev ETH: SoulKey forwards msg.value with this call.
     *      ERC20: SoulKey calls safeTransferFrom(user, address(vault), amount)
     *      before calling collectPayment — tokens must already be here.
     *      Balance check prevents a buggy SoulKey fork from inflating the
     *      reserve counter without actually transferring tokens.
     */
    function collectPayment(
        uint256 tokenId,
        address payer,
        address payToken,
        uint256 amount
    ) external payable onlyRegisteredGame whenNotPaused {
        if (payer == address(0)) revert ZeroAddress();

        if (payToken == ETH_TOKEN) {
            require(msg.value == amount, "ETH amount mismatch");
            reservedETH += amount;
        } else {
            require(
                IERC20(payToken).balanceOf(address(this)) >=
                    reservedERC20[payToken] + amount,
                "Tokens not received"
            );
            reservedERC20[payToken] += amount;
        }

        paymentRecords[msg.sender][tokenId] = PaymentRecord({
            paymentToken: payToken,
            amount: amount,
            payer: payer,
            paidAt: uint48(block.timestamp), // explicit cast to pack the struct
            status: ReserveStatus.Locked
        });

        emit PaymentCollected(msg.sender, tokenId, payer, payToken, amount);
    }

    // ============ Reserve Release ============

    /**
     * @notice Called by a registered SoulKey contract when a CD key is claimed.
     *         Frees the reserve immediately — a claimed key is non-refundable.
     * @dev The vault cross-checks that claimant actually owns the token by calling
     *      back into the game contract. This prevents a buggy game contract from
     *      releasing reserves without a genuine claim having occurred.
     *      Records are keyed by (msg.sender, tokenId) so cross-game manipulation
     *      is structurally impossible. It seems that the function has a check after
     *      the effect (CEI), but in reality the effect comes before the interaction
     *      (external call) and this format follows CEI more closely.
     * @param tokenId  The token whose CD key was just claimed
     * @param claimant The address that called claimCdKey — verified against ownerOf
     */
    function releaseReserveOnClaim(
        uint256 tokenId,
        address claimant
    ) external onlyRegisteredGame nonReentrant {
        PaymentRecord storage record = paymentRecords[msg.sender][tokenId];
        if (record.payer == address(0)) revert NoPaymentRecord();
        if (record.status != ReserveStatus.Locked) revert ReserveNotLocked();

        record.status = ReserveStatus.ReleasedByClaim;
        _releaseReserve(record.paymentToken, record.amount);

        // Cross-check: verify claimant actually owns this token in the calling contract
        if (ISoulKey(msg.sender).ownerOf(tokenId) != claimant)
            revert ClaimantMismatch();

        emit ReserveReleased(
            msg.sender,
            tokenId,
            record.paymentToken,
            record.amount,
            ReserveStatus.ReleasedByClaim
        );
    }

    /**
     * @notice Permissionless: anyone may release the reserve once the 14-day
     *         refund window has expired. Backend cron, third party, or the
     *         buyer themselves can call this — no owner dependency.
     */
    function releaseReserveOnExpiry(
        address soulKeyContract,
        uint256 tokenId
    ) external {
        PaymentRecord storage record = paymentRecords[soulKeyContract][tokenId];
        if (record.payer == address(0)) revert NoPaymentRecord();
        if (record.status != ReserveStatus.Locked) revert ReserveNotLocked();
        if (block.timestamp < record.paidAt + REFUND_WINDOW)
            revert RefundWindowActive();

        record.status = ReserveStatus.ReleasedByExpiry;
        _releaseReserve(record.paymentToken, record.amount);

        emit ReserveReleased(
            soulKeyContract,
            tokenId,
            record.paymentToken,
            record.amount,
            ReserveStatus.ReleasedByExpiry
        );
    }

    /**
     * @notice Batch expiry release for backend cron efficiency.
     *         Skips ineligible entries rather than reverting the whole batch.
     */
    function batchReleaseReserveOnExpiry(
        address[] calldata soulKeyContracts,
        uint256[] calldata tokenIds
    ) external {
        if (soulKeyContracts.length != tokenIds.length)
            revert ArrayLengthMismatch();
        if (soulKeyContracts.length > MAX_BATCH_SIZE) revert BatchTooLarge();

        for (uint256 i = 0; i < soulKeyContracts.length; i++) {
            PaymentRecord storage record = paymentRecords[soulKeyContracts[i]][
                tokenIds[i]
            ];
            if (
                record.payer != address(0) &&
                record.status == ReserveStatus.Locked &&
                block.timestamp >= record.paidAt + REFUND_WINDOW
            ) {
                record.status = ReserveStatus.ReleasedByExpiry;
                _releaseReserve(record.paymentToken, record.amount);
                emit ReserveReleased(
                    soulKeyContracts[i],
                    tokenIds[i],
                    record.paymentToken,
                    record.amount,
                    ReserveStatus.ReleasedByExpiry
                );
            }
        }
    }

    function _releaseReserve(address payToken, uint256 amount) private {
        if (payToken == ETH_TOKEN) {
            reservedETH -= amount;
        } else {
            reservedERC20[payToken] -= amount;
        }
    }

    // ============ Refunds ============

    /**
     * @notice Process a refund and atomically burn the NFT in one transaction.
     *
     * @dev Anti-DoS fee: a percentage of the payment is retained by the vault.
     *      This makes supply-griefing (mint all supply → refund before expiry to
     *      block others at zero cost) economically irrational. Default fee is 5%.
     *
     *      The fee can be set to 0%. We'll see how is the reception of the refund
     *      fee.
     *
     *      Recipient is derived on-chain from the current token owner — not
     *      supplied by the caller — to prevent operator error when a token has
     *      been transferred since minting.
     *
     *      CEI + reentrancy guard order:
     *        1. Validate all conditions
     *        2. Resolve current token owner (before burn clears it)
     *        3. Update state (status, release reserve)
     *        4. Burn NFT via callback (no funds involved)
     *        5. Transfer refund amount (most dangerous step — last)
     *
     *      The backend writes refund_tx_hash, block_number, refunded_by, and
     *      refund_reason to the `refunds` table from the RefundIssued event.
     *
     * @param soulKeyContract  Registered SoulKey contract the token belongs to
     * @param tokenId          Token being refunded
     * @param reason           Written to refund_reason in DB via event
     */
    function processRefund(
        address soulKeyContract,
        uint256 tokenId,
        string
            calldata reason /** Informative. Customers can share their reasons for a refund.
            For gas savings it can be bytes32 with predefined reasons. */
    ) external nonReentrant {
        if (!registeredGames[soulKeyContract]) revert NotRegisteredGame();

        PaymentRecord storage record = paymentRecords[soulKeyContract][tokenId];
        if (record.payer == address(0)) revert NoPaymentRecord();
        if (record.status == ReserveStatus.Refunded) revert AlreadyProcessed();
        if (record.status != ReserveStatus.Locked) revert ReserveNotLocked();
        if (block.timestamp > record.paidAt + REFUND_WINDOW)
            revert RefundWindowExpired();

        // Resolve current holder before burn clears ownerOf
        address recipient = ISoulKey(soulKeyContract).ownerOf(tokenId);

        // Caller must be the current token holder
        if (msg.sender != recipient) revert NotTokenOwner();

        // Compute fee retained by vault as anti-DoS penalty
        uint256 fee = (record.amount * refundFeeBps) / 10_000;
        uint256 refundAmount = record.amount - fee;

        address payToken = record.paymentToken;
        uint256 fullAmount = record.amount;

        // Effects — update state before any external calls
        record.status = ReserveStatus.Refunded;
        _releaseReserve(payToken, fullAmount);
        // fee implicitly stays in vault (not re-reserved, becomes free revenue)

        // Burn NFT atomically — only the trusted vault can trigger burnByVault
        ISoulKey(soulKeyContract).burnByVault(tokenId);

        // Transfer refund (minus fee) to current token holder
        if (payToken == ETH_TOKEN) {
            if (address(this).balance < refundAmount)
                revert InsufficientVaultBalance();
            (bool success, ) = payable(recipient).call{value: refundAmount}("");
            if (!success) revert RefundTransferFailed();
        } else {
            IERC20 token = IERC20(payToken);
            if (token.balanceOf(address(this)) < refundAmount)
                revert InsufficientVaultBalance();
            token.safeTransfer(recipient, refundAmount);
        }

        emit RefundIssued(
            soulKeyContract,
            tokenId,
            recipient,
            payToken,
            refundAmount,
            fee,
            reason
        );
    }

    // ============ Views ============

    function getPaymentRecord(
        address soulKeyContract,
        uint256 tokenId
    ) external view returns (PaymentRecord memory) {
        return paymentRecords[soulKeyContract][tokenId];
    }

    function isRefundable(
        address soulKeyContract,
        uint256 tokenId
    ) external view returns (bool) {
        PaymentRecord storage r = paymentRecords[soulKeyContract][tokenId];
        return (r.payer != address(0) &&
            r.status == ReserveStatus.Locked &&
            block.timestamp <= r.paidAt + REFUND_WINDOW);
    }

    /// @notice Withdrawable ETH = total balance minus locked reserve
    function withdrawableETH() external view returns (uint256) {
        return address(this).balance - reservedETH;
    }

    /// @notice Withdrawable ERC-20 = total balance minus locked reserve
    function withdrawableERC20(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this)) - reservedERC20[token];
    }

    // ============ Admin ============

    /**
     * @notice Update the refund fee percentage.
     * @param newFeeBps Fee in basis points. 500 = 5%. Hard cap at 10%.
     */
    function setRefundFee(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_REFUND_FEE_BPS) revert FeeTooHigh();
        emit RefundFeeUpdated(refundFeeBps, newFeeBps);
        refundFeeBps = newFeeBps;
    }

    /**
     * @notice setPaymentTokens is split in two. If one payment address changes
     *         it doesn't block the other. Update the USDC payment token address.
     * @dev The old address remains marked as managed until its reserves
     *      are zero. Call clearManagedToken() after all pending refunds settle.
     */
    function setPaymentTokenUSDC(address usdcAddress) external onlyOwner {
        if (usdcAddress == address(0)) revert ZeroAddress();
        if (reservedERC20[address(USDC)] != 0) revert ReserveNotZero(); // force clearManagedToken first
        // Mark new addresses as managed
        _isManagedToken[usdcAddress] = true;
        address oldAddress = address(USDC); // ← capture before overwrite
        USDC = IERC20(usdcAddress);
        emit PaymentTokenUpdated(oldAddress, usdcAddress);
    }

    /**
     * @notice Update the USDT payment token address.
     * @dev The old address remains marked as managed until its reserves
     *      are zero. Call clearManagedToken() after all pending refunds settle.
     */
    function setPaymentTokenUSDT(address usdtAddress) external onlyOwner {
        if (usdtAddress == address(0)) revert ZeroAddress();
        if (reservedERC20[address(USDT)] != 0) revert ReserveNotZero(); // force clearManagedToken first
        // Mark new addresses as managed
        _isManagedToken[usdtAddress] = true;
        address oldAddress = address(USDT);
        USDT = IERC20(usdtAddress);
        emit PaymentTokenUpdated(oldAddress, usdtAddress);
    }

    /**
     * @notice Remove a retired token address from the managed set.
     * @dev Only callable once reserves for that token are fully settled.
     *      Prevents emergencyWithdrawToken from being unblocked prematurely.
     */
    function clearManagedToken(address token) external onlyOwner {
        if (reservedERC20[token] != 0) revert ReserveNotZero();
        _isManagedToken[token] = false;
        emit ManagedTokenCleared(token);
    }

    /// @notice Withdraw unlocked ETH (total balance minus active reserves)
    function withdrawETH() external onlyOwner nonReentrant {
        uint256 available = address(this).balance - reservedETH;
        require(available > 0, "Nothing to withdraw");
        (bool ok, ) = payable(owner()).call{value: available}("");
        require(ok, "ETH withdrawal failed");
    }

    /**
     * @notice Withdraw unlocked balance of any token (managed or unmanaged).
     * @dev For managed tokens this respects the reserve. For foreign tokens
     *      there is no reserve so the full balance is available. Use
     *      emergencyWithdrawToken for tokens that should never have been sent here.
     */
    function withdrawToken(address token) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        uint256 available = IERC20(token).balanceOf(address(this)) -
            reservedERC20[token];
        require(available > 0, "Nothing to withdraw");
        IERC20(token).safeTransfer(owner(), available);
    }

    function withdrawAll() external onlyOwner nonReentrant {
        uint256 ethAvailable = address(this).balance - reservedETH;
        if (ethAvailable > 0) {
            (bool ok, ) = payable(owner()).call{value: ethAvailable}("");
            require(ok, "ETH withdrawal failed");
        }
        uint256 usdtAvailable = USDT.balanceOf(address(this)) -
            reservedERC20[address(USDT)];
        if (usdtAvailable > 0) USDT.safeTransfer(owner(), usdtAvailable);
        uint256 usdcAvailable = USDC.balanceOf(address(this)) -
            reservedERC20[address(USDC)];
        if (usdcAvailable > 0) USDC.safeTransfer(owner(), usdcAvailable);
    }

    /**
     * @notice Recover foreign ERC-20 tokens accidentally sent to this contract.
     * @dev Blocked for all managed tokens (current and retired with non-zero reserves)
     *      since those have active reserve accounting. Use withdrawToken() for managed tokens.
     */
    function emergencyWithdrawToken(
        address token
    ) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (_isManagedToken[token]) revert CannotWithdrawManagedToken();
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "Nothing to recover");
        IERC20(token).safeTransfer(owner(), balance);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    receive() external payable {}
}
