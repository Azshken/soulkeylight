# SoulKey — Open Issues & Task List

Update at the end of every Claude Code session.
🔴 High (security/data-loss) | 🟡 Med (logic/reliability) | 🟢 Low (polish/UX) | 🔵 Future

---

## 🔴 High Priority

### Replace eth_getEncryptionPublicKey / eth_decrypt — mainnet blocker
**Risk:** Both MetaMask methods are deprecated (since June 2022) and can be removed in any browser
extension update. Because the encrypted CD key is written **permanently on-chain** after
`claimCdKey`, any user who claimed a token before a fix is applied would permanently lose access to
their CD key the moment MetaMask removes the method. There is no recovery path without the
server-side AES copy.

**Plan (v1):** Replace with `personal_sign` → HKDF-SHA256 → X25519 scheme. All crypto runs in the
browser via `@noble/curves`. No wallet-specific APIs required — works on MetaMask, Rabby, Rainbow,
Brave Wallet, Ledger bridges, and any wallet supporting `personal_sign`.

**Plan (v2, post-grant):** Upgrade to hybrid X25519 + ML-KEM-768 (NIST FIPS 203) for quantum
resistance. The HKDF derivation is forward-compatible: v1 requests 32 bytes; v2 requests 96 bytes
from the same derivation root. V1 ciphertexts remain decryptable after v2 is deployed. Because the
AES copy is retained post-claim in v1, the server can re-encrypt each key for v2 without user
burden — one `personal_sign` per token to submit the migrated ciphertext on-chain.

**Scope (v1):** Frontend + API only. Zero contract changes required — `encryptedCdKey[tokenId]` is
already typed `bytes` (variable length) in SoulKey.sol.

**New dependency:** `pnpm add @noble/curves`

**Implementation notes:**
- Use all 65 signature bytes as HKDF IKM (`getBytes(sig)`, not `.slice(0, 32)`). Truncating
  silently halves entropy and changes the derived keypair — existing ciphertexts become unreadable.
  See GOTCHAS.md.
- HKDF call: `hkdf(sha256, getBytes(sig), "soulkey-hybrid-v1", "", 32)` — note length=32 for v1
  (X25519 only). The salt `"soulkey-hybrid-v1"` is shared with v2 for forward compatibility.
- Cache the derived keypair in a `useRef` in `HomeClient.tsx`, cleared on wallet disconnect or
  address change. Claim + immediate reveal = one `personal_sign` prompt per session.

**Files to change:**
- `nextjs/app/HomeClient.tsx` — replace `eth_getEncryptionPublicKey` (claim) and `eth_decrypt`
  (reveal) with `personal_sign` + X25519 derive/decrypt; add `x25519KeypairRef` cache in `useRef`
- `nextjs/utils/crypto.ts` — replace `encryptWithPublicKey()` with `encryptWithX25519()`; add
  `decryptWithX25519()`; server AES path (`encrypt()`/`decrypt()`) is unchanged
- `nextjs/app/api/redeem/route.ts` — accept `x25519PublicKey` instead of `userPublicKey`

**Files to remove from confirm flow:**
- `nextjs/app/api/redeem/confirm/route.ts` — remove the `clearEncryptedKey()` call (step 6).
  The AES copy is retained in v1 as the v2 migration enabler. See DECISIONS.md —
  *AES copy retained post-claim as v2 migration enabler*.

**Tests to update:**
- `HomeClient.claimCdKey.test.tsx` — `window.ethereum` mock changes from
  `eth_getEncryptionPublicKey` to `personal_sign`; mock should return a deterministic 65-byte hex
  string (e.g. `"0x" + "ab".repeat(32) + "01"`) so HKDF produces a consistent keypair across runs

---

## 🟡 Medium Priority

### Dynamic NFT metadata endpoint — not fully implemented
**Status:** Frozen CID redirect works. Dynamic JSON for unclaimed state is incomplete.
**Todo:** Return complete ERC-721 metadata JSON for unclaimed tokens (name, description, image_cid,
attributes from products table).
**File:** `nextjs/app/api/nft/[contractAddress]/[tokenId]/route.ts`

### Chain sync — DB can go out of sync with on-chain state
**Risk:** If a user interacts with SoulKey directly (not via frontend), the DB won't know. E.g. a
direct burn, a transfer (pre-claim), or a direct `claimCdKey` call bypassing `/api/redeem`.
**Fix:** Set up Alchemy Notify webhooks for `Transfer`, `CdKeyClaimed`, and `NFTBurned` events to
keep DB in sync. This is Milestone 3 in the ESP grant.
**File:** New `nextjs/app/api/webhooks/alchemy/route.ts`

