// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {SoulKey} from "../contracts/SoulKey.sol";
import {MasterKeyVault} from "../contracts/MasterKeyVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * @title Integration tests — full reserve lifecycle flows
 * @dev Each test walks a complete path through both contracts.
 */
contract SoulKeyVaultIntegrationTest is Test {
    SoulKey public soulKey;
    MasterKeyVault public vault;
    MockERC20 public usdt;
    MockERC20 public usdc;

    address public owner = makeAddr("owner");
    address public user = makeAddr("user");
    address public user2 = makeAddr("user2");

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
        vm.deal(user2, 10 ether);
        usdt.mint(user, 10000e6);
        usdc.mint(user, 10000e6);
        vm.prank(user);
        usdt.approve(address(soulKey), type(uint256).max);
        vm.prank(user);
        usdc.approve(address(soulKey), type(uint256).max);
    }

    // ── Path 1: Locked → ReleasedByClaim ─────────────────────────────────────

    function test_Lifecycle_MintClaimReserveReleased() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        assertEq(vault.reservedETH(), MINT_PRICE_ETH);
        assertTrue(vault.isRefundable(address(soulKey), 1));

        vm.prank(user);
        soulKey.claimCdKey(1, COMMITMENT, abi.encodePacked("encrypted-key"));

        assertEq(vault.reservedETH(), 0);
        assertFalse(vault.isRefundable(address(soulKey), 1));

        MasterKeyVault.PaymentRecord memory r = vault.getPaymentRecord(
            address(soulKey),
            1
        );
        assertEq(
            uint8(r.status),
            uint8(MasterKeyVault.ReserveStatus.ReleasedByClaim)
        );

        // Token is soulbound — cannot transfer
        vm.expectRevert(SoulKey.CannotTransferClaimed.selector);
        vm.prank(user);
        soulKey.transferFrom(user, user2, 1);
    }

    // ── Path 2: Locked → Refunded ─────────────────────────────────────────────

    function test_Lifecycle_MintRefund_ETH() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        uint256 userBefore = user.balance;
        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "not happy");

        uint256 fee = (MINT_PRICE_ETH * 500) / 10_000;
        uint256 expectedRefund = MINT_PRICE_ETH - fee;

        assertEq(user.balance, userBefore + expectedRefund);
        assertEq(vault.reservedETH(), 0);
        // Fee stays in vault as revenue
        assertEq(vault.withdrawableETH(), fee);
        // NFT burned
        vm.expectRevert();
        soulKey.ownerOf(1);
    }

    function test_Lifecycle_MintRefund_USDT() public {
        vm.prank(user);
        soulKey.mintWithUSDT(COMMITMENT);

        uint256 userBefore = usdt.balanceOf(user);
        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "not happy");

        uint256 fee = (MINT_PRICE_USD * 500) / 10_000;
        uint256 expectedRefund = MINT_PRICE_USD - fee;

        assertEq(usdt.balanceOf(user), userBefore + expectedRefund);
        assertEq(vault.reservedERC20(address(usdt)), 0);
    }

    // ── Path 3: Locked → ReleasedByExpiry ────────────────────────────────────

    function test_Lifecycle_MintExpiry() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.warp(block.timestamp + 14 days + 1);
        vault.releaseReserveOnExpiry(address(soulKey), 1);

        assertEq(vault.reservedETH(), 0);
        assertFalse(vault.isRefundable(address(soulKey), 1));

        // Refund should now be blocked
        vm.expectRevert(MasterKeyVault.ReserveNotLocked.selector);
        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "too late");

        // Token still exists — user still holds it
        assertEq(soulKey.ownerOf(1), user);
    }

    // ── Path 4: Mint → Transfer → Refund by new holder ───────────────────────

    function test_Lifecycle_TransferThenRefund() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.prank(user);
        soulKey.transferFrom(user, user2, 1);
        assertEq(soulKey.ownerOf(1), user2);

        uint256 user2Before = user2.balance;
        vm.prank(user2);
        vault.processRefund(address(soulKey), 1, "new owner refunds");

        uint256 fee = (MINT_PRICE_ETH * 500) / 10_000;
        uint256 expectedRefund = MINT_PRICE_ETH - fee;
        assertEq(user2.balance, user2Before + expectedRefund);
    }

    // ── Path 5: Multi-game, isolated reserves ────────────────────────────────

    function test_Lifecycle_MultipleGames_IsolatedReserves() public {
        SoulKey soulKey2;
        vm.prank(owner);
        soulKey2 = new SoulKey(address(vault), "uri2/", "Doom", "DOOM", 1000);
        vm.prank(owner);
        vault.registerGame(address(soulKey2));

        usdt.mint(user, 10000e6);

        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        bytes32 c2 = keccak256("doom-key");
        vm.prank(user);
        soulKey2.mintWithETH{value: MINT_PRICE_ETH}(c2);

        assertEq(vault.reservedETH(), MINT_PRICE_ETH * 2);

        // Refund soulKey token only
        vm.prank(user);
        vault.processRefund(address(soulKey), 1, "refund game1");

        // soulKey2 reserve still intact
        assertEq(vault.reservedETH(), MINT_PRICE_ETH);

        MasterKeyVault.PaymentRecord memory r2 = vault.getPaymentRecord(
            address(soulKey2),
            1
        );
        assertEq(uint8(r2.status), uint8(MasterKeyVault.ReserveStatus.Locked));
    }

    // ── Path 6: Claim blocks refund, then burn soulbound token ───────────────

    function test_Lifecycle_ClaimThenBurn() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);
        vm.prank(user);
        soulKey.claimCdKey(1, COMMITMENT, abi.encodePacked("key"));

        assertEq(soulKey.totalSupply(), 1);

        vm.prank(user);
        soulKey.burn(1);

        assertEq(soulKey.totalSupply(), 0);
    }

    // ── Path 7: Payment token replacement mid-operation ───────────────────────

    function test_Lifecycle_PaymentTokenReplacement() public {
        // Mint with original USDT
        vm.prank(user);
        soulKey.mintWithUSDT(COMMITMENT);

        // Claim to clear reserve
        vm.prank(user);
        soulKey.claimCdKey(1, COMMITMENT, abi.encodePacked("key"));
        assertEq(vault.reservedERC20(address(usdt)), 0);

        // Now replace USDT
        MockERC20 newUsdt = new MockERC20("New USDT", "NUSDT", 6);
        vm.prank(owner);
        vault.setPaymentTokenUSDT(address(newUsdt));

        // Mint with new USDT
        newUsdt.mint(user, 1000e6);
        vm.prank(user);
        newUsdt.approve(address(soulKey), type(uint256).max);

        bytes32 c2 = keccak256("key2");
        vm.prank(user);
        soulKey.mintWithUSDT(c2);

        assertEq(vault.reservedERC20(address(newUsdt)), MINT_PRICE_USD);
    }
}
