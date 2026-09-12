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
        └── cd_keys (reserved_by → cleared after mint; encrypted_key → DELETED after confirmed claim)
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

**`cd_keys.encrypted_key` — deleted after a CONFIRMED claim (12/09/26, supersedes retention)** —
`clearEncryptedKey` runs as the very last step of `/api/redeem/confirm`, only after
receipt.status === success AND getClaimTimestamp > 0 AND confirmRedemption committed. Any failure
returns earlier and KEEPS the row. There is no v1→v2 migration: X-Wing is the default claim
cipher from the first deploy that ships it, and the first public deploy is production. See
DECISIONS.md — *12/09/26 — Crypto v2 (X-Wing) & supply cap*.

## Encryption Architecture

The encrypted CD key is written **permanently on-chain** at claim time (`encryptedCdKey[tokenId]`).
The choice of encryption scheme has **lifetime consequences** for every claimed token — there is no
on-chain migration function, so a token stays on the scheme it was claimed with. New claims write
v2 (X-Wing); v1 blobs stay readable forever via client-side dual-read.

### v1 Scheme: X25519 (personal_sign + HKDF) — legacy, decrypt-only

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

Note: the former plan to extend this derivation to 96 bytes for v2 is **superseded** (12/09/26).
V2 uses a separate HKDF derivation with salt `"soulkey-xwing-v2"` and a 32-byte X-Wing seed — the
same `personal_sign`, a different salt, no shared expansion. V1 ciphertexts are unaffected.

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
accepts the v1 ciphertext (~60 bytes) and the v2 X-Wing ciphertext (~1.15 KB) with no changes.

### v2 Scheme: X-Wing (ML-KEM-768 + X25519) — shipped 12/09/26

New claims write X-Wing ciphertext (the ML-KEM-768 + X25519 hybrid) via `@noble/post-quantum`
**0.7.1, pinned exactly** — export `ml_kem768_x25519` (the descriptive name for X-Wing in
0.7.1+). No homemade hybrid construction; no HQC, no McEliece. Breaking a v2 blob requires
breaking both X25519 (hard classically) and ML-KEM-768 (no known classical or quantum attack)
simultaneously.

**Key derivation (client)** — the same single `personal_sign` as v1, different HKDF salt:
```
HKDF-SHA256(IKM = sigBytes[0..65], salt = "soulkey-xwing-v2", length = 32)
  → 32-byte X-Wing seed → ml_kem768_x25519.keygen(seed)
     (pk: 1,216 bytes | sk: the seed itself — the KEM re-expands internally)
```
The superseded April plan (length = 96 from the v1 salt) is dead: X-Wing expands its own seed,
and the distinct salt domain-separates the two schemes from the one signature.

**Encryption (server, `/api/redeem`):**
```
{cipherText, sharedSecret} = ml_kem768_x25519.encapsulate(userXWingPk)
aesCt = AES-256-GCM(key = sharedSecret(32B), nonce(12B), plaintextCdKey)

on-chain bytes: [version 0x02][xwingCt(1120)][nonce(12)][tag(16)][aesCt]  ≈ 1.15 KB
```
The shared secret IS the AES key — X-Wing's SHA3-256 combiner already KDFs both component
secrets, so no extra HKDF runs here.

**Decryption (client, reveal):** `utils/xwing.ts` dual-reads: v2 (0x02-prefixed) →
`ml_kem768_x25519.decapsulate` + WebCrypto AES-GCM; v1 (unprefixed) → the legacy X25519 path.
Version detection is length-based (v2 is always ≥ 1,150 bytes) because a v1 blob's random
ephemeral public key can start with any byte, including 0x02. No writer ever emits an explicit
0x01 prefix.

**No migration:** confirmed claims delete the Neon AES copy (see Database Architecture) and no
`updateEncryptionKey` exists, so every token stays on the scheme it was claimed with. Sepolia
v1 tokens remain revealable forever through the client-side dual-read.

### Future: EIP-5630

When wallets ship `eth_performECDH` (EIP-5630, Draft as of April 2026), the `personal_sign` +
HKDF derivation step can be replaced with a single `eth_performECDH` call. The encryption logic,
`/api/redeem`, and `encryptedCdKey` storage are all unchanged. No contract redeployment required.
Low priority until at least two major wallets ship it.

### ZK Proofs — Not Applicable Now

Zero-knowledge proofs were evaluated as a potential enhancement. The primary candidate was a ZK
claim proof: replacing the full on-chain ciphertext with a short ZK proof (~256 bytes vs ~1,168
bytes in v2), reducing `claimCdKey` gas significantly.

