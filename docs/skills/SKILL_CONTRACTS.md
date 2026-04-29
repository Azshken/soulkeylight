---
name: soulkey-contracts
description: >
  Patterns, decisions, and invariants for SoulKey's Solidity contracts.
  Use this skill whenever writing, modifying, testing, or deploying any .sol
  file, any Foundry script, or any Foundry test. Triggers on: "SoulKey.sol",
  "MasterKeyVault.sol", "forge", "claimCdKey", "burnByVault", "collectPayment",
  "releaseReserveOnClaim", "soulbound", "commitment hash", "refund fee", or any
  mention of deploying a new game contract.
  DO NOT use for: Next.js API routes, database queries, frontend hooks, or
  wagmi — use soulkey-api-db or soulkey-frontend instead.
---

# SoulKey Smart Contract Patterns

Reference: `docs/ARCHITECTURE.md` for the two-contract design rationale.

---

## Architecture: Two Contracts, One Purpose Each

- **`SoulKey.sol`** — ERC-721 per game. Handles mint, claim, burn. **Holds zero funds.**
- **`MasterKeyVault.sol`** — Deployed once. Holds all ETH/USDT/USDC. Manages refund reserves.

Deploy a fresh `SoulKey.sol` per game. The vault address is passed to each SoulKey constructor. Never reuse a SoulKey contract for a different game.

---

## SoulKey: Core Invariants

### Soulbound via claimTimestamp (not a bool)
```solidity
mapping(uint256 => uint256) private claimTimestamp; // 0 = unclaimed

// _update override:
if (claimTimestamp[tokenId] != 0) revert CannotTransferClaimed();
```
Using a timestamp instead of a bool gives claim time for free — needed for the 14-day refund window and metadata. `claimTimestamp == 0` → unclaimed and transferable.

### Commitment hash pattern
```
Mint:  user submits keccak256(encryptedKey) — the commitmentHash
Claim: server verifies commitmentHash[tokenId] == cdKeyHash before accepting
```
Keeps the encrypted key off-chain until active claim. Front-running is harmless — an attacker copying the commitmentHash still pays for an NFT they can never redeem.

### Exact ETH, no excess refund
```solidity
if (msg.value != mintPriceETH) revert InvalidETHAmount();
```
No excess-refund path. Eliminates the smart-contract-receiver griefing vector. Frontend reads `mintPriceETH` and constructs the exact amount.

### Stablecoin minting pulls directly to vault
```solidity
usdt.safeTransferFrom(msg.sender, address(vault), mintPriceUSD);
```
Tokens go directly into the vault, not SoulKey. Token address read from vault at call time.

---

## Burn Rules

| Scenario | Function | Restriction |
|---|---|---|
| Refund flow | `burnByVault(tokenId)` | `onlyVault` — inside `processRefund` only |
| User-initiated | `burn(tokenId)` | Only claimed (soulbound) tokens |
| Unclaimed token | Must use `processRefund` | Direct burn leaves funds locked forever |

**Never allow a user to directly burn an unclaimed token.**

---

## MasterKeyVault: Reserve Lifecycle

```
Locked → ReleasedByClaim   (CD key claimed, refund permanently blocked)
       → ReleasedByExpiry  (14 days passed, permissionless — no owner dependency)
       → Refunded          (within window, 5% fee retained)
```

`releaseReserveOnClaim(tokenId, claimant)` — vault cross-checks `claimant == ownerOf(tokenId)` to prevent a buggy game contract releasing reserves without a genuine claim.

`releaseReserveOnExpiry` is permissionless — reserve unlocking never depends on owner being alive.

**5% refund fee is anti-griefing:** makes mint-all-then-refund-all economically irrational.

---

## Security Checklist

- `Ownable2Step` on both contracts — prevents typo'd ownership transfer
- `nonReentrant` on mint and claim functions
- `Pausable` — `whenNotPaused` on mint
- ERC-2981 royalties point to the vault, not the deployer wallet
- Checks-effects-interactions: state changes before any external vault call

---

## ERC-721 supportsInterface Override

```solidity
function supportsInterface(bytes4 interfaceId)
    public view override(ERC721, ERC2981) returns (bool)
{
    return interfaceId == 0x49064906 || super.supportsInterface(interfaceId);
}
```
`0x49064906` is ERC-4906 (metadata update events). Required for OpenSea to re-fetch metadata after claim. Without this, OpenSea never picks up the post-claim metadata change.

---

## Deployment

```bash
# Deploy vault once
forge script script/DeployYourContract.s.sol --rpc-url $RPC_URL --broadcast

# Deploy one SoulKey per game
forge script script/DeployGameContract.s.sol --rpc-url $RPC_URL --broadcast
# Then register via /admin page (not in script — multisig incompatible)
```

Foundry deps use git submodules, not a lockfile:
```bash
forge install OpenZeppelin/openzeppelin-contracts --no-commit
# If submodules lost, re-run individually
```

---

## Checklist Before Any Contract Change

- [ ] Mint function is `nonReentrant`?
- [ ] `vault.collectPayment` called after all state changes (CEI)?
- [ ] Can a user burn an unclaimed token directly? (Must NOT be possible.)
- [ ] `burnByVault` still has `onlyVault`?
- [ ] `_update` override still blocks transfers when `claimTimestamp != 0`?
- [ ] `setMaxSupply` prevents setting below current supply?
- [ ] Royalties still pointing to vault?
- [ ] New SoulKey deployment: vault address passed to constructor?
- [ ] `supportsInterface` override includes `0x49064906` (ERC-4906)?
