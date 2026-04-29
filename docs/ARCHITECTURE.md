# SoulKey — Architecture

## System Overview

```
User (EOA wallet)
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

Three layers must stay in sync: the blockchain (source of truth for ownership and soulbound state),
the database (source of truth for key availability), and the API (orchestrates between them).

## Smart Contract Architecture

### SoulKey.sol (ERC-721 + ERC-2981)

One contract deployed per game. Holds no funds — all payments forwarded to MasterKeyVault.
Each contract is independently ownable — the deployer controls price, supply, metadata CID, and
key inventory. In v2, each developer owns their game contract directly.

**State variables:**
- `commitmentHash[tokenId]` — the keccak256 hash stored at mint, verified at claim
- `encryptedCdKey[tokenId]` — the wallet-encrypted key, written at claim (`bytes`, variable length)
- `claimTimestamp[tokenId]` — 0 = unclaimed/transferable, non-zero = soulbound

**Key design points:**
- `mintWithETH` requires exact ETH amount (`msg.value != mintPriceETH` reverts) — no
  excess-refund griefing vector
- `mintWithUSDT/USDC` pulls tokens directly from user into vault via `safeTransferFrom`
- `claimCdKey` verifies `commitmentHash[tokenId] == cdKeyHash` before accepting encrypted key.
  The commitment hash is immutable on-chain — no developer can retroactively substitute a different
  key after a buyer has minted. This is the primary anti-tamper guarantee for the permissionless v2 model.
- Soulbound enforced in `_update()` override: if `claimTimestamp != 0` and not a mint/burn,
  revert `CannotTransferClaimed`
- `burnByVault` — only callable by MasterKeyVault (`onlyVault` modifier), used atomically inside
  `processRefund`
- `burn` — user-initiated, but only works on claimed tokens. Unclaimed tokens must go through
  `processRefund` so the vault can settle the payment
- `recoverERC20` — emergency function to rescue accidentally sent tokens (since SoulKey holds none)
- `Ownable2Step` — ownership transfer requires two-step confirmation
- **No `updateEncryptionKey` function** — considered and rejected. See DECISIONS.md —
  *No updateEncryptionKey on SoulKey.sol*.
- **SCW-compatible:** all ownership checks use `ownerOf` (plain address comparison); no signature
  logic lives inside the contracts. Works for EOAs and smart contract wallets with no code changes.

### MasterKeyVault.sol

Deployed once. Holds all ETH/USDT/USDC. Manages every game's payment lifecycle. In v1, the Vault
operator manages registration directly. In v2, this registry role becomes the trust anchor for
developer-owned contracts — verifying and (de)registering developer-deployed `SoulKey.sol`
contracts without holding any game-specific authority.

**Reserve lifecycle per payment:**
```
Locked
  ├── ReleasedByClaim   → CD key claimed, refund permanently blocked
  ├── ReleasedByExpiry  → 14-day window passed, refund permanently blocked
  └── Refunded          → refund processed within window, 5% fee retained
```

**Key design points:**
- `collectPayment` — called by SoulKey at mint time, records payment in reserve
- `releaseReserveOnClaim(tokenId, claimant)` — called by SoulKey inside `claimCdKey`. Vault
  cross-checks `claimant == ownerOf(tokenId)` to prevent a buggy game contract releasing reserves
  without a genuine claim
- `releaseReserveOnExpiry(tokenId)` — permissionless after 14 days, so unlocking never depends on
  owner liveness
- `processRefund` — validates window, retains fee, calls `burnByVault` on SoulKey atomically,
  returns funds
- Anti-DoS: 5% fee makes supply-griefing (mint-all → refund-all) economically irrational
- `Ownable2Step` — same safe ownership pattern

## Database Architecture

### Table Relationships
```
products (image_cid, image_claimed_cid)
  └── batches
        └── cd_keys (reserved_by → cleared after mint; encrypted_key → RETAINED after claim)
              └── mints (cdkey_id UNIQUE — one mint per key)
                    └── redemptions (cdkey_id UNIQUE — one claim per key; frozen_metadata_cid)
                    └── refunds
