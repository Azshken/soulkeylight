// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/utils/abis.ts
//
// Single source of truth for all contract ABIs.
// Types are cross-referenced against SoulKey.sol and MasterKeyVault.sol directly.
// Update here when Solidity changes — never write inline parseAbi calls in components.
// Events are included so decodeEventLog can use these ABIs everywhere.
import { parseAbi } from "viem";

export const SOULKEY_ABI = parseAbi([
  // reads — return types match the Solidity state variable declarations exactly:
  // uint128 public mintPriceETH, uint128 public mintPriceUSD, uint64 public maxSupply
  // viem decodes uint types wider than 32 bits as bigint, which covers all return
  // types declared in this file. Smaller types (uint8–uint32) decode as number —
  // none appear here, but keep this distinction in mind when adding new entries.
  "function mintPriceETH() view returns (uint128)",
  "function mintPriceUSD() view returns (uint128)",
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint64)",
  "function vault() view returns (address)",
  "function getClaimTimestamp(uint256 tokenId) view returns (uint256)",
  "function getEncryptedCDKey(uint256 tokenId) view returns (bytes)",
  "function baseURI() view returns (string)",
  // writes
  "function mintWithETH(bytes32 commitmentHash) payable",
  "function mintWithUSDT(bytes32 commitmentHash) nonpayable",
  "function mintWithUSDC(bytes32 commitmentHash) nonpayable",
  "function claimCdKey(uint256 tokenId, bytes32 commitmentHash, bytes calldata encryptedKey) nonpayable",
  // events — included here so decodeEventLog uses SOULKEY_ABI directly, no inline parseAbi
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event NFTMinted(uint256 indexed tokenId, address indexed minter, address indexed paymentToken, bytes32 commitmentHash)",
  "function setBaseURI(string memory newBaseURI) external",
  // custom errors
  "error InvalidETHAmount()",
  "error MaxSupplyReached()",
  "error NotTokenOwner()",
  "error NotVault()",
  "error AlreadyClaimed()",
  "error NotClaimed()",
  "error CannotTransferClaimed()",
  "error ZeroAddress()",
  "error InvalidCommitmentHash()",
  "error InvalidSupply()",
]);

export const VAULT_ABI = parseAbi([
  "function isRefundable(address soulKeyContract, uint256 tokenId) view returns (bool)",
  "function deregisterGame(address soulKeyContract) external",
  "function registeredGames(address) view returns (bool)",
  "function owner() view returns (address)",
  // paymentRecords tuple: (address paymentToken, uint48 paidAt, uint8 status, uint256 amount, address payer)
  // uint48 exceeds Number.MAX_SAFE_INTEGER — viem decodes it as bigint.
  "function paymentRecords(address soulKeyContract, uint256 tokenId) view returns (address paymentToken, uint48 paidAt, uint8 status, uint256 amount, address payer)",
  "function processRefund(address soulKeyContract, uint256 tokenId, string calldata reason) nonpayable",
  "event RefundIssued(address indexed soulKeyContract, uint256 indexed tokenId, address indexed recipient, address paymentToken, uint256 refundedAmount, uint256 feeRetained, string reason)",
  "function registerGame(address soulKeyContract) external",
]);
