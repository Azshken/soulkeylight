# SoulKey — Claude Code Briefing

> Auto-loaded by Claude Code every session. Keep concise and current.
> Last updated: 2026-04-28

## What This Project Is

SoulKey sells game CD keys as NFTs called **Virtual Game Cards (VGCs)**. Users mint a VGC, claim
their CD key (encrypts it to their wallet using X25519 derived from `personal_sign`, makes the NFT
permanently soulbound), and can request a refund within 14 days (5% fee retained).

V1 (current, grant-funded): X25519 encryption, single operator.
V2 (post-grant): Hybrid X25519 + ML-KEM-768 encryption; developer-owned contracts; permissionless
publishing.

**Live demo:** https://soulkey.vercel.app/ (Sepolia testnet)
**Repo:** https://github.com/Azshken/soulkeylight

## Tech Stack

| Layer | Technology |
|---|---|
| Smart contracts | Solidity ^0.8.20, Foundry, OpenZeppelin |
| Frontend | Next.js (App Router), RainbowKit, Wagmi v2, Viem |
| Backend | Next.js API routes |
| Database | PostgreSQL via Neon serverless |
| NFT metadata | Dynamic Vercel API endpoint + Pinata IPFS (frozen post-claim) |
| Encryption | AES-256 server-side (retained post-claim); X25519 on-chain (v1); hybrid X25519 + ML-KEM-768 in v2 |
| Payments | ETH, USDT, USDC |
| Hosting | Vercel |
| Tests | Vitest + Testing Library (Next.js API + component tests) |

## Repo Structure

```
soulkeylight/
├── CLAUDE.md
├── CHANGE_LOG.md
├── DEV_LOG.md
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DECISIONS.md
│   ├── GOTCHAS.md
│   └── OPEN_ISSUES.md
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
    ├── __tests__/
    │   ├── admin/
    │   │   ├── adminSession.test.ts      # requireAdminSession: all auth states
    │   │   ├── nonce.test.ts             # nonce generation + session storage
    │   │   ├── verify.test.ts            # full SIWE verify gauntlet
    │   │   └── auth-guard.test.ts        # 401/403 on all protected routes
    │   ├── utils/
    │   │   └── helpers.test.ts           # toBytes32 / toHexBytes unit tests
    │   └── HomeClient.claimCdKey.test.tsx # claim flow integration tests
    ├── app/
    │   ├── admin/
    │   │   ├── AdminClient.tsx
    │   │   └── page.tsx
    │   ├── api/
    │   │   ├── admin/
    │   │   │   ├── contract-status/route.ts
    │   │   │   ├── deregister-game/route.ts
    │   │   │   ├── import-keys/route.ts
    │   │   │   ├── nonce/route.ts        # SIWE nonce endpoint
    │   │   │   ├── verify/route.ts       # SIWE verify endpoint
    │   │   │   ├── logout/route.ts       # SIWE session destroy
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
    │   ├── Footer.tsx
    │   ├── Header.tsx
    │   └── Providers.tsx
    ├── lib/
    ├── styles/
    ├── vitest.config.ts
    ├── vitest.setup.tsx              # must be .tsx — contains JSX
    └── utils/
        ├── abis.ts                   # single source of truth for all ABIs
        ├── adminSession.ts           # iron-session config + requireAdminSession()
        ├── crypto.ts                 # encryptWithX25519, decryptWithX25519, encrypt, hashCDKey
        ├── db.ts                     # all DB queries
        └── helpers.ts                # toBytes32, toHexBytes — shared across component + tests
```

## Smart Contracts

### SoulKey.sol — deploy one per game
Key functions:
- `mintWithETH(bytes32 cdCommitmentHash)` — exact ETH required, no refund path
- `mintWithUSDT(bytes32)` / `mintWithUSDC(bytes32)` — pulls tokens directly into vault
- `claimCdKey(uint256 tokenId, bytes32 cdKeyHash, bytes ownerEncryptedKey)` — writes X25519
  ciphertext (~60 bytes in v1) on-chain, makes NFT soulbound, releases vault reserve
- `burnByVault(uint256 tokenId)` — only vault can call this (refund flow)
- `burn(uint256 tokenId)` — user can only burn already-claimed (soulbound) tokens
- `getEncryptedCDKey(uint256)`, `getCommitmentHash(uint256)`, `getClaimTimestamp(uint256)`

Soulbound = `claimTimestamp[tokenId] != 0`. Transfer blocked in `_update()` override.
**SoulKey holds NO funds** — all payments forwarded to vault via `collectPayment`.
**No `updateEncryptionKey`** — not needed given AES retention + HKDF forward-compatible design.
See DECISIONS.md.

### MasterKeyVault.sol — deployed once, shared across all games
Reserve lifecycle: Locked → ReleasedByClaim | ReleasedByExpiry | Refunded
- `collectPayment` — called by SoulKey at mint
- `releaseReserveOnClaim(tokenId, claimant)` — called by SoulKey.claimCdKey
- `releaseReserveOnExpiry(tokenId)` — permissionless after 14-day window expires
- 5% refund fee by default, 10% hard cap, configurable by owner
- Ownable2Step on both contracts

## Database Schema

```
products        — contract_address, name, genre, description, image_cid, image_claimed_cid, metadata_cid, is_active
batches         — batch_id, product_id, created_at, notes
cd_keys         — id, batch_id, encrypted_key, commitment_hash, reserved_by VARCHAR(42), created_at
mints           — mint_id, cdkey_id UNIQUE FK, token_id (NO global UNIQUE), contract_address, minted_by, minted_at
redemptions     — redemption_id, cdkey_id UNIQUE FK, wallet_encrypted_cdkey, redeemed_by, redeemed_at,
                  redemption_tx_hash, block_number, frozen_metadata_cid
refunds         — refund_id, cdkey_id, refunded_by, refunded_at, refund_tx_hash
reserve_releases — audit log of reservation releases
```