reserve_releases (audit log)
```

### Key Design Choices

**`cd_keys.reserved_by`** — soft wallet-level reservation. When `/api/mint/get-commitment` is
called, the cheapest available key is locked with `SELECT ... FOR UPDATE SKIP LOCKED`. Released
atomically when `link-token` inserts the mint row, or rolled back on failure.

**`mints.token_id` — no global UNIQUE** — each SoulKey contract starts token IDs from 1. Game A
and Game B both have a token #1. The combination `(contract_address, token_id)` is unique, not
`token_id` alone. Bug where global UNIQUE caused silent rollbacks for multi-game setups was fixed
by dropping the constraint.

**`redemptions` — two-phase write** — the row is created by `/api/redeem` with only
`wallet_encrypted_cdkey` populated (partial). `/api/redeem/confirm` fills in `redeemed_by`,
`redeemed_at`, `redemption_tx_hash`, `block_number`, and `frozen_metadata_cid` only after the
on-chain tx is independently verified. `confirmRedemption()` guards with a `rowCount === 0` check
— if the partial row doesn't exist it throws before any further action.

**`redemptions.frozen_metadata_cid`** — stores IPFS CID of post-claim frozen metadata. NFT
metadata endpoint checks this: if CID exists → 301 redirect to IPFS; if not → serve dynamic JSON.

**`products.image_claimed_cid`** — optional per-game cover art used specifically in post-claim
frozen metadata. Falls back to `image_cid` when null, so frozen metadata is always uploaded to
Pinata regardless. Currently set via direct SQL in Neon (no admin UI).

**DB-first token status** — token ownership read from `mints` table, not RPC. 200-500ms faster,
fewer RPC calls. Risk: can go out of sync if users interact with contract directly (no event
listener yet — see OPEN_ISSUES).

**`cd_keys.encrypted_key` — retained after claim (not deleted)** — the AES-256 server-side copy
is deliberately kept after `claimCdKey` confirms on-chain. This is the v2 migration enabler: when
the encryption scheme is upgraded to hybrid X25519 + ML-KEM-768, the server can re-encrypt each
key using the AES copy and present the new ciphertext to the user for a single on-chain update —
no decrypt-burden falls on the user, and no user cooperation is required at migration time. The
AES copy is cleared only after a successful v2 hybrid re-encryption. See DECISIONS.md —
*AES copy retained post-claim as v2 migration enabler*.

## Encryption Architecture

The encrypted CD key is written **permanently on-chain** at claim time (`encryptedCdKey[tokenId]`).
The choice of encryption scheme has **lifetime consequences** for every claimed token — migration
to a stronger scheme must be planned from the start.

### v1 Scheme: X25519 (personal_sign + HKDF)

All cryptographic operations run in the browser using `@noble/curves`. The wallet's only role is
`personal_sign` — no special wallet support is required, and no deprecated MetaMask APIs
(`eth_getEncryptionPublicKey`, `eth_decrypt`) are used. Works on MetaMask, Rabby, Rainbow, Brave
Wallet, Ledger bridges, and any wallet supporting `personal_sign`.

**Key derivation (client, claim + reveal):**
```
personal_sign("SoulKey encryption key v1\nAddress: <wallet>")
       │
       │  All 65 signature bytes used as IKM — never truncate.
       │  Slicing to 32 bytes halves entropy; use getBytes(sig) in full.
       ▼
HKDF-SHA256(IKM = sigBytes[0..65], salt = "soulkey-hybrid-v1", length = 32)
       │
       └── [0..32] → X25519 secret key → X25519 public key (32 bytes)
```

Note: the salt `"soulkey-hybrid-v1"` and a 32-byte output are intentional for forward
compatibility — v2 requests 96 bytes from the same derivation to add the ML-KEM-768 seed, and no
existing v1 ciphertext is invalidated by this extension.

**Encryption (server, `/api/redeem`):**
```
ephX25519Sk = random()
ephX25519Pk = X25519.getPublicKey(ephX25519Sk)          // 32 bytes
x25519Ss    = X25519.getSharedSecret(ephX25519Sk, userX25519Pk)

