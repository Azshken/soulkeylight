@AGENTS.md
# SoulKey — Claude Code Briefing

> Auto-loaded by Claude Code every session. Keep concise and current.
> Last updated: 2026-03-29

## What This Project Is

SoulKey sells game CD keys as NFTs called **Virtual Game Cards (VGCs)**. Users mint a VGC, claim their CD key (encrypts it to their MetaMask wallet, makes the NFT permanently soulbound), and can request a refund within 14 days (5% fee retained).

**Live demo:** https://soulkey.vercel.app/ (Sepolia testnet)
**Repo:** https://github.com/Azshken/soulkeylight

## Tech Stack

| Layer | Technology |
|---|---|
| Smart contracts | Solidity ^0.8.20, Foundry, OpenZeppelin |
| Frontend | Next.js (App Router), RainbowKit, Wagmi v2, Viem |
| Backend | Next.js API routes |
| Database | PostgreSQL via Neon serverless |
| NFT metadata | Dynamic Vercel API endpoint |
| Encryption | AES-256 server-side, x25519-xsalsa20-poly1305 MetaMask |
| Payments | ETH, USDT, USDC |
| Hosting | Vercel |

## Repo Structure

```
soulkeylight/
├── CLAUDE.md
├── CHANGE_LOG.md
├── DEV_LOG.md
├── foundry/
│   ├── contracts/
│   │   ├── SoulKey.sol          # ERC-721 per-game NFT contract
│   │   └── MasterKeyVault.sol   # Payment + refund vault (deployed once)
│   ├── script/
│   │   ├── DeployGameContract.s.sol
│   │   ├── DeployYourContract.s.sol
│   │   └── VerifyAll.s.sol
│   ├── test/
│   │   ├── SoulKey.t.sol
│   │   ├── MasterKeyVault.t.sol
│   │   ├── SoulKeyVaultIntegration.t.sol
│   │   └── mocks/MockERC20.sol
│   └── foundry.toml
└── nextjs/
    ├── app/
    │   ├── admin/
    │   │   ├── AdminClient.tsx
    │   │   └── page.tsx
    │   ├── api/
    │   │   ├── admin/
    │   │   │   ├── contract-status/route.ts
    │   │   │   ├── deregister-game/route.ts
    │   │   │   ├── import-keys/route.ts
    │   │   │   └── register-game/route.ts
    │   │   ├── library/route.ts
    │   │   ├── mint/
    │   │   │   ├── get-commitment/route.ts
    │   │   │   └── link-token/route.ts
    │   │   ├── nft/[contractAddress]/[tokenId]/route.ts
    │   │   ├── products/route.ts
    │   │   ├── redeem/
    │   │   │   ├── confirm/route.ts
    │   │   │   └── route.ts
    │   │   ├── refund/route.ts
    │   │   └── tokens/route.ts
    │   ├── HomeClient.tsx
    │   ├── layout.tsx
    │   └── page.tsx
    ├── components/
    │   ├── CDKeyEncryption.tsx
    │   ├── Footer.tsx
    │   ├── Header.tsx
    │   └── Providers.tsx
    ├── lib/
    ├── styles/
    └── utils/
        ├── abis.ts       # single source of truth for all ABIs
        ├── crypto.ts     # encrypt, hashCDKey
        └── db.ts         # all DB queries
```

## Smart Contracts

### SoulKey.sol — deploy one per game
Key functions:
- `mintWithETH(bytes32 cdCommitmentHash)` — exact ETH required, no refund path
- `mintWithUSDT(bytes32)` / `mintWithUSDC(bytes32)` — pulls tokens directly into vault
- `claimCdKey(uint256 tokenId, bytes32 cdKeyHash, bytes ownerEncryptedKey)` — writes encrypted key on-chain, makes NFT soulbound, releases vault reserve
- `burnByVault(uint256 tokenId)` — only vault can call this (refund flow)
- `burn(uint256 tokenId)` — user can only burn already-claimed (soulbound) tokens
- `getEncryptedCDKey(uint256)`, `getCommitmentHash(uint256)`, `getClaimTimestamp(uint256)`

Soulbound = `claimTimestamp[tokenId] != 0`. Transfer blocked in `_update()` override.
**SoulKey holds NO funds** — all payments forwarded to vault via `collectPayment`.

### MasterKeyVault.sol — deployed once, shared across all games
Reserve lifecycle: Locked → ReleasedByClaim | ReleasedByExpiry | Refunded
- `collectPayment` — called by SoulKey at mint
- `releaseReserveOnClaim(tokenId, claimant)` — called by SoulKey.claimCdKey
- `releaseReserveOnExpiry(tokenId)` — permissionless after 14-day window expires
- 5% refund fee by default, 10% hard cap, configurable by owner
- Ownable2Step on both contracts

## Database Schema

```
products        — contract_address, name, genre, description, is_active
batches         — batch_id, product_id, created_at, notes
cd_keys         — id, batch_id, encrypted_key, commitment_hash, reserved_by VARCHAR(42), created_at
mints           — mint_id, cdkey_id UNIQUE FK, token_id (NO global UNIQUE), contract_address, minted_by, minted_at
redemptions     — redemption_id, cdkey_id UNIQUE FK, wallet_encrypted_cdkey, frozen_metadata_cid, redeemed_by, redeemed_at
refunds         — refund_id, cdkey_id, refunded_by, refunded_at, refund_tx_hash
reserve_releases — audit log of reservation releases
```

⚠️ `mints.token_id` has NO global UNIQUE — token IDs are scoped per contract. Each game starts from token_id=1.

## Core Flow

```
1. Admin imports keys → POST /api/admin/import-keys → stored AES-256 encrypted in cd_keys
2. User → POST /api/mint/get-commitment → key reserved (reserved_by=wallet), commitmentHash returned
3. User mints on-chain with commitmentHash
4. Frontend → POST /api/mint/link-token → row into mints, reserved_by cleared
5. User → POST /api/redeem → key decrypted server-side, re-encrypted with MetaMask public key
6. User calls claimCdKey on-chain → NFT soulbound, vault reserve released
7. Frontend → POST /api/redeem/confirm → redemption saved, encrypted key deleted from DB
8. (Optional) Refund within 14 days → POST /api/refund records in DB
```

## Environment Variables

```
ENCRYPTION_KEY                        # AES-256 — must match Vercel exactly
DATABASE_URL                          # Neon PostgreSQL connection string
ALCHEMY_RPC_URL                       # for on-chain ownership verification
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
NEXT_PUBLIC_VAULT_ADDRESS
PINATA_JWT
```

⚠️ Never rotate ENCRYPTION_KEY without migrating all DB records first.
⚠️ Never use NEXT_PUBLIC_ prefix for secrets.
⚠️ Always store/compare contract addresses checksummed — use `getAddress()` from viem.

## Docs

- `docs/ARCHITECTURE.md` — full system design
- `docs/DECISIONS.md` — why things were built this way
- `docs/OPEN_ISSUES.md` — current task list
