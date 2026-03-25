// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {SoulKey} from "../contracts/SoulKey.sol";
import {MasterKeyVault} from "../contracts/MasterKeyVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract SoulKeyTest is Test {
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
    uint64 constant MAX_SUPPLY = 100;

    bytes32 constant COMMITMENT = keccak256("cdkey-secret-1");

    // ─────────────────────────────── Setup ───────────────────────────────────

    function setUp() public {
        usdt = new MockERC20("Tether", "USDT", 6);
        usdc = new MockERC20("USD Coin", "USDC", 6);

        vm.startPrank(owner);
        vault = new MasterKeyVault(address(usdt), address(usdc));
        soulKey = new SoulKey(
            address(vault),
            "https://api.example.com/metadata/",
            "Fallout",
            "FALL",
            MAX_SUPPLY
        );
        vault.registerGame(address(soulKey));
        vm.stopPrank();

        // Fund user wallets
        vm.deal(user, 10 ether);
        usdt.mint(user, 1000e6);
        usdc.mint(user, 1000e6);

        vm.prank(user);
        usdt.approve(address(soulKey), type(uint256).max);
        vm.prank(user);
        usdc.approve(address(soulKey), type(uint256).max);
    }

    // ─────────────────────────────── Constructor ─────────────────────────────

    function test_Constructor_SetsStateCorrectly() public view {
        assertEq(soulKey.mintPriceETH(), MINT_PRICE_ETH);
        assertEq(soulKey.mintPriceUSD(), MINT_PRICE_USD);
        assertEq(soulKey.maxSupply(), MAX_SUPPLY);
        assertEq(soulKey.totalSupply(), 0);
        assertEq(address(soulKey.vault()), address(vault));
    }

    function test_Constructor_RevertsOnZeroVaultAddress() public {
        vm.expectRevert(SoulKey.ZeroAddress.selector);
        new SoulKey(address(0), "uri", "Game", "GM", 100);
    }

    function test_Constructor_RevertsOnZeroSupply() public {
        vm.expectRevert(SoulKey.InvalidSupply.selector);
        new SoulKey(address(vault), "uri", "Game", "GM", 0);
    }

    // ─────────────────────────────── Mint with ETH ───────────────────────────

    function test_MintWithETH_Success() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        assertEq(soulKey.ownerOf(1), user);
        assertEq(soulKey.totalSupply(), 1);
        assertEq(soulKey.getCommitmentHash(1), COMMITMENT);
    }

    function test_MintWithETH_EmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit SoulKey.NFTMinted(1, user, address(0), COMMITMENT);

        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);
    }

    function test_MintWithETH_RevertsOnWrongValue() public {
        vm.expectRevert(SoulKey.InvalidETHAmount.selector);
        vm.prank(user);
        soulKey.mintWithETH{value: 0.005 ether}(COMMITMENT);
    }

    function test_MintWithETH_RevertsOnExcessValue() public {
        vm.expectRevert(SoulKey.InvalidETHAmount.selector);
        vm.prank(user);
        soulKey.mintWithETH{value: 0.02 ether}(COMMITMENT);
    }

    function test_MintWithETH_RevertsOnZeroCommitment() public {
        vm.expectRevert(SoulKey.InvalidCommitmentHash.selector);
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(bytes32(0));
    }

    function test_MintWithETH_RevertsWhenPaused() public {
        vm.prank(owner);
        soulKey.pause();

        vm.expectRevert();
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);
    }

    function test_MintWithETH_RevertsAtMaxSupply() public {
        SoulKey smallKey;
        vm.prank(owner);
        smallKey = new SoulKey(address(vault), "uri/", "Tiny", "TNY", 1);
        vm.prank(owner);
        vault.registerGame(address(smallKey));

        vm.prank(user);
        smallKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.expectRevert(SoulKey.MaxSupplyReached.selector);
        vm.prank(user);
        smallKey.mintWithETH{value: MINT_PRICE_ETH}(keccak256("second"));
    }

    // ─────────────────────────────── Mint with USDT ──────────────────────────

    function test_MintWithUSDT_Success() public {
        vm.prank(user);
        soulKey.mintWithUSDT(COMMITMENT);

        assertEq(soulKey.ownerOf(1), user);
        assertEq(usdt.balanceOf(address(vault)), MINT_PRICE_USD);
    }

    function test_MintWithUSDT_RevertsWithoutApproval() public {
        address noApproval = makeAddr("noApproval");
        usdt.mint(noApproval, 1000e6);

        vm.expectRevert();
        vm.prank(noApproval);
        soulKey.mintWithUSDT(COMMITMENT);
    }

    // ─────────────────────────────── Mint with USDC ──────────────────────────

    function test_MintWithUSDC_Success() public {
        vm.prank(user);
        soulKey.mintWithUSDC(COMMITMENT);

        assertEq(soulKey.ownerOf(1), user);
        assertEq(usdc.balanceOf(address(vault)), MINT_PRICE_USD);
    }

    // ─────────────────────────────── TokenURI ────────────────────────────────

    function test_TokenURI_AppendsTokenId() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        assertEq(soulKey.tokenURI(1), "https://api.example.com/metadata/1");
    }

    function test_TokenURI_RevertsForNonExistentToken() public {
        vm.expectRevert();
        soulKey.tokenURI(999);
    }

    // ─────────────────────────────── CD-Key Claim ────────────────────────────

    function _mintAndClaim(address _user) internal returns (uint256 tokenId) {
        vm.prank(_user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);
        tokenId = 1;

        bytes memory encKey = abi.encodePacked("encrypted-key-data");
        vm.prank(_user);
        soulKey.claimCdKey(tokenId, COMMITMENT, encKey);
    }

    function test_ClaimCdKey_Success() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        bytes memory encKey = abi.encodePacked("encrypted-key-data");
        vm.prank(user);
        soulKey.claimCdKey(1, COMMITMENT, encKey);

        assertGt(soulKey.getClaimTimestamp(1), 0);
    }

    function test_ClaimCdKey_EmitsEvent() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.expectEmit(true, true, false, true);
        emit SoulKey.CdKeyClaimed(1, user, COMMITMENT);

        vm.prank(user);
        soulKey.claimCdKey(1, COMMITMENT, abi.encodePacked("key"));
    }

    function test_ClaimCdKey_RevertsIfNotOwner() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.expectRevert(SoulKey.NotTokenOwner.selector);
        vm.prank(attacker);
        soulKey.claimCdKey(1, COMMITMENT, abi.encodePacked("key"));
    }

    function test_ClaimCdKey_RevertsIfAlreadyClaimed() public {
        _mintAndClaim(user);

        vm.expectRevert(SoulKey.AlreadyClaimed.selector);
        vm.prank(user);
        soulKey.claimCdKey(1, COMMITMENT, abi.encodePacked("key2"));
    }

    function test_ClaimCdKey_RevertsOnWrongCommitmentHash() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.expectRevert(SoulKey.InvalidCommitmentHash.selector);
        vm.prank(user);
        soulKey.claimCdKey(1, keccak256("wrong-hash"), abi.encodePacked("key"));
    }

    function test_GetEncryptedCDKey_Success() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        bytes memory encKey = abi.encodePacked("encrypted-key-data");
        vm.prank(user);
        soulKey.claimCdKey(1, COMMITMENT, encKey);

        vm.prank(user);
        bytes memory retrieved = soulKey.getEncryptedCDKey(1);
        assertEq(retrieved, encKey);
    }

    function test_GetEncryptedCDKey_RevertsIfNotOwner() public {
        _mintAndClaim(user);

        vm.expectRevert(SoulKey.NotTokenOwner.selector);
        vm.prank(attacker);
        soulKey.getEncryptedCDKey(1);
    }

    function test_GetEncryptedCDKey_RevertsIfNotClaimed() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.expectRevert(SoulKey.NotClaimed.selector);
        vm.prank(user);
        soulKey.getEncryptedCDKey(1);
    }

    // ─────────────────────────────── Transfer ────────────────────────────────

    function test_Transfer_SucceedsBeforeClaim() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.prank(user);
        soulKey.transferFrom(user, user2, 1);

        assertEq(soulKey.ownerOf(1), user2);
    }

    function test_Transfer_RevertsAfterClaim() public {
        _mintAndClaim(user);

        vm.expectRevert(SoulKey.CannotTransferClaimed.selector);
        vm.prank(user);
        soulKey.transferFrom(user, user2, 1);
    }

    // ─────────────────────────────── Burn ────────────────────────────────────

    function test_Burn_SucceedsForClaimedToken() public {
        _mintAndClaim(user);

        vm.prank(user);
        soulKey.burn(1);

        assertEq(soulKey.totalSupply(), 0);
    }

    function test_Burn_RevertsForUnclaimedToken() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.expectRevert(SoulKey.NotClaimed.selector);
        vm.prank(user);
        soulKey.burn(1);
    }

    function test_Burn_RevertsIfNotOwner() public {
        _mintAndClaim(user);

        vm.expectRevert(SoulKey.NotTokenOwner.selector);
        vm.prank(attacker);
        soulKey.burn(1);
    }

    function test_BurnByVault_RevertsIfNotVault() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.expectRevert(SoulKey.NotVault.selector);
        vm.prank(attacker);
        soulKey.burnByVault(1);
    }

    // ─────────────────────────────── Admin ───────────────────────────────────

    function test_SetMaxSupply_Success() public {
        vm.prank(owner);
        soulKey.setMaxSupply(200);
        assertEq(soulKey.maxSupply(), 200);
    }

    function test_SetMaxSupply_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit SoulKey.MaxSupplyUpdated(MAX_SUPPLY, 200);

        vm.prank(owner);
        soulKey.setMaxSupply(200);
    }

    function test_SetMaxSupply_RevertsIfBelowMintedCount() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        vm.expectRevert("Cannot set below current supply");
        vm.prank(owner);
        soulKey.setMaxSupply(0);
    }

    function test_SetMintPrices_Success() public {
        vm.prank(owner);
        soulKey.setMintPrices(0.02 ether, 40e6);

        assertEq(soulKey.mintPriceETH(), 0.02 ether);
        assertEq(soulKey.mintPriceUSD(), 40e6);
    }

    function test_SetBaseURI_Success() public {
        vm.prank(owner);
        soulKey.setBaseURI("https://new.example.com/");

        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        assertEq(soulKey.tokenURI(1), "https://new.example.com/1");
    }

    function test_SetRoyaltyInfo_RevertsAboveCap() public {
        vm.expectRevert("Royalty too high (max 10%)");
        vm.prank(owner);
        soulKey.setRoyaltyInfo(owner, 1001);
    }

    function test_RecoverERC20_Success() public {
        MockERC20 lost = new MockERC20("Lost", "LST", 18);
        lost.mint(address(soulKey), 100e18);

        uint256 ownerBefore = lost.balanceOf(owner);
        vm.prank(owner);
        soulKey.recoverERC20(address(lost));

        assertEq(lost.balanceOf(owner), ownerBefore + 100e18);
        assertEq(lost.balanceOf(address(soulKey)), 0);
    }

    function test_RecoverERC20_RevertsOnZeroBalance() public {
        MockERC20 empty = new MockERC20("Empty", "EMPT", 18);

        vm.expectRevert("Nothing to recover");
        vm.prank(owner);
        soulKey.recoverERC20(address(empty));
    }

    function test_PauseUnpause_OnlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        soulKey.pause();

        vm.prank(owner);
        soulKey.pause();
        assertTrue(soulKey.paused());

        vm.prank(owner);
        soulKey.unpause();
        assertFalse(soulKey.paused());
    }

    function test_TotalSupply_TracksCorrectly() public {
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(COMMITMENT);

        bytes32 c2 = keccak256("key2");
        vm.prank(user);
        soulKey.mintWithETH{value: MINT_PRICE_ETH}(c2);

        assertEq(soulKey.totalSupply(), 2);

        // Claim and burn token 1
        vm.prank(user);
        soulKey.claimCdKey(1, COMMITMENT, abi.encodePacked("k"));
        vm.prank(user);
        soulKey.burn(1);

        assertEq(soulKey.totalSupply(), 1);
    }

    // ─────────────────────────────── Fuzz ────────────────────────────────────

    function testFuzz_MintWithETH_RevertsOnWrongValue(
        uint128 wrongValue
    ) public {
        vm.assume(wrongValue != MINT_PRICE_ETH);
        vm.assume(wrongValue <= 100 ether);
        vm.deal(user, wrongValue);

        vm.expectRevert(SoulKey.InvalidETHAmount.selector);
        vm.prank(user);
        soulKey.mintWithETH{value: wrongValue}(COMMITMENT);
    }

    function testFuzz_SetMaxSupply_RevertsIfBelowMinted(
        uint64 mintCount
    ) public {
        vm.assume(mintCount > 0 && mintCount <= 10);

        for (uint64 i = 0; i < mintCount; i++) {
            bytes32 c = keccak256(abi.encode(i));
            vm.prank(user);
            soulKey.mintWithETH{value: MINT_PRICE_ETH}(c);
        }

        vm.expectRevert("Cannot set below current supply");
        vm.prank(owner);
        soulKey.setMaxSupply(mintCount - 1);
    }
}