encKey = HKDF-SHA256(x25519Ss, "soulkey-hybrid-v1")    // 32 bytes
aesCt  = AES-256-GCM.encrypt(encKey, nonce, plaintextCdKey)

on-chain bytes: [ephX25519Pk(32)][nonce(12)][aesCt(n+16)]
total: ~60+ bytes
```

**Decryption (client, reveal — re-derive keypair from same `personal_sign`):**
```
x25519Ss = X25519.getSharedSecret(userX25519Sk, ephX25519Pk)
encKey   = HKDF-SHA256(x25519Ss, "soulkey-hybrid-v1")
cdKey    = AES-256-GCM.decrypt(encKey, nonce, aesCt)
```

**Security guarantee (v1):** Breaking any given ciphertext requires breaking X25519, which is hard
for classical adversaries. This removes all deprecated MetaMask API dependency and extends wallet
compatibility to the full EOA ecosystem.

**On-chain storage:** `encryptedCdKey[tokenId]` is typed `bytes` (variable length) — the contract
accepts the v1 ciphertext (~60 bytes) and the future v2 ciphertext (~1,168 bytes) with no changes.

### v2 Scheme: Hybrid X25519 + ML-KEM-768 (post-grant)

After v1 mainnet deployment and audit, the encryption scheme will be upgraded to hybrid
X25519 + ML-KEM-768 (NIST FIPS 203). This is the same pattern deployed in TLS 1.3 by Google, Go,
and Java. Breaking a v2 ciphertext requires breaking both X25519 (hard classically) and ML-KEM-768
(no known classical or quantum attack) simultaneously.

Because the v1 AES copy is retained server-side, this migration requires only one user-signed
transaction per token: the server prepares the new hybrid ciphertext using the AES copy, and the
user submits a single `personal_sign` to derive the expanded v2 keypair (96-byte HKDF output) and
call a migration function on-chain. No decrypt-and-re-encrypt burden falls on the user.

**v2 key derivation** extends v1 by requesting 96 bytes from the same derivation:
```
HKDF-SHA256(IKM = sigBytes[0..65], salt = "soulkey-hybrid-v1", length = 96)
  ├── [0..32]  → X25519 secret key
  └── [32..96] → ML-KEM-768 seed → ML-KEM-768 keypair (pk: 1,184 bytes | sk: 2,400 bytes)
```

v2 on-chain ciphertext: `[ephX25519Pk(32)][mlKemCt(1088)][nonce(12)][aesCt(n+16)]` ≈ 1,168 bytes.

### Future: EIP-5630

When wallets ship `eth_performECDH` (EIP-5630, Draft as of April 2026), the `personal_sign` +
HKDF derivation step can be replaced with a single `eth_performECDH` call. The encryption logic,
`/api/redeem`, and `encryptedCdKey` storage are all unchanged. No contract redeployment required.
Low priority until at least two major wallets ship it.

### ZK Proofs — Not Applicable Now

Zero-knowledge proofs were evaluated as a potential enhancement. The primary candidate was a ZK
claim proof: replacing the full on-chain ciphertext with a short ZK proof (~256 bytes vs ~1,168
bytes in v2), reducing `claimCdKey` gas significantly.

This is blocked by the planned v2 ML-KEM-768 component. ZK circuits operate over large prime
fields (BN254, BLS12-381). ML-KEM-768's polynomial arithmetic over `q = 3329` does not map to
these fields without expensive emulation — a research-level problem with no production circuit
available. Revisit when ZK-friendly post-quantum primitives exist in production. See DECISIONS.md
— *ZK proofs: deferred*.

## API Layer

All routes accept `contractAddress` in request body/query. No single-contract assumptions.

### Mint Flow
```
POST /api/mint/get-commitment
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
POST /api/redeem  { x25519PublicKey, tokenId, userAddress, contractAddress }
  → Verify NFT ownership (on-chain ownerOf call)
  → AES-256 decrypt CD key server-side
  → X25519 ECDH encrypt:
      ephemeral X25519 key pair → shared secret → HKDF → AES-256-GCM
      returns ~60 byte ciphertext
  → INSERT partial redemption row (wallet_encrypted_cdkey only)
  → Return ciphertext to frontend
  → AES copy in cd_keys.encrypted_key RETAINED (v2 migration enabler)

