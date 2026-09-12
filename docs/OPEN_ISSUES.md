# SoulKey — Open Issues & Task List

Update at the end of every Claude Code session.
🔴 High (security/data-loss) | 🟡 Med (logic/reliability) | 🟢 Low (polish/UX) | 🔵 Future

---

## 🔴 High Priority

(none — the `eth_getEncryptionPublicKey` / `eth_decrypt` mainnet blocker is resolved: v1 X25519
shipped, and v2 X-Wing (ML-KEM-768 + X25519) became the default claim cipher on 12/09/26.
See Recently Resolved.)

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

### Claimed-then-refunded rows look available in DB (pre-existing edge)
The availability filter (`refunded_at >= minted_at`) in `reserveCDKeyForWallet` /
`reserveAndMint` / `getAvailableKeyCount` also matches keys refunded AFTER a confirmed claim.
Such rows are unusable: on-chain `commitmentInUse` stays set for claimed burns (the 12/09/26
mint-cap fix made this explicit), so a fresh mint with that commitment reverts
`CommitmentAlreadyUsed`; and their `encrypted_key` is NULL anyway (deleted at confirm).
get-commitment can hand out such a poisoned reservation, burning user gas on a reverting mint.
**Fix:** exclude post-claim refunds from the availability queries (e.g. require
`encrypted_key IS NOT NULL`, or drop rows with a confirmed redemption).
**File:** `nextjs/utils/db.ts`

### import-keys — verify both paths use the same constraint
Single key and batch import should both go through the same DB upsert with the UNIQUE constraint on
`commitment_hash`. Verify neither path bypasses it.
**File:** `nextjs/app/api/admin/import-keys/route.ts`

### ENCRYPTION_KEY rotation migration script
A script that re-encrypts all `cd_keys.encrypted_key` records when rotating the AES key has not
been written or documented. Essential before mainnet — if the key is leaked, there is no path to
rotate without this.
**Note:** Rotation is distinct from the on-chain claim scheme (X-Wing v2 shipped 12/09/26).
This script addresses AES key compromise only. At-rest rows are now AES-256-GCM (`v2gcm:`
prefix) with legacy CBC rows — a rotation script must decrypt BOTH formats and rewrite GCM.
Rows of confirmed claims are already NULL (deleted at confirm) — nothing to rotate there.

### Local dev environment — REPAIRED 12/09/26 (lint still red: pre-existing style errors)
**Status:** Fixed during the crypto-and-supply work. The committed `nextjs/pnpm-lock.yaml` was
stale relative to `package.json` (predated the X25519 switch), and the prior root-workspace
store had been pruned, leaving dangling symlinks. Lockfile regenerated + reinstalled inside
`nextjs/` (pnpm 11.7.0), committed as a chore.
- `pnpm test` — green (81/81, 9 files). `pnpm build` — green again (the `@x402/*` failure was
  the broken tree, not a real dep issue). `tsc --noEmit` — clean.
- `pnpm lint` — runs now, but fails with ~78 pre-existing style errors
  (`@typescript-eslint/no-explicit-any`, `react-hooks/set-state-in-effect`) across files
  untouched by recent work. Separate cleanup chore; not a blocker.
- Sandboxed-agent recipe (home pnpm store is read-only there):
  `CI=true pnpm install --no-frozen-lockfile --store-dir ../.pnpm-store --cache-dir ../.pnpm-cache`
  — delete the store dirs afterwards; node_modules keeps working (hardlinked inodes).
- pnpm 11 drops a `nextjs/pnpm-workspace.yaml` "allowBuilds" stub after install — delete it
  (junk). Native build scripts stay unapproved (bufferutil, esbuild, keccak, sharp,
  unrs-resolver, utf-8-validate); tests and build work without them.

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

### Stale references in docs/skills/*
- `SKILL_FRONTEND.md` still documents the pre-v1 MetaMask encryption scheme
  (`eth_getEncryptionPublicKey` / `eth_decrypt`, `CDKeyEncryption.tsx` — component deleted
  31/03/26); v1 is personal_sign + HKDF + X25519 (`utils/x25519.ts`). Rewrite deliberately
  deferred — out of scope for the refresh-resume work (12/09/26).