### Deregistered game mint guard
**Risk:** `is_active = false` hides a game from the mint UI but `/api/mint/get-commitment` may
still issue keys if the route is called directly with the deregistered contract's address.
**Fix:** Add `AND is_active = true` check in `get-commitment` route before reserving a key.
**File:** `nextjs/app/api/mint/get-commitment/route.ts`

### Refund edge cases
- Refunded keys: verify the re-issued key flow end-to-end (new user can mint and claim a previously
  refunded key)
- What if `processRefund` on-chain succeeds but `/api/refund` POST fails? Key won't be marked as
  available in DB. No recovery path without manual DB intervention.
- ETH vs stablecoin refund — if ETH price changed between mint and refund, the ETH value returned
  may differ from what was paid in stablecoin terms. Known limitation, not a bug.

### import-keys — verify both paths use the same constraint
Single key and batch import should both go through the same DB upsert with the UNIQUE constraint on
`commitment_hash`. Verify neither path bypasses it.
**File:** `nextjs/app/api/admin/import-keys/route.ts`

### ENCRYPTION_KEY rotation migration script
A script that re-encrypts all `cd_keys.encrypted_key` records when rotating the AES key has not
been written or documented. Essential before mainnet — if the key is leaked, there is no path to
rotate without this.
**Note:** Rotation is distinct from the v2 encryption upgrade. This script addresses AES key
compromise; v2 addresses the on-chain scheme upgrade.

---

## 🟢 Low Priority / Polish

### Error messages for empty key pool
When no keys are available (pool exhausted or all reserved), return a clear user-facing message
rather than a generic server error.

### Pending tx loading states
All wallet interactions should show a clear pending state while the tx mines, not only while
waiting for the user to sign.

### Library — deregistered game visual indicator
Deregistered games appear correctly in a user's library. Add a subtle UI indicator that the game
is no longer active on the storefront (e.g. greyed out name, "Delisted" badge).

### image_claimed_cid has no admin UI
Currently set via direct SQL in Neon console. Should be an optional field in the admin
register/re-register form.
**Files:** `nextjs/app/admin/AdminClient.tsx`, `nextjs/app/api/admin/register-game/route.ts`

---

## 🔵 Future Features (v2, Post-Grant)

### Developer-owned contracts
Transfer `SoulKey.sol` ownership to the developer who deployed it. Developers control price,
supply, NFT metadata CID, and key inventory, and receive funds directly from `MasterKeyVault`.
The Vault operator verifies and (de)registers developer contracts without holding any
game-specific authority. Requires Milestone 3 generalisation refactor as foundation.

### Guardian role on SoulKey.sol
A narrow `guardian` role (held by Vault operator) that can pause minting without touching the
developer's ownership or funds. Circuit breaker for clearly malicious developers.

### Developer reputation and staking system
Developers lock ETH proportional to `maxSupply` to register. Claim-rate tracking. Dispute window
for buyers who encounter commitment hash mismatches (post-mint key fraud is already structurally
blocked; staking addresses pre-mint inventory fraud). Verified publisher tier for established
developers that bypasses the stake requirement.

### Delayed key activation (new developers)
Imported keys enter `pending` state for 24h before becoming mintable, for developers without an
established track record. Gives the Vault operator a review window without blocking activation.

### Hybrid encryption upgrade (v2)
After mainnet deployment and audit, upgrade the on-chain encryption from X25519 to hybrid
X25519 + ML-KEM-768 (NIST FIPS 203). The HKDF derivation is forward-compatible with v1. The
server re-encrypts each key using the retained AES copy; the user submits one `personal_sign` per
token to commit the migrated ciphertext on-chain. AES copy is deleted after each token's
successful v2 migration.

### Smart contract wallet (SCW) support for admin auth
The Solidity contracts already work with SCWs (all ownership checks are address-only). V2 adds
ERC-1271 + ERC-6492 signature verification to the `/api/admin/verify` SIWE route, enabling Safe,
Coinbase Smart Wallet, and ERC-4337 accounts as vault or game contract operators. EOA holders
migrating to an SCA via EIP-7702 (live since Pectra) need no special handling — the address is
unchanged and all soulbound tokens remain valid.

### EIP-5630 monitoring
EIP-5630 (`eth_performECDH`) is the standards-track replacement for `eth_getEncryptionPublicKey`.
Currently Draft with no major wallet shipping it (April 2026). If wallets adopt it, the
`personal_sign` + HKDF derivation can be replaced with `eth_performECDH` — the encryption logic,
API routes, and on-chain storage are unchanged. No contract redeployment required. Low priority
until at least two major wallets ship it.