[User calls claimCdKey on-chain with ciphertext]
  → Vault releases reserve atomically

POST /api/redeem/confirm
  Step 1: getTransactionReceipt() — server fetches receipt independently,
          never trusts client-provided status. Aborts if reverted/unmined.
  Step 2: getClaimTimestamp() — verifies claimTimestamp > 0 on-chain.
  Step 3: confirmRedemption() — fills redeemed_by / tx data into partial row.
          Throws if rowCount === 0 (partial row missing = /api/redeem never completed).
  Step 4: Pinata upload → frozen_metadata_cid saved to redemptions. Non-fatal:
          wrapped in try/catch. Uses image_claimed_cid ?? image_cid.
  Step 5: recordReserveRelease() — audit log entry.
  Note: cd_keys.encrypted_key is NOT deleted. AES copy retained for v2 migration.
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

### Admin Auth — SIWE (EIP-4361)

```
GET /api/admin/nonce
  → generateSiweNonce() — alphanumeric nonce (≥8 chars, EIP-4361 compliant)
  → stored in iron-session cookie; previous auth cleared

POST /api/admin/verify { message: string, signature: "0x..." }
  → parseSiweMessage(message) — EIP-4361 structural parse
  → domain / nonce / expiry checks
  → publicClient.verifyMessage() — cryptographic signature recovery
  → on-chain owner() call — confirms recovered address owns MasterKeyVault
  → session.save({ address, authenticated: true }) — 8h cookie

All protected routes:
  → requireAdminSession() — 401 if not authenticated
  → on-chain owner() for the specific game contract
```

### NFT Metadata Endpoint
```
GET /api/nft/[contractAddress]/[tokenId]
  → Check redemptions table for frozen_metadata_cid
  → If found: 301 redirect to IPFS (permanent)
  → If not: return dynamic JSON (reads from products + mints tables)
```

## Frontend Architecture

- `app/page.tsx` + `HomeClient.tsx` — game selector (hero section) + user library. Contains
  inline X25519 encryption/decryption logic in `handleClaimCDKey` and `handleRevealCDKey`:
  `personal_sign` → HKDF (full 65-byte IKM, 32-byte output) → X25519 keypair derivation +
  AES-256-GCM decrypt. Keypair cached in `useRef`, cleared on wallet disconnect or address change.
- `app/admin/page.tsx` + `AdminClient.tsx` — SIWE sign-in gate, register game, import keys
  (single/batch), deregister game
- `components/Providers.tsx` — WagmiProvider + QueryClientProvider + RainbowKitProvider
- `utils/abis.ts` — single source of truth for SoulKey and MasterKeyVault ABIs
- `utils/adminSession.ts` — iron-session config + `requireAdminSession()` guard
- `utils/crypto.ts` — `encryptWithX25519()` (server, `/api/redeem`), `decryptWithX25519()` (client,
  reveal), `encrypt()`/`decrypt()` (server AES path for cd_keys storage, unchanged)
- `utils/helpers.ts` — `toBytes32`, `toHexBytes` — shared between component and tests
- wagmi v2 + RainbowKit (not scaffold-ETH). Direct viem calls.

**Multi-game:** Frontend discovers games at runtime via `GET /api/products`. Game selector appears
automatically when 2+ active products exist. Deregistered games hidden from mint UI but visible in
existing library.

**Checksumming:** Always apply `getAddress()` from viem when reading contract addresses from DB
before passing to wagmi hooks. Lowercase addresses cause silent read failures.

