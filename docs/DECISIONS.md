# SoulKey — Decisions Log

Why things were built the way they were. Useful when revisiting old code or starting a new Claude
Code session on a tricky problem.

---

## Smart Contract

### One SoulKey contract per game (not a registry)
Deploy a fresh SoulKey.sol for each game. MasterKeyVault is deployed once and shared.
**Why:** Isolates game economies. A bug in one game doesn't affect others. Deregistering a game is
a DB flag, not a contract change. Each game has its own token ID space starting from 1. Also a
prerequisite for v2 developer ownership — each contract has an independent owner, so v2 only
requires transferring ownership to the developer, not redesigning the registry.

### SoulKey holds no funds
All ETH/USDT/USDC is forwarded to MasterKeyVault via `vault.collectPayment` at mint time.
**Why:** Cleaner separation of concerns. All financial logic lives in one auditable place. SoulKey
is purely an NFT contract. Also means `recoverERC20` on SoulKey is safe with no reserve check.

### Exact ETH amount required at mint (no excess refund)
`mintWithETH` reverts if `msg.value != mintPriceETH` — no refund path for excess.
**Why:** Eliminates the smart-contract-receiver griefing vector where a malicious contract could
block the excess refund call and grief the mint. Frontend reads `mintPriceETH` and constructs the
exact tx.

### claimTimestamp instead of a bool for soulbound tracking
`claimTimestamp[tokenId]` stores the block timestamp at claim (0 = unclaimed).
**Why:** Gives you the claim time for free with no extra storage. Useful for the 14-day refund
window and metadata. A bool would require a separate timestamp mapping.

### burnByVault separate from user burn
`burnByVault` is restricted to the vault (`onlyVault`). User `burn` only works on claimed tokens.
**Why:** Unclaimed tokens must go through `processRefund` so the vault settles the payment. If a
user could directly burn an unclaimed token, their funds would be locked in the vault reserve
forever.

### Commitment hash pattern (not key-on-mint)
User mints with `commitmentHash = keccak256(encryptedKey)`, not the key itself.
**Why:** Separates "I own this key" (mint) from "I want my key" (claim). Keeps the encrypted key
off-chain until the user actively claims. The hash being immutable on-chain is also the primary
anti-tamper anchor for the v2 permissionless model — a developer cannot retroactively swap a key
after a buyer has minted. Post-mint key fraud is structurally impossible at the contract level.

### No merkle tree for front-running protection
Removed the merkle tree safeguard.
**Why:** Front-running doesn't work here. If an attacker copies a `commitmentHash` from the
mempool, they still have to pay for the NFT — and they'd get an NFT they can never redeem because
they don't have the matching encrypted key. They gain nothing but a paid-for worthless NFT.

### Ownable2Step on both contracts
**Why:** Prevents accidental ownership loss from a typo'd transfer address. The new owner must
explicitly accept before ownership transfers. Also important for v2 — when game contract ownership
transfers to a developer, the two-step requirement prevents accidental misdirection to the wrong
developer address.

### 5% refund fee as anti-griefing
**Why:** Without a fee, someone could mint your entire supply then refund before expiry, blocking
all legitimate buyers. A 5% cost makes this economically irrational. `releaseReserveOnExpiry` is
permissionless so the reserve unlocks even if the owner is unresponsive.

### No updateEncryptionKey on SoulKey.sol
Considered adding `updateEncryptionKey(uint256 tokenId, bytes calldata newEncryptedKey)` as an
escape hatch for future encryption scheme migration. Decided against it.
**Why not:**
1. **Multi-contract overhead** — at scale (100+ deployed game contracts), adding a function
   requires redeploying every contract. Already-deployed contracts are immutable and cannot be
   patched retroactively.
2. **User cooperation is required** — without the AES server copy, there is no admin re-encryption
   path. Every single user must individually sign a transaction; most won't.
3. **Split state** — the result is a permanently mixed pool of tokens on the old scheme and tokens
   on the new scheme, with no way to force completion.