### ZK claim proof (gas reduction)
ZK proofs for on-chain ciphertext reduction were evaluated and deferred. Blocked by the planned v2
ML-KEM-768 component: ZK circuits operate over prime fields (BN254, BLS12-381) and ML-KEM's
polynomial arithmetic over `q = 3329` does not map to these without expensive emulation. Revisit
when ZK-friendly post-quantum primitives exist in production. See DECISIONS.md — *ZK proofs:
deferred*.

### Chainlink price feed
For ETH/USD parity pricing on mainnet. Left out because it complicates testnet development. Listed
as Milestone 4 in the ESP grant (Chainlink Automation for reserve expiry — separate from price
feeds, which remain future work).

### AgentKit / AI wallet integration
Explored using Coinbase AgentKit to automate the mint → claim → reveal flow via session keys
(ERC-4337). Not started. Relevant when targeting a non-crypto-native audience.

---

## Mainnet Checklist

- [x] Key deletion atomicity fixed
- [x] Pinata failure handling fixed (non-fatal, correct column names)
- [x] SIWE admin auth implemented (iron-session + viem/siwe, 35 tests)
- [x] Vitest test suite — 6 test files, 35+ tests
- [ ] **Replace eth_getEncryptionPublicKey / eth_decrypt with personal_sign + X25519 (v1)**
- [ ] **Remove clearEncryptedKey from confirm flow (AES copy retained for v2)**
- [ ] Deregistered game mint guard in get-commitment route
- [ ] Dynamic NFT metadata endpoint (unclaimed JSON)
- [ ] Chain sync event listener (Milestone 3)
- [ ] ENCRYPTION_KEY rotation script written and documented
- [ ] Cyfrin CodeHawks competitive audit — SoulKey.sol + MasterKeyVault.sol (Milestone 2)
- [ ] Gas optimisation pass

---

## Recently Resolved

- ✅ Encryption architecture decision finalised — v1 uses X25519 (personal_sign + HKDF);
  v2 upgrades to hybrid X25519 + ML-KEM-768 post-audit; AES copy retained post-claim as migration
  enabler; clearEncryptedKey removed from v1 confirm flow (28/04/26)
- ✅ ESP grant application finalised — CodeHawks audit as Milestone 2; v1/v2 roadmap documented;
  $18,000 total (28/04/26)
- ✅ Admin auth upgraded to SIWE (EIP-4361) — `viem/siwe` + `iron-session`; one sign-in per
  session replaces per-action `signMessageAsync` calls (02/04/26)
- ✅ Admin auth test suite — 35 tests across 4 files (02/04/26)
- ✅ Key deletion atomicity — confirm/route.ts verifies tx on-chain before acting;
  `confirmRedemption` guards against 0-row updates (01/04/26)
- ✅ Pinata upload failure during claim — upload is non-fatal; `frozen_metadata_cid` column added;
  falls back to `image_cid` when `image_claimed_cid` is null (01/04/26)
- ✅ SQL column name bugs in confirm/route.ts — all corrected to exact snake_case (01/04/26)
- ✅ Vitest test suite added — helpers, handleClaimCDKey integration, admin auth (01/04/26)
- ✅ `toBytes32` / `toHexBytes` extracted to `utils/helpers.ts` (01/04/26)
- ✅ Duplicate CD key entries — UNIQUE constraint on commitment_hash (27/03/26)
- ✅ Phantom duplicate batch/key counting on import (27/03/26)
- ✅ Auto key-generation → manual import-keys (27/03/26)
- ✅ Refunded keys not returning to available pool — db.ts checks refunds table (19/03/26)
- ✅ Token status: RPC → DB lookup (19/03/26)
- ✅ Scaffold-ETH 2 fully removed, pure foundry + Next.js (25/03/26)
- ✅ indexedDB / wagmi SSR error fixed (24/03/26)
- ✅ yarn install error on Vercel fixed (24/03/26)
- ✅ Global UNIQUE on mints.token_id dropped — multi-game silent rollback fixed
- ✅ Lowercase contract address from DB causing silent wagmi read failures — getAddress() fix
- ✅ BigInt + number arithmetic crash in frontend refund window calculation
- ✅ Admin UI authentication issue fixed (10/03/26)
- ✅ NEXT_PUBLIC_ used for secrets — removed (21/02/26)
