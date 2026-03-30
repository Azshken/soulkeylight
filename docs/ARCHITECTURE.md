# SoulKey — Architecture

## System Overview

```
User (MetaMask)
      │
      ▼
Next.js Frontend (Vercel)
      │              │
      ▼              ▼
Ethereum       Next.js API Routes
Sepolia              │         │
      │         Neon DB     Pinata
SoulKey.sol          │        (IPFS)
MasterKeyVault.sol   │
      │              │
      └──────────────┘
      (DB tracks what chain confirms)
```

Three layers must stay in sync: the blockchain (source of truth for ownership and soulbound state), the database (source of truth for key availability), and the API (orchestrates between them).

## Smart Contract Architecture

### SoulKey.sol (ERC-721 + ERC-2981)

One contract deployed per game. Holds no funds — all payments forwarded to MasterKeyVault.

**State variables:**
- `commitmentHash[tokenId]` — the keccak256 hash stored at mint, verified at claim
- `encryptedCdKey[tokenId]` — the wallet-encrypted key, written at claim
- `claimTimestamp[tokenId]` — 0 = unclaimed/transferable, non-zero = soulbound

**Key design points:**
- `mintWithETH` requires exact ETH amount (`msg.value != mintPriceETH` reverts) — no excess-refund griefing vector
- `mintWithUSDT/USDC` pulls tokens directly from user into vault via `safeTransferFrom`
- `claimCdKey` verifies `commitmentHash[tokenId] == cdKeyHash` before accepting encrypted key
- Soulbound is enforced in `_update()` override: if `claimTimestamp != 0` and it's not a mint/burn, revert `CannotTransferClaimed`
- `burnByVault` — only callable by MasterKeyVault (`onlyVault` modifier), used atomically inside `processRefund`
- `burn` — user-initiated, but only works on claimed tokens. Unclaimed tokens must go through `processRefund` so the vault can settle the payment
- `recoverERC20` — emergency function to rescue accidentally sent tokens (since SoulKey intentionally holds none)
- `Ownable2Step` — ownership transfer requires two-step confirmation

### MasterKeyVault.sol

Deployed once. Holds all ETH/USDT/USDC. Manages every game's payment lifecycle.

**Reserve lifecycle per payment:**
```
Locked
  ├── ReleasedByClaim   → CD key claimed, refund permanently blocked
  ├── ReleasedByExpiry  → 14-day window passed, refund permanently blocked
  └── Refunded          → refund processed within window, 5% fee retained
```

**Key design points:**
- `collectPayment` — called by SoulKey at mint time, records payment in reserve
- `releaseReserveOnClaim(tokenId, claimant)` — called by SoulKey inside `claimCdKey`. Vault cross-checks `claimant == ownerOf(tokenId)` to prevent a buggy game contract releasing reserves without a genuine claim
- `releaseReserveOnExpiry(tokenId)` — permissionless after 14 days, so unlocking never depends on owner liveness
- `processRefund` — validates window, retains fee, calls `burnByVault` on SoulKey atomically, returns funds
- Anti-DoS: 5% fee makes supply-griefing (mint-all → refund-all) economically irrational
- `Ownable2Step` — same safe ownership pattern

## Database Architecture

### Table Relationships
```
products
  └── batches
        └── cd_keys (reserved_by → cleared after mint)
              └── mints (cdkey_id UNIQUE — one mint per key)
                    └── redemptions (cdkey_id UNIQUE — one claim per key)
                    └── refunds
reserve_releases (audit log)
```

### Key Design Choices

**`cd_keys.reserved_by`** — soft wallet-level reservation. When `/api/mint/get-commitment` is called, the cheapest available key is locked with `SELECT ... FOR UPDATE SKIP LOCKED`. Released atomically when `link-token` inserts the mint row, or rolled back on failure.

**`mints.token_id` — no global UNIQUE** — each SoulKey contract starts token IDs from 1. Game A and Game B both have a token #1. The combination `(contract_address, token_id)` is unique, not `token_id` alone. Bug where global UNIQUE caused silent rollbacks for multi-game setups was fixed by dropping the constraint.

**`redemptions.frozen_metadata_cid`** — stores IPFS CID of post-claim frozen metadata. NFT metadata endpoint checks this: if CID exists → 301 redirect to IPFS; if not → serve dynamic JSON.

**DB-first token status** — token ownership read from `mints` table, not RPC. 200-500ms faster, fewer RPC calls. Risk: can go out of sync if users interact with contract directly (no event listener yet — see OPEN_ISSUES).

## API Layer

All routes accept `contractAddress` in request body/query. No single-contract assumptions.

### Mint Flow
```
POST /api/mint/get-commitment
  → Verify wallet signature + on-chain ownership (viem verifyMessage + createPublicClient)
  → SELECT available key WITH SKIP LOCKED
  → SET reserved_by = wallet
  → RETURN commitmentHash

[User mints on-chain]

POST /api/mint/link-token
  → INSERT into mints (contract_address, token_id, cdkey_id, wallet)
  → CLEAR reserved_by on cd_keys row
```

### Claim Flow
```
POST /api/redeem
  → Verify NFT ownership (DB lookup)
  → AES-256 decrypt CD key server-side
  → Re-encrypt with user's MetaMask public key (x25519-xsalsa20-poly1305)
  → Return encrypted key to frontend

[User calls claimCdKey on-chain]
  → Vault releases reserve atomically

POST /api/redeem/confirm
  → INSERT into redemptions (wallet_encrypted_cdkey, frozen_metadata_cid)
  → DELETE encrypted_key from cd_keys (AES copy gone; only wallet-encrypted copy exists on-chain)
```

### Refund Flow
```
[User calls processRefund on MasterKeyVault]
  → 14-day window validated on-chain
  → vault calls burnByVault on SoulKey atomically
  → 5% fee retained, remainder returned

POST /api/refund
  → INSERT into refunds table
  → cd_key becomes available again (db.ts checks refunds table)
```

### Admin Auth (import-keys route)
1. Timestamp check — reject if message older than 5 minutes
2. `verifyMessage` — viem signature verification
3. `createPublicClient` RPC call — verify wallet is contract owner on-chain
This is the current pattern. Not yet SIWE — see OPEN_ISSUES.

### NFT Metadata Endpoint
```
GET /api/nft/[contractAddress]/[tokenId]
  → Check redemptions table for frozen_metadata_cid
  → If found: 301 redirect to IPFS (permanent)
  → If not: return dynamic JSON (reads from products + mints tables)
```

## Frontend Architecture

- `app/page.tsx` + `HomeClient.tsx` — game selector (hero section) + user library
- `app/admin/page.tsx` + `AdminClient.tsx` — register game, import keys (single/batch), deregister game
- `components/CDKeyEncryption.tsx` — handles MetaMask `eth_getEncryptionPublicKey` + `eth_decrypt`
- `components/Providers.tsx` — WagmiProvider + QueryClientProvider + RainbowKitProvider
- `utils/abis.ts` — single source of truth for SoulKey and MasterKeyVault ABIs
- wagmi v2 + RainbowKit (not scaffold-ETH). Direct viem calls.

**Multi-game:** Frontend discovers games at runtime via `GET /api/products`. Game selector appears automatically when 2+ active products exist. Deregistered games hidden from mint UI but visible in existing library.

**Checksumming:** Always apply `getAddress()` from viem when reading contract addresses from DB before passing to wagmi hooks. Lowercase addresses cause silent read failures.