- `SKILL_API_DB.md` points at `skills/references/GOTCHAS.md`, which never existed; bug history
  now lives in `docs/GOTCHAS.md` (stub) and the skills' own gotcha sections.
- The skill docs' crypto sections are further outdated since X-Wing shipped (12/09/26) —
  still deferred to a deliberate rewrite.

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
ZK proofs for on-chain ciphertext reduction were evaluated and deferred. Blocked by the
ML-KEM-768 component (shipped 12/09/26 inside the X-Wing v2 cipher): ZK circuits operate over prime fields (BN254, BLS12-381) and ML-KEM's
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
- [x] Vitest test suite — 9 test files, 81 tests
- [x] Replace eth_getEncryptionPublicKey / eth_decrypt — v1 X25519 shipped; v2 X-Wing is the
      default claim cipher (12/09/26)
- [x] ~~Remove clearEncryptedKey from confirm flow~~ REVERSED 12/09/26 — clearEncryptedKey
      restored; confirmed claims delete the AES copy, failed claims keep it
- [ ] Redeploy game contracts for the mint-cap fix — Sepolia bytecode is immutable; the
      lifetime-mints-minus-refund-burns gate only applies to NEW deployments
- [ ] Verify claim gas on Sepolia with the ~1.15 KB X-Wing blob (~800k gas expected per claim)
- [ ] Deregistered game mint guard in get-commitment route
- [ ] Dynamic NFT metadata endpoint (unclaimed JSON)
- [ ] Chain sync event listener (Milestone 3)
- [ ] ENCRYPTION_KEY rotation script written and documented
- [ ] Cyfrin CodeHawks competitive audit — SoulKey.sol + MasterKeyVault.sol (Milestone 2)
- [ ] Gas optimisation pass

---

## Recently Resolved

- ✅ X-Wing v2 claim cipher shipped — ML-KEM-768 + X25519 via `@noble/post-quantum` 0.7.1
  (pinned); on-chain blob `0x02 || xwingCt(1120) || nonce(12) || tag(16) || aesCt` (~1.15 KB);
  seed = HKDF-SHA256(full 65-byte personal_sign, salt "soulkey-xwing-v2", 32 B); reveal
  dual-reads v1; supersedes the April HKDF-96 hybrid plan (12/09/26)
- ✅ Confirmed claims delete `cd_keys.encrypted_key` — `clearEncryptedKey` restored as the last
  `/api/redeem/confirm` step (receipt success + claimTimestamp>0 + confirmRedemption); failed
  claims keep the row; no v1→v2 migration, first public deploy is production (12/09/26)
- ✅ AES-256-GCM at rest for `cd_keys.encrypted_key` — `v2gcm:iv:ct:tag` writes, legacy
  `ivHex:ctHex` CBC rows still decrypt, tamper throws (12/09/26)
- ✅ Mint-cap accounting fixed — gate = lifetime mints minus unclaimed refund burns
  (`_refundBurnedCount`); claimed burns no longer free slots; `setMaxSupply` uses the same
  figure; Foundry tests added (forge not run locally) (12/09/26)
- ✅ Local dev environment repaired — lockfile regenerated, node_modules rebuilt; test + build
  green, lint runs with pre-existing style errors (12/09/26)
- ✅ In-flight mint/claim/refund survive a page refresh — sessionStorage pending-tx record
  (`utils/pendingTx.ts`) + resume-on-load effect in HomeClient completes the missing DB write
  from the tx receipt; `/api/refund` made idempotent on refund_tx_hash; reverted refunds are no
  longer recorded in the DB (was: 0-amount refund row hid a live token) (12/09/26)
- ✅ Claim-flow test baseline fixed — personal_sign mock is a real 65-byte signature (was 33
  bytes; 4 tests failing); new `HomeClient.resume.test.tsx` covers the resume lifecycle;
  suite is 63 tests / 7 files (12/09/26)
- ✅ Encryption architecture decision finalised — v1 uses X25519 (personal_sign + HKDF);
  v2 upgrades to hybrid X25519 + ML-KEM-768 post-audit; AES copy retained post-claim as migration
  enabler; clearEncryptedKey removed from v1 confirm flow (28/04/26)
  *(superseded 12/09/26: X-Wing shipped pre-grant; AES copy deleted post-confirm)*
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