## Test Architecture

Vitest + Testing Library. Tests live in `nextjs/__tests__/`. Run with `pnpm test`.

### Claim flow tests (`HomeClient.claimCdKey.test.tsx`)
Wagmi hooks and `window.ethereum` are fully mocked; no RPC calls made. Covers:
- Happy path: receipt `success` → confirm called, success toast shown
- Reverted tx: confirm never called, error toast mentions "reverted"
- User rejection: `writeContractAsync` throws → confirm never called
- `/api/redeem` failure: server error before tx → confirm never called
- Guard conditions: no wallet, already claimed
- Loading state: spinner visible while tx is pending

The `window.ethereum` mock uses `personal_sign` (not `eth_getEncryptionPublicKey`). The mock
should return a deterministic 65-byte hex string (e.g. `"0x" + "ab".repeat(32) + "01"`) so HKDF
produces a consistent X25519 keypair across test runs.

### Admin auth tests (`__tests__/admin/`)
iron-session, viem, and all DB calls are mocked. Covers:
- `adminSession.test.ts` — `requireAdminSession()` all 4 auth states
- `nonce.test.ts` — nonce generation, session storage, stale auth cleared
- `verify.test.ts` — full gauntlet: 400/401/403/200, domain mismatch, nonce replay, expiry, bad
  signature, wrong owner. "Nonce always consumed" is the replay-attack regression test.
- `auth-guard.test.ts` — all 3 protected routes return 401 unauthenticated; 403 wrong owner

**Note on test addresses:** Any address passing through route input validation must satisfy
`0x` + exactly 40 chars from `[0-9a-fA-F]`. Use `"0x" + "0".repeat(38) + "XX"` as a template.

### Helper unit tests (`utils/helpers.test.ts`)
Pure unit tests for `toBytes32` and `toHexBytes`.

The revert test in `HomeClient` and the "nonce always consumed" test in `verify.test.ts` are the
two critical regression tests — both exist specifically to catch accidental removal of their
respective guards.

## V2 Architecture: Developer-Owned Contracts (Post-Grant)

The v1 architecture is a single-operator model. V2 evolves this to a permissionless
multi-publisher platform, making structural changes that the current contracts already support:

| Layer | V1 (Current) | V2 (Post-Grant) |
|---|---|---|
| `SoulKey.sol` ownership | Vault operator | Developer wallet |
| Fund recipients | MasterKeyVault → operator | MasterKeyVault → dev wallet |
| Admin auth | Vault owner only | Per-contract SIWE (dev signs in per game) |
| CD key import | Operator's admin panel | Dev's own panel (per-contract ownership check) |
| Registration | Operator registers games | Vault manager verifies dev and registers |
| Price / supply / CID | Operator controls | Dev controls |

**Key v2 additions to contracts:**
- `guardian` role on `SoulKey.sol` — held by Vault operator, can pause minting without touching
  developer ownership or funds. The guardian has no access to key inventory or payment records.
- Developer registration stake: ETH locked proportional to `maxSupply` in a `DevRegistry.sol` or
  extended `MasterKeyVault`. Claimable after successful claim rate exceeds threshold.
- Dispute window: buyers who encounter commitment hash mismatches can flag the contract; N flags
  trigger guardian pause and stake slashing.

**Anti-tamper guarantees already in v1 that v2 inherits:**
- `commitmentHash` is immutable on-chain — a developer cannot substitute a different key after
  mint. Post-mint key fraud is structurally impossible.
- Remaining risk is pre-mint inventory fraud (importing invalid keys before any mints). The
  staking mechanism + guardian pause + delayed key activation covers the practical attack surface.

**Encryption upgrade path to v2 hybrid:**
Because v1 retains the AES server copy post-claim, the migration to hybrid X25519 + ML-KEM-768
requires only one `personal_sign` per token from the user — the server re-encrypts invisibly using
the AES copy and presents the new ciphertext ready to submit.