4. **Redundant for soulbound tokens** — the VGC is soulbound to address A, so only address A can
   call the function. But if address A's private key is accessible, `personal_sign` + HKDF already
   re-derives the same keypair and decrypts. The function only helps if you want to decrypt with a
   *different* address — which the soulbound constraint prevents.
5. **AES retention makes it unnecessary** — the v1 decision to retain the AES copy server-side
   means v2 hybrid migration requires only one `personal_sign` from the user, with the server
   handling re-encryption invisibly. An on-chain migration function adds complexity without benefit
   given this architecture.

**Conclusion:** No contract changes for encryption migration. The AES retention + single `personal_sign`
path is the correct approach for scheme upgrades.

---

## Encryption

### v1 scheme: X25519 (personal_sign + HKDF), not hybrid immediately
The deprecated `eth_getEncryptionPublicKey` / `eth_decrypt` methods are replaced in v1 with
`personal_sign` → HKDF-SHA256 → X25519 only. The hybrid X25519 + ML-KEM-768 upgrade is deferred
to v2.

**Why X25519-only for v1:**
1. **Removes all deprecated API dependency** — the core risk (`eth_getEncryptionPublicKey` can be
   removed in any MetaMask update, permanently losing access to claimed keys) is fully resolved
   by X25519. The hybrid adds quantum resistance but does not change the deprecation risk profile.
2. **Identical wallet UX** — both schemes require exactly one `personal_sign`. The user experience
   does not change between v1 and v2.
3. **Lower implementation complexity for audit** — the audit covers v1. Introducing `@noble/post-quantum`
   and the ML-KEM-768 encapsulation/decapsulation logic adds surface area for the audit to cover.
   Deferring to v2 keeps the audited surface minimal.
4. **Forward-compatible by design** — the HKDF derivation uses `length = 32` for v1 (X25519
   secret key only). V2 extends this to `length = 96` (adding the 64-byte ML-KEM-768 seed) without
   invalidating v1 ciphertexts. The salt `"soulkey-hybrid-v1"` is shared, preserving the same
   derivation root.

### AES copy retained post-claim as v2 migration enabler
The AES-256 server-side copy of the CD key (`cd_keys.encrypted_key`) is **not deleted** after
`claimCdKey` confirms on-chain in v1. This is intentional.

**Why retain:**
The v1-to-v2 migration (X25519 → hybrid X25519 + ML-KEM-768) requires the plaintext CD key to
produce a new ciphertext. Without the AES copy, the only source of the plaintext is the user
decrypting the v1 on-chain ciphertext themselves — which requires user cooperation and puts the
burden on them. With the AES copy, the server can prepare the v2 ciphertext server-side and the
user only needs to sign one `personal_sign` to derive the expanded v2 keypair and call the
migration function. This is a dramatically better migration UX.

**Security model change:** The AES copy staying in the DB permanently increases the attack surface
compared to deleting it. This is an explicit, documented tradeoff: the AES key is already stored
server-side during the pre-claim period; retaining it post-claim extends the exposure window but
does not change the trust model (the operator already holds the AES key until claim). The v2 hybrid
migration is the event that renders the AES copy safe to delete.

**Not indefinite:** The AES copy is deleted as part of the v2 migration transaction for each
token, once that token's ciphertext has been successfully upgraded to hybrid and confirmed on-chain.

### v2 scheme: Hybrid X25519 + ML-KEM-768 (post-grant)
After v1 mainnet deployment and the CodeHawks audit, the encryption scheme will be upgraded to
hybrid X25519 + ML-KEM-768 (NIST FIPS 203). This is the same pattern used in TLS 1.3 by Google,
Go, and Java for "harvest now, decrypt later" quantum protection.

**Why defer to v2:** See above. The immediate priority is removing deprecated API dependency
(which X25519 alone achieves) and completing the audit on a minimal surface. Quantum resistance
is a genuine long-term concern for permanently on-chain ciphertext, but the upgrade cost is low
given the AES retention + forward-compatible HKDF design, so it can be done after audit.