⚠️ `mints.token_id` has NO global UNIQUE — token IDs are scoped per contract. Each game starts from token_id=1.
⚠️ `cd_keys.encrypted_key` — NOT nulled after claim in v1. Retained as v2 migration enabler.
⚠️ `products.image_claimed_cid` — optional post-claim cover art. Falls back to `image_cid` if null.

## Core Flow

```
1. Admin imports keys → POST /api/admin/import-keys → stored AES-256 encrypted in cd_keys
2. User → POST /api/mint/get-commitment → key reserved (reserved_by=wallet), commitmentHash returned
3. User mints on-chain with commitmentHash
4. Frontend → POST /api/mint/link-token → row into mints, reserved_by cleared
5. User → POST /api/redeem:
     - personal_sign → HKDF-SHA256 (full 65-byte IKM, 32-byte output) → X25519 keypair
     - x25519PublicKey sent to server
     - Server AES-decrypts CD key, runs encryptWithX25519(cdKey, x25519Pk)
     - Returns ~60 byte X25519 ciphertext
     - Partial redemption row inserted (wallet_encrypted_cdkey only)
6. User calls claimCdKey on-chain with ciphertext → NFT soulbound, vault reserve released
7. Frontend → POST /api/redeem/confirm:
   a. Server fetches tx receipt independently (never trusts client-provided status)
   b. Server verifies claimTimestamp > 0 on-chain
   c. confirmRedemption() fills redeemed_by / tx data into existing partial row
   d. Pinata upload → frozen_metadata_cid saved (non-fatal if it fails)
   e. recordReserveRelease() audit log
   f. AES copy in cd_keys.encrypted_key is RETAINED (v2 migration enabler — NOT deleted)
8. (Optional) Refund within 14 days → POST /api/refund records in DB
```

## Encryption Summary (v1)

The deprecated `eth_getEncryptionPublicKey` / `eth_decrypt` are replaced with X25519 derived from
`personal_sign` + HKDF-SHA256. V2 (post-grant) upgrades to hybrid X25519 + ML-KEM-768.

**v1 key derivation:**
```
personal_sign("SoulKey encryption key v1\nAddress: <wallet>")
  → HKDF-SHA256(IKM = full 65 bytes, salt = "soulkey-hybrid-v1", length = 32)
  → [0..32]  X25519 secret key → X25519 public key
```

Server encrypts with `encryptWithX25519(cdKey, x25519Pk)` → ~60 byte ciphertext stored on-chain.
Client re-derives X25519 secret at reveal time and decrypts locally. Keypair cached in `useRef`
for the session — claim + immediate reveal = one `personal_sign` prompt total.

**HKDF forward compatibility:** v2 requests `length = 96` from the same derivation to add the
ML-KEM-768 seed. V1 ciphertexts remain decryptable — the extra 64 bytes are simply not needed
until the v2 migration transaction for each token.

⚠️ HKDF IKM must use ALL 65 signature bytes. `getBytes(sig).slice(0, 32)` halves entropy silently.
⚠️ AES copy in `cd_keys.encrypted_key` must NOT be deleted in v1 (v2 migration enabler).

## Admin Auth (SIWE — implemented)

```
GET  /api/admin/nonce   → generateSiweNonce() stored in iron-session
POST /api/admin/verify  → parseSiweMessage → domain/nonce/expiry checks
                           → verifyMessage() → on-chain owner() check
                           → session cookie written
Protected routes        → requireAdminSession() in utils/adminSession.ts
POST /api/admin/logout  → session.destroy()
```

One wallet popup per session. Session lives 8 hours.

## Environment Variables

```
ENCRYPTION_KEY                        # AES-256 — must match Vercel exactly
DATABASE_URL                          # Neon PostgreSQL connection string
ALCHEMY_RPC_URL                       # for on-chain ownership verification
SESSION_SECRET                        # ≥32 bytes for iron-session (SIWE)
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
NEXT_PUBLIC_VAULT_ADDRESS
NEXT_PUBLIC_APP_URL
PINATA_JWT
```

⚠️ Never rotate ENCRYPTION_KEY without migrating all DB records first.
⚠️ Never use NEXT_PUBLIC_ prefix for secrets.
⚠️ SESSION_SECRET missing → cryptic EIP-4361 "max line number was 9" error from iron-session.
⚠️ Always checksum contract addresses from DB — use `getAddress()` from viem.

## Running Tests

```bash
cd nextjs
pnpm test        # run once
pnpm test:watch  # watch mode
```

Tests in `nextjs/__tests__/`. 35 admin auth tests + claim flow integration tests + helpers unit
tests. Wagmi hooks and `window.ethereum` fully mocked — no wallet or DB needed.

When updating `HomeClient.claimCdKey.test.tsx` for the new encryption scheme, the
`window.ethereum` mock uses `personal_sign` (not `eth_getEncryptionPublicKey`). The mock
should return a deterministic 65-byte hex string (e.g. `"0x" + "ab".repeat(32) + "01"`) so HKDF
produces a consistent X25519 keypair across test runs.

## Docs

- `docs/ARCHITECTURE.md` — full system design including encryption scheme, v2 architecture overview
- `docs/DECISIONS.md` — why things were built this way (includes v1/v2 encryption split, AES
  retention, ZK deferral, v2 developer ownership)
- `docs/GOTCHAS.md` — hard-won lessons and non-obvious bugs
- `docs/OPEN_ISSUES.md` — current task list and mainnet checklist
