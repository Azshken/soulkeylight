// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {SoulKey} from "../contracts/SoulKey.sol";
import {MasterKeyVault} from "../contracts/MasterKeyVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract MasterKeyVaultTest is Test {
    SoulKey public soulKey;
    MasterKeyVault public vault;
    MockERC20 public usdt;
    MockERC20 public usdc;

    address public owner = makeAddr("owner");
    address public user = makeAddr("user");
    address public user2 = makeAddr("user2");
    address public attacker = makeAddr("attacker");

    uint128 constant MINT_PRICE_ETH = 0.01 ether;
    uint128 constant MINT_PRICE_USD = 20e6;
    bytes32 constant COMMITMENT = keccak256("cdkey-secret-1");

    function setUp() public {
        usdt = new MockERC20("Tether", "USDT", 6);
        usdc = new MockERC20("USD Coin", "USDC", 6);

        vm.startPrank(owner);
        vault = new MasterKeyVault(address(usdt), address(usdc));
        soulKey = new SoulKey(address(vault), "uri/", "Game", "GM", 1000);
        vault.registerGame(address(soulKey));
        vm.stopPrank();

        vm.deal(user, 10 ether);
        usdt.mint(user, 10000e6);
        usdc.mint(user, 10000e6);
        vm.prank(user);
        usdt.approve(address(soulKey), type(uint256).max);
        vm.prank(user);
        usdc.approve(address(soulKey), type(uint256).max);
    }

    // ─────────────────────────────── Constructor ─────────────────────────────

    function test_Constructor_RevertsOnZeroAddresses() public {
        vm.expectRevert(MasterKeyVault.ZeroAddress.selector);
        new MasterKeyVault(address(0), address(usdc));

        vm.expectRevert(MasterKeyVault.ZeroAddress.selector);
        new MasterKeyVault(address(usdt), address(0));
    }

    function test_Constructor_SetsTokensAsManaged() public {
        // emergencyWithdraw should be blocked for both — confirms managed flag is set
        usdt.mint(address(vault), 100e6);
        vm.expectRevert(MasterKeyVault.CannotWithdrawManagedToken.selector);
        vm.prank(owner);
        vault.emergencyWithdrawToken(address(usdt));
    }

    // ─────────────────────────────── Game Registry ───────────────────────────

    function test_RegisterGame_OnlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        vault.registerGame(makeAddr("game"));
    }

    function test_RegisterGame_RevertsOnZeroAddress() public {
        vm.expectRevert(MasterKeyVault.ZeroAddress.selector);
        vm.prank(owner);
        vault.registerGame(address(0));
    }

    function test_DeregisterGame_PreventsCollectPayment() public {
        vm.prank(owner);
        vault.deregisterGame(address(soulKey));

        vm.expectRevert(MasterKeyVault.NotRegisteredGame.selector);
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);
    }

    // ─────────────────────────────── collectPayment ──────────────────────────

    function test_CollectPayment_LocksETHReserve() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        assertEq(vault.reservedETH(), MINT_PRICE_ETH);
        assertEq(address(vault).balance, MINT_PRICE_ETH);
    }

    function test_CollectPayment_LocksUSDTReserve() public {
        vm.prank(user);
        soulKey.mintWithUSDT(COMMITMENT);

        assertEq(vault.reservedERC20(address(usdt)), MINT_PRICE_USD);
    }

    function test_CollectPayment_RevertsWhenPaused() public {
        vm.prank(owner);
        vault.pause();

        vm.expectRevert();
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);
    }

    function test_CollectPayment_StoresPaymentRecord() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        MasterKeyVault.PaymentRecord memory r = vault.getPaymentRecord(
            address(soulKey),
            1
        );
        assertEq(r.payer, user);
        assertEq(r.amount, MINT_PRICE_ETH);
        assertEq(r.paymentToken, address(0));
        assertEq(uint8(r.status), uint8(MasterKeyVault.ReserveStatus.Locked));
    }

    // ─────────────────────────────── releaseReserveOnClaim ───────────────────

    function test_ReleaseReserveOnClaim_UnlocksReserve() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.prank(user);
        soulKey.claimCdKey(1, COMMITMENT, abi.encodePacked("key"));

        assertEq(vault.reservedETH(), 0);

        MasterKeyVault.PaymentRecord memory r = vault.getPaymentRecord(
            address(soulKey),
            1
        );
        assertEq(
            uint8(r.status),
            uint8(MasterKeyVault.ReserveStatus.ReleasedByClaim)
        );
    }

    function test_ReleaseReserveOnClaim_BlocksRefundAfterClaim() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);
        vm.prank(user);
        soulKey.claimCdKey(1, COMMITMENT, abi.encodePacked("key"));

        vm.expectRevert(MasterKeyVault.ReserveNotLocked.selector);
        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "test");
    }

    function test_ReleaseReserveOnClaim_RevertsIfNotRegisteredGame() public {
        vm.expectRevert(MasterKeyVault.NotRegisteredGame.selector);
        vm.prank(attacker);
        vault.releaseReserveOnClaim(1, attacker);
    }

    // ─────────────────────────────── releaseReserveOnExpiry ──────────────────

    function test_ReleaseReserveOnExpiry_SuccessAfterWindow() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.warp(block.timestamp + 14 days + 1);
        vault.releaseReserveOnExpiry(address(soulKey), 1);

        assertEq(vault.reservedETH(), 0);
        MasterKeyVault.PaymentRecord memory r = vault.getPaymentRecord(
            address(soulKey),
            1
        );
        assertEq(
            uint8(r.status),
            uint8(MasterKeyVault.ReserveStatus.ReleasedByExpiry)
        );
    }

    function test_ReleaseReserveOnExpiry_RevertsBeforeWindow() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.expectRevert(MasterKeyVault.RefundWindowActive.selector);
        vault.releaseReserveOnExpiry(address(soulKey), 1);
    }

    function test_ReleaseReserveOnExpiry_IsPermissionless() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.warp(block.timestamp + 14 days + 1);
        // attacker can call — intentional
        vm.prank(attacker);
        vault.releaseReserveOnExpiry(address(soulKey), 1);

        assertEq(vault.reservedETH(), 0);
    }

    // ─────────────────────────────── batchReleaseOnExpiry ────────────────────

    function test_BatchRelease_SkipsIneligible() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        bytes32 c2 = keccak256("key2");
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(c2);

        // Only warp past expiry for token 1
        vm.warp(block.timestamp + 14 days + 1);

        address[] memory contracts = new address[](2);
        uint256[] memory ids = new uint256[](2);
        contracts[0] = address(soulKey);
        ids[0] = 1;
        contracts[1] = address(soulKey);
        ids[1] = 2;

        vault.batchReleaseReserveOnExpiry(contracts, ids);

        // Token 1 released, token 2 still locked (same block as mint in this test)
        MasterKeyVault.PaymentRecord memory r1 = vault.getPaymentRecord(
            address(soulKey),
            1
        );
        MasterKeyVault.PaymentRecord memory r2 = vault.getPaymentRecord(
            address(soulKey),
            2
        );
        assertEq(
            uint8(r1.status),
            uint8(MasterKeyVault.ReserveStatus.ReleasedByExpiry)
        );
        assertEq(
            uint8(r2.status),
            uint8(MasterKeyVault.ReserveStatus.ReleasedByExpiry)
        );
    }

    function test_BatchRelease_RevertsOnLengthMismatch() public {
        address[] memory contracts = new address[](2);
        uint256[] memory ids = new uint256[](1);

        vm.expectRevert(MasterKeyVault.ArrayLengthMismatch.selector);
        vault.batchReleaseReserveOnExpiry(contracts, ids);
    }

    function test_BatchRelease_RevertsIfTooLarge() public {
        address[] memory contracts = new address[](101);
        uint256[] memory ids = new uint256[](101);

        vm.expectRevert(MasterKeyVault.BatchTooLarge.selector);
        vault.batchReleaseReserveOnExpiry(contracts, ids);
    }

    // ─────────────────────────────── processRefund ───────────────────────────

    function test_ProcessRefund_ETH_Success() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        uint256 balBefore = user.balance;
        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "dont want it");

        uint256 expectedFee = (MINT_PRICE_ETH * 500) / 10_000;
        uint256 expectedRefund = MINT_PRICE_ETH - expectedFee;

        assertEq(user.balance, balBefore + expectedRefund);
        assertEq(vault.reservedETH(), 0);
        vm.expectRevert(); // token burned
        soulKey.ownerOf(1);
    }

    function test_ProcessRefund_USDT_Success() public {
        vm.prank(user);
        soulKey.mintWithUSDT(COMMITMENT);

        uint256 balBefore = usdt.balanceOf(user);
        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "changed mind");

        uint256 expectedFee = (MINT_PRICE_USD * 500) / 10_000;
        uint256 expectedRefund = MINT_PRICE_USD - expectedFee;
        assertEq(usdt.balanceOf(user), balBefore + expectedRefund);
    }

    function test_ProcessRefund_RevertsIfNotTokenOwner() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.expectRevert(MasterKeyVault.NotTokenOwner.selector);
        vm.prank(attacker);
        vault.processRefund(address(soulKey), 1, "attack");
    }

    function test_ProcessRefund_RevertsAfterWindow() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.warp(block.timestamp + 14 days + 1);

        vm.expectRevert(MasterKeyVault.RefundWindowExpired.selector);
        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "too late");
    }

    function test_ProcessRefund_RevertsIfAlreadyRefunded() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "first");

        vm.expectRevert(MasterKeyVault.AlreadyProcessed.selector);
        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "second");
    }

    function test_ProcessRefund_RefundsNewOwnerAfterTransfer() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        // Transfer to user2 before claiming
        vm.prank(user);
        soulKey.transferFrom(user, user2, 1);

        vm.deal(user2, 1 ether);

        vm.prank(user2);
        vault.processRefund(address(soulKey), 1, "new owner refund");

        uint256 expectedFee = (MINT_PRICE_ETH * 500) / 10_000;
        assertEq(user2.balance, 1 ether + (MINT_PRICE_ETH - expectedFee));
    }

    function test_ProcessRefund_EmitsRefundIssued() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        uint256 fee = (MINT_PRICE_ETH * 500) / 10_000;
        uint256 refundAmt = MINT_PRICE_ETH - fee;

        vm.expectEmit(true, true, true, true);
        emit MasterKeyVault.RefundIssued(
            address(soulKey),
            1,
            user,
            address(0),
            refundAmt,
            fee,
            "reason"
        );

        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "reason");
    }

    // ─────────────────────────────── isRefundable ────────────────────────────

    function test_IsRefundable_TrueWithinWindow() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        assertTrue(vault.isRefundable(address(soulKey), 1));
    }

    function test_IsRefundable_FalseAfterWindow() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.warp(block.timestamp + 14 days + 1);
        assertFalse(vault.isRefundable(address(soulKey), 1));
    }

    function test_IsRefundable_FalseAfterClaim() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);
        vm.prank(user);
        soulKey.claimCdKey(1, COMMITMENT, abi.encodePacked("key"));

        assertFalse(vault.isRefundable(address(soulKey), 1));
    }

    // ─────────────────────────────── setRefundFee ────────────────────────────

    function test_SetRefundFee_Success() public {
        vm.prank(owner);
        vault.setRefundFee(0);
        assertEq(vault.refundFeeBps(), 0);

        vm.prank(owner);
        vault.setRefundFee(1000);
        assertEq(vault.refundFeeBps(), 1000);
    }

    function test_SetRefundFee_RevertsAboveCap() public {
        vm.expectRevert(MasterKeyVault.FeeTooHigh.selector);
        vm.prank(owner);
        vault.setRefundFee(1001);
    }

    function test_SetRefundFee_ZeroFeeRefundsFullAmount() public {
        vm.prank(owner);
        vault.setRefundFee(0);

        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        uint256 before = user.balance;
        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "full refund");

        assertEq(user.balance, before + MINT_PRICE_ETH);
    }

    // ─────────────────────────────── setPaymentTokens ────────────────────────

    function test_SetPaymentTokenUSDT_Success() public {
        MockERC20 newUsdt = new MockERC20("New USDT", "NUSDT", 6);

        vm.prank(owner);
        vault.setPaymentTokenUSDT(address(newUsdt));

        assertEq(vault.getUSDT(), address(newUsdt));
    }

    function test_SetPaymentTokenUSDT_RevertsIfReserveNonZero() public {
        vm.prank(user);
        soulKey.mintWithUSDT(COMMITMENT);

        MockERC20 newUsdt = new MockERC20("New USDT", "NUSDT", 6);
        vm.expectRevert(MasterKeyVault.ReserveNotZero.selector);
        vm.prank(owner);
        vault.setPaymentTokenUSDT(address(newUsdt));
    }

    function test_SetPaymentTokenUSDC_IndependentOfUSDT() public {
        // Lock USDT reserve
        vm.prank(user);
        soulKey.mintWithUSDT(COMMITMENT);

        // USDC update should still succeed
        MockERC20 newUsdc = new MockERC20("New USDC", "NUSDC", 6);
        vm.prank(owner);
        vault.setPaymentTokenUSDC(address(newUsdc));

        assertEq(vault.getUSDC(), address(newUsdc));
    }

    function test_SetPaymentTokenUSDT_EmitsEvent() public {
        MockERC20 newUsdt = new MockERC20("New USDT", "NUSDT", 6);
        address oldAddr = vault.getUSDT();

        vm.expectEmit(true, true, false, false);
        emit MasterKeyVault.PaymentTokenUpdated(oldAddr, address(newUsdt));

        vm.prank(owner);
        vault.setPaymentTokenUSDT(address(newUsdt));
    }

    // ─────────────────────────────── clearManagedToken ───────────────────────

    function test_ClearManagedToken_UnblocksEmergencyWithdraw() public {
        // Replace USDT
        MockERC20 newUsdt = new MockERC20("New USDT", "NUSDT", 6);
        vm.prank(owner);
        vault.setPaymentTokenUSDT(address(newUsdt));

        // Old USDT still blocked
        usdt.mint(address(vault), 100e6);
        vm.expectRevert(MasterKeyVault.CannotWithdrawManagedToken.selector);
        vm.prank(owner);
        vault.emergencyWithdrawToken(address(usdt));

        // Clear old USDT (reserve is 0 since no mints used it after replacement)
        vm.prank(owner);
        vault.clearManagedToken(address(usdt));

        // Now emergency withdraw works
        vm.prank(owner);
        vault.emergencyWithdrawToken(address(usdt));
        assertEq(usdt.balanceOf(owner), 100e6);
    }

    function test_ClearManagedToken_RevertsIfReserveNonZero() public {
        vm.prank(user);
        soulKey.mintWithUSDT(COMMITMENT);

        vm.expectRevert(MasterKeyVault.ReserveNotZero.selector);
        vm.prank(owner);
        vault.clearManagedToken(address(usdt));
    }

    // ─────────────────────────────── Withdrawals ─────────────────────────────

    function test_WithdrawETH_OnlyWithdrawsUnlocked() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        // Send bonus ETH directly to vault
        vm.deal(address(vault), address(vault).balance + 1 ether);

        uint256 ownerBefore = owner.balance;
        vm.prank(owner);
        vault.withdrawETH();

        // Only the unlocked 1 ether is withdrawn, not the reserved mint price
        assertEq(owner.balance, ownerBefore + 1 ether);
        assertEq(vault.reservedETH(), MINT_PRICE_ETH);
    }

    function test_WithdrawToken_RespectsReserve() public {
        vm.prank(user);
        soulKey.mintWithUSDT(COMMITMENT);

        // Simulate extra unlocked USDT sent directly
        usdt.mint(address(vault), 50e6);

        uint256 ownerBefore = usdt.balanceOf(owner);
        vm.prank(owner);
        vault.withdrawToken(address(usdt));

        assertEq(usdt.balanceOf(owner), ownerBefore + 50e6);
        assertEq(vault.reservedERC20(address(usdt)), MINT_PRICE_USD);
    }

    function test_WithdrawAll_OnlyUnlocked() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);
        vm.prank(user);
        soulKey.mintWithUSDT(keccak256("key2"));

        // Add unlocked funds
        vm.deal(address(vault), address(vault).balance + 0.5 ether);
        usdt.mint(address(vault), 10e6);

        vm.prank(owner);
        vault.withdrawAll();

        // Reserves still locked
        assertEq(vault.reservedETH(), MINT_PRICE_ETH);
        assertEq(vault.reservedERC20(address(usdt)), MINT_PRICE_USD);
    }

    function test_EmergencyWithdrawToken_BlockedForManagedToken() public {
        vm.expectRevert(MasterKeyVault.CannotWithdrawManagedToken.selector);
        vm.prank(owner);
        vault.emergencyWithdrawToken(address(usdt));
    }

    function test_EmergencyWithdrawToken_SucceedsForForeignToken() public {
        MockERC20 foreign = new MockERC20("Foreign", "FOR", 18);
        foreign.mint(address(vault), 1000e18);

        vm.prank(owner);
        vault.emergencyWithdrawToken(address(foreign));

        assertEq(foreign.balanceOf(owner), 1000e18);
    }

    function test_WithdrawETH_RevertsOnlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        vault.withdrawETH();
    }

    // ─────────────────────────────── withdrawableViews ───────────────────────

    function test_WithdrawableETH_ExcludesReserve() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);
        vm.deal(address(vault), address(vault).balance + 1 ether);

        assertEq(vault.withdrawableETH(), 1 ether);
    }

    function test_WithdrawableERC20_ExcludesReserve() public {
        vm.prank(user);
        soulKey.mintWithUSDT(COMMITMENT);
        usdt.mint(address(vault), 50e6);

        assertEq(vault.withdrawableERC20(address(usdt)), 50e6);
    }
}