**Why hybrid (not pure ML-KEM-768):** Defence in depth. A pure post-quantum scheme risks a novel
attack on ML-KEM before the classical X25519 layer is compromised. The hybrid ensures security
under both classical and quantum adversaries simultaneously.

---

## Database

### reserved_by + SKIP LOCKED for key reservation
When a user requests a commitmentHash, the key is soft-reserved at the wallet level using
`SELECT ... FOR UPDATE SKIP LOCKED`.
**Why:** Prevents two concurrent users getting the same key under high load. No application-level
lock needed. SKIP LOCKED skips rows already locked by another transaction instead of waiting.

### No global UNIQUE on mints.token_id
**Why:** Each SoulKey contract starts token IDs from 1. Game A token #1 and Game B token #1 are
different NFTs. A global UNIQUE constraint caused silent rollbacks when a second game tried to
register token #1. Dropped the constraint; uniqueness enforced by `(contract_address, token_id)`
combination. `cdkey_id UNIQUE` already prevents double-minting.

### DB-first token status (not RPC)
Token ownership and claim status are read from the `mints` table, not from RPC calls.
**Why:** 200-500ms faster. Fewer Alchemy calls (which have rate limits). More reliable. DB is
authoritative for what the frontend has processed.
**Risk acknowledged:** Can go out of sync if users interact with the contract directly. No event
listener yet (v2 milestone — Milestone 3 in the ESP grant).

### Refunds table checked for key availability
When finding available keys, `utils/db.ts` checks the `refunds` table as well as `cd_keys`.
**Why:** Refunded keys must be re-issuable. Before this fix, refunded keys were never returned to
the available pool — they were just lost inventory.

### Unique constraint on commitment_hash in cd_keys
**Why:** Prevents the same CD key from being imported twice. Previous bug: duplicate insertions
would increment `cdkey_id` and `batch_id` even when no key was actually added, causing phantom
counts.

### Two-phase redemption write (partial → confirmed)
The `redemptions` row is created by `/api/redeem` with only `wallet_encrypted_cdkey` (the partial
record). `/api/redeem/confirm` fills in the remaining columns only after independently verifying
the on-chain tx.
**Why:** `confirmRedemption` is intentionally NOT an upsert. A missing partial record means
`/api/redeem` never completed, which is a real error that should surface loudly (via the
`rowCount === 0` guard) rather than silently creating a broken row.

### clearEncryptedKey removed from confirm flow (v1 decision)
The step that nulled `cd_keys.encrypted_key` after claim has been removed in v1. The AES copy is
retained as the v2 migration enabler. See *AES copy retained post-claim as v2 migration enabler*
above.

### products.image_claimed_cid falls back to image_cid
The frozen metadata uploaded to Pinata at claim time uses `image_claimed_cid` if set, otherwise
`image_cid`.
**Why:** Frozen metadata should always be uploaded — that's what makes the NFT metadata permanent
and portable to marketplaces. Blocking the upload on a missing `image_claimed_cid` would mean
tokens without a claimed-specific image never get frozen metadata. The fallback lets every game
work correctly out of the box.

---

## API & Frontend

### contractAddress in every API request
Every route accepts `contractAddress` in the body or query string.
**Why:** Multi-game support. Games discovered at runtime from DB, not hardcoded at build time.
Also a prerequisite for v2 — per-developer admin panels require per-contract routing.

### Server verifies tx receipt independently in confirm/route.ts
`/api/redeem/confirm` calls `getTransactionReceipt` itself rather than trusting any status the
frontend sends.
**Why:** A client could send `status: 'success'` for a reverted tx. If the server trusted that, it
could take irreversible actions based on a failed claim. Server-side receipt fetch makes this
structurally impossible.

### Frontend also checks receipt.status before calling confirm
`handleClaimCDKey` in `HomeClient.tsx` checks `receipt.status !== 'success'` and throws before the
confirm fetch if the tx reverted.
**Why:** Defence in depth. The server check is the real guard; the frontend check prevents a wasted
network round-trip and gives the user an immediately clear error. The regression test in
`HomeClient.claimCdKey.test.tsx` will fail if this guard is removed.