This is blocked by the ML-KEM-768 component (shipped 12/09/26 inside the X-Wing v2 cipher). ZK circuits operate over large prime
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
POST /api/redeem  { xwingPublicKey, x25519PublicKey (legacy), tokenId, userAddress, contractAddress }
  → Verify NFT ownership (on-chain ownerOf call)
  → AES-256 decrypt CD key server-side ("v2gcm:" GCM rows + legacy CBC rows)
  → X-Wing encapsulate to the user's 1,216-byte pk → shared secret → AES-256-GCM:
      returns ~1.15 KB v2 ciphertext (0x02-prefixed)
      (legacy cached clients sending only x25519PublicKey still get the ~60 B v1 blob)
  → INSERT partial redemption row (wallet_encrypted_cdkey only)
  → Return ciphertext to frontend

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
  Step 6: clearEncryptedKey() — deletes the cd_keys AES copy. LAST step: only
          reached when steps 1–3 all succeeded; every failure path returns
          earlier and keeps the row for retry/resume. Idempotent.
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
  Note: only UNCLAIMED refund burns free an on-chain mint slot (commitmentInUse
  cleared); claimed burns never do. See OPEN_ISSUES for the claimed-then-refunded
  availability edge.
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

- `app/page.tsx` + `HomeClient.tsx` — game selector (hero section) + user library.
  `handleClaimCDKey` / `handleRevealCDKey` run `deriveClaimKeys`: ONE `personal_sign` → HKDF
  (full 65-byte IKM) → BOTH keypairs — v1 X25519 (salt `soulkey-hybrid-v1`, legacy reveals) and
  the v2 X-Wing seed/pk (salt `soulkey-xwing-v2`, new claims). Cached in `useRef`, cleared on
  wallet disconnect or address change. Reveal goes through `decryptClaimCiphertextWebCrypto`
  (dual-read v1/v2, WebCrypto AES-GCM).
- `app/admin/page.tsx` + `AdminClient.tsx` — SIWE sign-in gate, register game, import keys
  (single/batch), deregister game
- `components/Providers.tsx` — WagmiProvider + QueryClientProvider + RainbowKitProvider
- `utils/abis.ts` — single source of truth for SoulKey and MasterKeyVault ABIs
- `utils/adminSession.ts` — iron-session config + `requireAdminSession()` guard
- `utils/crypto.ts` — server-side: `encrypt()`/`decrypt()` for cd_keys at-rest (AES-256-GCM
  `v2gcm:` writes + legacy CBC dual-read), `encryptWithXWing()` (v2 claim write path),
  `encryptWithX25519()`/`decryptWithX25519()` (legacy v1)
- `utils/x25519.ts` — browser-side v1: HKDF derive from personal_sign, WebCrypto decrypt
- `utils/xwing.ts` — browser + Node v2: X-Wing seed derivation, keygen/encapsulate/decapsulate
  wrappers, WebCrypto reveal decrypt, length-based version detection, dual-read dispatcher
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
should return a deterministic 65-byte hex string (e.g. `"0x" + "ab".repeat(64) + "01"` —
`"ab".repeat(32)` is only 33 bytes and HKDF rejects it) so both derivations produce consistent
keypairs across test runs.

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

### Refresh-resume tests (`HomeClient.resume.test.tsx`)
PendingTx record lifecycle (saved at txHash, cleared on server success, kept on confirm
failure), resume per kind from the tx receipt, wallet-mismatch skip, reverted-resume clear,
timeout keeps the record.

### Crypto unit tests (`utils/crypto.test.ts`, `utils/xwing.test.ts`)
At-rest AES-256-GCM: `v2gcm:` wire shape, roundtrip, fresh IV per call, ct/tag/IV nibble
tamper each throw, malformed wire throws, legacy CBC fixture decrypts.
X-Wing: seed determinism + salt domain separation + 65-byte IKM guard, exact v2 blob layout
(`0x02 || ct(1120) || nonce(12) || tag(16) || aesCt`), server→client WebCrypto roundtrip,
AES-GCM and X-Wing nibble tamper rejection, v1 dual-read, length-based version disambiguation.

Suite total: 81 tests / 9 files.

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

**Encryption:** the post-grant "hybrid migration" is superseded (12/09/26): X-Wing
(ML-KEM-768 + X25519) shipped as the default claim cipher. No v1→v2 migration exists —
confirmed claims delete the Neon AES copy, and every token stays on the scheme it was claimed
with (client-side dual-read keeps Sepolia v1 blobs revealable). See *Encryption Architecture*.
