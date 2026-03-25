// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IMasterKeyVault {
    function collectPayment(
        uint256 tokenId,
        address payer,
        address payToken,
        uint256 amount
    ) external payable;

    function releaseReserveOnClaim(uint256 tokenId, address claimant) external;

    function getUSDT() external view returns (address);

    function getUSDC() external view returns (address);
}

/**
 * @title SoulKey - Per-Game CD-Key NFT Contract
 * @notice Deploy one instance per game. Payments flow directly to MasterKeyVault.
 *         This contract holds no funds. MasterKeyVault is the sole financial authority.
 * @dev tokenURI returns baseURI + tokenId so each encrypted CD-key NFT has
 *      unique metadata served by the backend.
 */
contract SoulKey is ERC721, ERC2981, Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    // ============ State Variables ============

    uint128 public mintPriceETH = 0.01 ether;
    uint128 public mintPriceUSD = 20e6;
    uint64 public maxSupply;
    uint64 private nextTokenId = 1;
    uint64 private _burnedCount;

    string private _baseTokenURI;

    /// @notice Immutable reference to the master vault
    IMasterKeyVault public immutable vault;

    mapping(uint256 => bytes32) private commitmentHash;
    mapping(uint256 => bytes) private encryptedCdKey;
    mapping(uint256 => uint256) private claimTimestamp; // 0 = unclaimed

    // ============ Events ============

    event NFTMinted(
        uint256 indexed tokenId,
        address indexed minter,
        address indexed paymentToken,
        bytes32 commitmentHash
    );
    event CdKeyClaimed(
        uint256 indexed tokenId,
        address indexed owner,
        bytes32 commitmentHash
    );
    event NFTBurned(
        uint256 indexed tokenId,
        address indexed owner,
        bool wasSoulbound
    );
    event MetadataUpdate(uint256 _tokenId);
    event MintPriceUpdated(uint128 ethPrice, uint128 usdPrice);
    event MaxSupplyUpdated(uint64 oldSupply, uint64 newSupply);
    event RoyaltyUpdated(address receiver, uint96 feeNumerator);
    event BaseURIUpdated(string newBaseURI);

    // ============ Errors ============

    error InvalidETHAmount();
    error MaxSupplyReached();
    error NotTokenOwner();
    error NotVault();
    error AlreadyClaimed();
    error NotClaimed();
    error CannotTransferClaimed();
    error ZeroAddress();
    error InvalidCommitmentHash();
    error InvalidSupply();

    // ============ Modifiers ============

    modifier onlyVault() {
        if (msg.sender != address(vault)) revert NotVault();
        _;
    }

    // ============ Constructor ============

    /**
     * @param vaultAddress  Deployed MasterKeyVault address
     * @param baseTokenURI  Base metadata URI — tokenId appended per token
     * @param gameName      ERC721 name (e.g. "Fallout")
     * @param gameSymbol    ERC721 symbol (e.g. "FALL")
     * @param supply        Maximum mintable supply for this game — must be > 0
     */
    constructor(
        address vaultAddress,
        string memory baseTokenURI,
        string memory gameName,
        string memory gameSymbol,
        uint64 supply
    ) ERC721(gameName, gameSymbol) Ownable(msg.sender) {
        if (vaultAddress == address(0)) revert ZeroAddress();
        if (supply == 0) revert InvalidSupply();
        vault = IMasterKeyVault(vaultAddress);
        _baseTokenURI = baseTokenURI;
        maxSupply = supply;
        // Royalties centralised in the vault
        _setDefaultRoyalty(vaultAddress, 500);
    }

    // ============ Metadata ============

    /**
     * @notice Returns a URI unique to each token: baseURI + tokenId.
     * @dev Each token represents a distinct encrypted CD key. The backend
     *      serves per-tokenId JSON at this URI.
     */
    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_baseTokenURI, tokenId.toString());
    }

    function setBaseURI(string memory newBaseURI) external onlyOwner {
        _baseTokenURI = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    /// @notice Returns the base URI used to construct tokenURI.
    function baseURI() public view returns (string memory) {
        return _baseTokenURI;
    }

    // ============ Minting ============

    /**
     * @notice Mint with ETH. Requires msg.value == mintPriceETH exactly.
     * @dev The frontend reads mintPriceETH and constructs the transaction with
     *      the exact value. No excess-refund path exists, eliminating the
     *      smart-contract-receiver griefing vector entirely.
     */
    function mintWithETH(
        bytes32 cdCommitmentHash
    ) external payable whenNotPaused nonReentrant {
        if (msg.value != mintPriceETH) revert InvalidETHAmount();
        _validateCommitment(cdCommitmentHash);
        uint256 tokenId = _mintNFT(msg.sender, cdCommitmentHash);
        vault.collectPayment{value: mintPriceETH}(
            tokenId,
            msg.sender,
            address(0),
            mintPriceETH
        );
        emit NFTMinted(tokenId, msg.sender, address(0), cdCommitmentHash);
    }

    /**
     * @notice Mint with USDT. Tokens pulled directly from user into the vault.
     * @dev Token address is read from vault at call time — stays in sync with
     *      any vault-side update without redeploying SoulKey.
     */
    function mintWithUSDT(
        bytes32 cdCommitmentHash
    ) external whenNotPaused nonReentrant {
        _validateCommitment(cdCommitmentHash);
        IERC20 usdt = IERC20(vault.getUSDT());
        usdt.safeTransferFrom(msg.sender, address(vault), mintPriceUSD);
        uint256 tokenId = _mintNFT(msg.sender, cdCommitmentHash);
        vault.collectPayment(tokenId, msg.sender, address(usdt), mintPriceUSD);
        emit NFTMinted(tokenId, msg.sender, address(usdt), cdCommitmentHash);
    }

    /**
     * @notice Mint with USDC. Tokens pulled directly from user into the vault.
     */
    function mintWithUSDC(
        bytes32 cdCommitmentHash
    ) external whenNotPaused nonReentrant {
        _validateCommitment(cdCommitmentHash);
        IERC20 usdc = IERC20(vault.getUSDC());
        usdc.safeTransferFrom(msg.sender, address(vault), mintPriceUSD);
        uint256 tokenId = _mintNFT(msg.sender, cdCommitmentHash);
        vault.collectPayment(tokenId, msg.sender, address(usdc), mintPriceUSD);
        emit NFTMinted(tokenId, msg.sender, address(usdc), cdCommitmentHash);
    }

    function _validateCommitment(bytes32 cdCommitmentHash) private view {
        // nextTokenId starts at 1 and increments after mint.
        // When nextTokenId == maxSupply the last token is still mintable.
        // When nextTokenId > maxSupply the supply is exhausted.
        if (nextTokenId > maxSupply) revert MaxSupplyReached();
        if (cdCommitmentHash == bytes32(0)) revert InvalidCommitmentHash();
    }

    function _mintNFT(
        address to,
        bytes32 cdCommitmentHash
    ) private returns (uint256) {
        uint256 tokenId = nextTokenId++;
        commitmentHash[tokenId] = cdCommitmentHash;
        _safeMint(to, tokenId);
        return tokenId;
    }

    // ============ CD-Key Claim ============

    /**
     * @notice Claim the CD key, make the NFT soulbound, and release the refund
     *         reserve in the vault atomically. getEncryptedCDKey enforces
     *         ownerOf(tokenId), but the CD key can be directly read from contract
     *         storage eth_getStorageAt. CD key is encrypted with the ownerOf(tokenId)
     *         public address. The function is for better UEx and the CD key is safe.
     * @dev Passes msg.sender to the vault which cross-checks it against ownerOf.
     *      This prevents a buggy game contract from releasing reserves without
     *      a genuine claim having occurred.
     */
    function claimCdKey(
        uint256 tokenId,
        bytes32 cdKeyHash,
        bytes calldata ownerEncryptedKey
    ) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (claimTimestamp[tokenId] != 0) revert AlreadyClaimed();
        if (commitmentHash[tokenId] != cdKeyHash)
            revert InvalidCommitmentHash();

        encryptedCdKey[tokenId] = ownerEncryptedKey;
        claimTimestamp[tokenId] = block.timestamp;

        // Vault verifies claimant == ownerOf(tokenId) before releasing reserve
        vault.releaseReserveOnClaim(tokenId, msg.sender);

        emit CdKeyClaimed(tokenId, msg.sender, cdKeyHash);
        emit MetadataUpdate(tokenId);
    }

    function getEncryptedCDKey(
        uint256 tokenId
    ) external view returns (bytes memory) {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (claimTimestamp[tokenId] == 0) revert NotClaimed();
        return encryptedCdKey[tokenId];
    }

    function getCommitmentHash(
        uint256 tokenId
    ) external view returns (bytes32) {
        return commitmentHash[tokenId];
    }

    function getClaimTimestamp(
        uint256 tokenId
    ) external view returns (uint256) {
        return claimTimestamp[tokenId];
    }

    // ============ Burn ============

    /**
     * @notice Called exclusively by the vault inside processRefund().
     *         Burns the NFT atomically within the same refund transaction.
     * @dev onlyVault ensures this cannot be triggered by anyone other than
     *      the trusted MasterKeyVault. The vault resolves the owner before calling
     *      this, so we record it in the event for the backend.
     */
    function burnByVault(uint256 tokenId) external onlyVault {
        address tokenOwner = ownerOf(tokenId);
        bool wasSoulbound = claimTimestamp[tokenId] != 0;
        _burnedCount++;
        _burn(tokenId);
        delete commitmentHash[tokenId];
        delete encryptedCdKey[tokenId];
        delete claimTimestamp[tokenId];
        emit NFTBurned(tokenId, tokenOwner, wasSoulbound);
    }

    /**
     * @notice User-initiated burn, restricted to claimed (soulbound) tokens.
     * @dev Unclaimed tokens must go through processRefund() to ensure the vault
     *      settles the payment. Burning an unclaimed token directly would leave
     *      funds locked in the vault reserve until releaseReserveOnExpiry.
     */
    function burn(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (claimTimestamp[tokenId] == 0) revert NotClaimed();
        _burnedCount++;
        _burn(tokenId);
        delete commitmentHash[tokenId];
        delete encryptedCdKey[tokenId];
        delete claimTimestamp[tokenId];
        emit NFTBurned(tokenId, msg.sender, true);
    }

    // ============ Transfer Override ============

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            if (claimTimestamp[tokenId] != 0) revert CannotTransferClaimed();
        }
        return super._update(to, tokenId, auth);
    }

    // ============ Emergency ERC-20 Recovery ============

    /**
     * @notice Recover ERC-20 tokens accidentally sent to this contract.
     * @dev This contract intentionally holds no tokens. No reserve check needed
     *      since SoulKey never holds managed tokens — all payments go to the vault.
     */
    function recoverERC20(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        IERC20 t = IERC20(token);
        uint256 balance = t.balanceOf(address(this));
        require(balance > 0, "Nothing to recover");
        t.safeTransfer(owner(), balance);
    }

    // ============ Royalty ============

    function setRoyaltyInfo(
        address receiver,
        uint96 feeNumerator
    ) external onlyOwner {
        if (receiver == address(0)) revert ZeroAddress();
        require(feeNumerator <= 1000, "Royalty too high (max 10%)");
        _setDefaultRoyalty(receiver, feeNumerator);
        emit RoyaltyUpdated(receiver, feeNumerator);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, ERC2981) returns (bool) {
        return
            interfaceId == 0x49064906 || super.supportsInterface(interfaceId);
    }

    // ============ Admin ============

    function setMintPrices(
        uint128 ethPrice,
        uint128 usdPrice
    ) external onlyOwner {
        mintPriceETH = ethPrice;
        mintPriceUSD = usdPrice;
        emit MintPriceUpdated(ethPrice, usdPrice);
    }

    function setMaxSupply(uint64 newMaxSupply) external onlyOwner {
        require(
            newMaxSupply >= nextTokenId - 1,
            "Cannot set below current supply"
        );
        uint64 oldSupply = maxSupply;
        maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(oldSupply, newMaxSupply);
    }

    function totalSupply() external view returns (uint256) {
        return nextTokenId - 1 - _burnedCount;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