### SIWE admin auth (EIP-4361)
Admin routes use Sign-In with Ethereum via iron-session. `requireAdminSession()` is centralised
in `utils/adminSession.ts`.
**Why:** The previous pattern (signed message + 5-minute timestamp expiry) had four problems:
replay window, no domain binding, MetaMask popup per action, and freeform string parsing risk.
SIWE fixes all four with one popup per 8-hour session.

### viem/siwe over the siwe npm package
```typescript
import { createSiweMessage, parseSiweMessage, generateSiweNonce } from 'viem/siwe';
```
**Why:** The `siwe` npm package's EIP-4361 parser threw a cryptic `"max line number was 9"` error
when receiving a serialised class instance instead of a plain string. `viem/siwe` uses plain
functions with no class instantiation — no serialisation footgun.

### generateSiweNonce() over crypto.randomUUID()
**Why:** EIP-4361 requires alphanumeric nonces of ≥8 characters. `crypto.randomUUID()` produces
hyphens which fail the spec. `generateSiweNonce()` from `viem/siwe` uses randomBytes + base58
encoding — always compliant.

### Nonce always consumed before validation, even on failure
In `verify/route.ts`, `session.nonce = undefined` is called before any validation that might throw.
**Why:** This is the replay-attack guard. If the nonce is only cleared on success, a failed request
could be replayed with the same nonce. The test `"nonce is always consumed"` in `verify.test.ts`
exists specifically to catch accidental removal.

### Always checksum contract addresses
Use `getAddress()` from viem when reading addresses from DB.
**Why:** DB stores lowercase addresses. Wagmi/viem silently rejects lowercase in some call paths,
returning `undefined` with no error. Caused a multi-hour debugging session.

### Dynamic NFT metadata (not static IPFS per mint)
`tokenURI` points to the Vercel API route which returns different JSON based on claim state.
**Why:** Avoids Pinata upload cost per mint. Only uploads frozen metadata to IPFS at claim time
when the state is permanent. Frozen CID stored in `redemptions.frozen_metadata_cid`.

### toBytes32 / toHexBytes extracted to utils/helpers.ts
These validation helpers were originally inline in the component. Moved to a shared utility module.
**Why:** The helpers need to be importable by tests without rendering the component.

### Scaffold-ETH 2 fully removed (25/03/26)
Re-initialised as pure foundry + Next.js without scaffold-ETH.
**Why:** scaffold-ETH baked contract addresses into `deployedContracts.ts`, making multi-game
support painful. Also caused yarn/npm conflicts on Vercel. The `indexedDB` wagmi SSR error was
traced back to scaffold's provider setup.

### Manual key import (not auto-generation)
Admin imports plaintext keys via `/admin` page. Old `generate-keys` route removed.
**Why:** Real game publishers supply their own keys — SoulKey doesn't generate them. Manual import
matches how actual key distribution works.

---

## V2: Developer-Owned Contracts

### Why developer-owned contracts (not a single-operator model forever)
V1 requires the Vault operator to manage all registrations, key imports, and metadata. This is a
centralisation bottleneck that limits scale. V2 moves to developer-owned contracts, matching how
Zora, Manifold, and other publishing protocols work: the protocol enforces the rules; the creator
owns the product.

### Commitment hash as the v2 anti-tamper anchor
The most critical invariant for a permissionless model: `commitmentHash[tokenId]` is set at mint
and immutable. A developer who controls the DB cannot substitute a bad key for a good one after a
buyer has already minted — the claim will revert with `InvalidCommitmentHash`. This is already in
v1. V2 inherits this protection fully.

**What it does not cover:** A developer importing invalid keys before any mints. A buyer mints, the
hash is on-chain, but the underlying key in the DB was bad to begin with. This is addressed by the
staking mechanism (economic cost to misbehave) and delayed key activation (review window for new
developers).

