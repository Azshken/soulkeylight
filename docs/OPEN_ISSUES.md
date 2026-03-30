# SoulKey — Open Issues & Task List

Update at the end of every Claude Code session.
🔴 High (security/data-loss) | 🟡 Med (logic/reliability) | 🟢 Low (polish/UX) | 🔵 Future

---

## 🔴 High Priority

### Key deletion atomicity
**Risk:** In `redeem/confirm/route.ts`, the AES-encrypted key is deleted from `cd_keys` after the on-chain `claimCdKey` tx is submitted. If the tx fails or times out after deletion, the user holds an NFT but can never retrieve their key — it's gone from both DB and chain.
**Fix:** Only delete after confirmed tx receipt with sufficient block depth. Or: use a `pending_deletion` flag on `cd_keys` that a background job clears once the on-chain tx is confirmed.
**File:** `nextjs/app/api/redeem/confirm/route.ts`

### Pinata upload failure during claim
**Risk:** If Pinata upload fails after claim but before `frozen_metadata_cid` is saved to DB, the NFT metadata may be broken permanently (no frozen CID, key already deleted).
**Fix:** Pin metadata to Pinata first, get CID, then complete the DB write. Treat CID as a prerequisite.
**File:** `nextjs/app/api/redeem/confirm/route.ts`

### Admin auth — upgrade to SIWE before mainnet
**Current:** Signed message + on-chain ownership check (timestamp-gated, 5 min expiry).
**Risk:** Current approach is reasonable for testnet but not production-grade. SIWE (Sign-In with Ethereum) adds session management and replay protection.
**File:** `nextjs/app/api/admin/*/route.ts`

---

## 🟡 Medium Priority

### Dynamic NFT metadata endpoint — not fully implemented
**Status:** Frozen CID redirect works. Dynamic JSON for unclaimed state is incomplete.
**Todo:** Return complete ERC-721 metadata JSON for unclaimed tokens (name, description, image_cid, attributes from products table).
**File:** `nextjs/app/api/nft/[contractAddress]/[tokenId]/route.ts`

### Chain sync — DB can go out of sync with on-chain state
**Risk:** If a user interacts with SoulKey directly (not via frontend), the DB won't know. E.g. a direct burn, a transfer (pre-claim), a direct claim call.
**Fix:** Set up Alchemy Notify webhooks for `Transfer`, `CdKeyClaimed`, and `NFTBurned` events to keep DB in sync.

### Deregistered game mint guard
**Risk:** `is_active = false` hides a game from the mint UI but `/api/mint/get-commitment` may still issue keys if called directly with the deregistered contract's address.
**Fix:** Add `is_active` check in `get-commitment` route before reserving a key.
**File:** `nextjs/app/api/mint/get-commitment/route.ts`

### Refund edge cases
- Refunded keys: verify the re-issued key flow end-to-end (new user can mint and claim a previously refunded key)
- What if `processRefund` on-chain succeeds but `/api/refund` POST fails? Key won't be marked as available.
- ETH vs stablecoin refund — if ETH price changed between mint and refund, value differs

### import-keys — verify both paths use the same constraint
Single key and batch import should both go through the same DB upsert with the UNIQUE constraint on `commitment_hash`. Verify neither path bypasses it.
**File:** `nextjs/app/api/admin/import-keys/route.ts`

---

## 🟢 Low Priority / Polish

### Error messages for empty key pool
When no keys are available (pool exhausted or all reserved), return a clear user-facing message instead of a generic error.

### Pending tx loading states
All wallet interactions should show a pending state while the tx mines, not just while waiting for the user to sign.

### Library — deregistered game visual indicator
Deregistered games appear in a user's library (correct). Add a subtle UI indicator that the game is no longer active (e.g. greyed out, "Deregistered" badge).

---

## 🔵 Future Features

### Chainlink price feed
For ETH/USD parity pricing on mainnet. Left out because it complicates testnet development.

### API route integration tests
Foundry covers contracts. No automated tests for Next.js API routes. Consider Vitest + a separate Neon DB branch for the mint, claim, and refund flows.

### ENCRYPTION_KEY rotation migration script
Write and document a script that re-encrypts all `cd_keys` records when rotating the AES key. Essential before mainnet.

### Event listener / webhook for chain sync
Alchemy Notify or similar to keep DB in sync with direct contract interactions.

### Mainnet checklist
- [ ] Key deletion atomicity fixed
- [ ] Pinata failure handling fixed
- [ ] SIWE admin auth
- [ ] Chain sync event listener
- [ ] ENCRYPTION_KEY rotation script written and documented
- [ ] Chainlink price feed integrated
- [ ] Full contract audit (SoulKey.sol + MasterKeyVault.sol)
- [ ] Gas optimisation pass

---

## Recently Resolved

- ✅ Duplicate CD key entries — UNIQUE constraint on commitment_hash (27/03/26)
- ✅ Phantom duplicate batch/key counting on import (27/03/26)
- ✅ Auto key-generation → manual import-keys (27/03/26)
- ✅ Refunded keys not returning to available pool — db.ts checks refunds table (19/03/26)
- ✅ Token status: RPC → DB lookup, 200-500ms faster (19/03/26)
- ✅ Scaffold-ETH 2 fully removed, pure foundry + Next.js (25/03/26)
- ✅ indexedDB / wagmi SSR error fixed (24/03/26)
- ✅ yarn install error on Vercel fixed (24/03/26)
- ✅ Global UNIQUE on mints.token_id dropped — multi-game silent rollback fixed
- ✅ Lowercase contract address from DB causing silent wagmi read failures — getAddress() fix
- ✅ BigInt + number arithmetic crash in frontend refund window calculation
- ✅ Admin UI authentication issue fixed (10/03/26)
- ✅ NEXT_PUBLIC_ used for secrets — removed (21/02/26)