### Guardian role on SoulKey.sol (v2)
A `guardian` role is added to `SoulKey.sol`, held by the Vault operator. The guardian can pause
minting without touching the developer's ownership, funds, or key inventory.
**Why:** The Vault operator needs a circuit breaker for clearly malicious developers (e.g., known
scam operators) without being able to steal from the developer or interfere with existing token
holders. The guardian role is narrowly scoped — pause only, no asset access.

### Developer reputation via staking (v2)
Developers lock ETH proportional to `maxSupply` to register a contract.
**Why:** Makes supply-griefing and inventory fraud economically irrational. A developer who
imports 1,000 fake keys and collects payments from 1,000 buyers must have staked proportional ETH
upfront — the stake is claimable by buyers via the dispute mechanism. Economic cost is the primary
deterrent; the commitment hash makes post-mint fraud impossible anyway.

### Delayed key activation for new developers (v2)
Imported keys enter a `pending` state for a 24-hour window before becoming mintable, for developers
without an established track record.
**Why:** Gives the Vault operator a review window to flag obviously invalid key formats. Does not
require operator action for keys to go live — the window simply expires. Established developers
(verified publisher tier) bypass this window.

### ZK proofs: deferred
ZK proofs were evaluated as a potential enhancement, primarily to reduce on-chain ciphertext size.
The v2 ML-KEM-768 ciphertext is ~1,168 bytes. A ZK proof of correct encryption would be ~256 bytes
(Groth16), saving ~680,000 gas per claim at current prices (~$13).

**Why deferred — ML-KEM is not ZK-friendly:** ZK circuits operate over large prime fields (BN254
for Groth16, BLS12-381 for Plonk). ML-KEM-768's polynomial arithmetic over `q = 3329` does not
map to these fields without expensive emulation. No production ZK circuit for ML-KEM exists today.

**Why deferred — privacy/soulbound tension:** ZK excels at hiding data. Soulbound tokens are
explicitly designed to make ownership public and verifiable. ZK would add complexity without
addressing SoulKey's actual privacy model, which is already handled by the encryption.

**Conclusion:** No ZK implementation until ZK-friendly ML-KEM circuits exist in production.
Revisit if per-claim gas becomes a real user barrier on mainnet.

### SIWE (EIP-4361) for admin auth — one sign-in, not per-action
Replaced the old timestamp + `verifyMessage` + on-chain owner pattern with full SIWE.
**Why the old pattern was insufficient:**
1. Replay window — same `{message, signature}` pair valid for 5 minutes.
2. No domain binding — a phishing site could replay a legitimately signed message.
3. Per-action UX — every register/import/deregister triggered a MetaMask popup.
4. Freeform message format — custom string parsing with silent breakage risk.

---

## Lessons from Dev History

- `NEXT_PUBLIC_` variables are public to the browser bundle. Never use for secrets.
- Foundry dependencies use git submodules, not a lockfile. `forge install` reads `.gitmodules`. If
  submodules are lost, re-run `forge install OpenZeppelin/openzeppelin-contracts --no-commit` etc.
  individually.
- `wagmi@3` and `@rainbow-me/rainbowkit` are incompatible. Pinned to `wagmi@^2`.
- Scaffold-ETH's `generateTsAbis.js` rebuilds `deployedContracts.ts` on every deploy, wiping
  multi-contract support. Solution was removing scaffold-ETH entirely.
- Vercel rebuilds on every `.md` file commit to a watched GitHub repo. Use `[skip ci]` for
  docs-only changes.
- SQL column names in `@vercel/postgres` template literals are never transformed — always use the
  exact snake_case column name: `contract_address`, `cdkey_id`, `image_claimed_cid`, etc.
- Vitest setup files must use the `.tsx` extension if they contain JSX.
- `SESSION_SECRET` missing from environment causes a cascade: iron-session throws → nonce is
  `undefined` → SIWE message contains `Nonce: undefined` → EIP-4361 parser fails with cryptic
  "max line number was 9" error.
- Test addresses must be valid 40-char hex. Readable-but-invalid strings like `"0xGameContract..."`
  fail route input validation with 400 before ownership checks are reached.
- In Vitest, `require()` inside a `beforeEach` bypasses the mock registry. Use top-level imports.
