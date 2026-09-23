# SoulKey — Open Issues & Task List

Update when something actually changes. Do not leave DONE items in Medium.
🔴 High (security/data-loss) | 🟡 Med | 🟢 Low | 🔵 Future

**Repo tip (23/09/26):** `main` `4f4ce4c`. Demo: https://soulkey.vercel.app/ (Ethereum Sepolia).
Vitest 98/98 (12 files). Foundry 98/98 (Fedora). Live X-Wing claim gas: **946,011**
(`0x2f27049e71c13ae2d6637078707ad7acb615b387ce98d66c15342ee444cb2991`, token 51).

---

## 🔴 High

None. Deprecated MetaMask `eth_getEncryptionPublicKey` / `eth_decrypt` are gone.
Default claim cipher is X-Wing. AES-GCM at rest. Confirmed claims delete the server copy.

---

## 🟡 Medium — still open

### Redeploy SoulKey for the mint-cap fix
Source on `main` gates mint as lifetime mints minus **unclaimed** refund burns
(`_refundBurnedCount`). Live Sepolia games (incl. `0x872952D3a86e0cBd8E56aF38f73bce1A28D356EF`)
still run the old bytecode. `totalSupply()` there still subtracts claimed burns.
**Do:** deploy one new game, `registerGame` on the existing vault, import a small GCM batch,
mint + unclaimed refund + remint. Leave old games as history.

### RPC chain is hardcoded to Ethereum Sepolia
`/api/redeem/confirm` and `/api/refund` construct `createPublicClient({ chain: sepolia })`.
`nextjs/lib/wagmi.ts` exposes Ethereum mainnet + Sepolia, not Arbitrum.
Roadmap is Arbitrum One. Next code slice: `utils/chain.ts` from env (`NEXT_PUBLIC_CHAIN`),
default Sepolia. No chain cutover in that PR.

### Vercel install still ran npm on 4f4ce4c
`package-lock.json` is gone. Production log still showed `Running "install" command: npm install`
plus React 19 peer warnings (`use-sync-external-store@1.2.0`). Build was Ready anyway.
**Do:** Vercel → Install Command `pnpm install --frozen-lockfile`. Add
`"packageManager": "pnpm@<fedora pnpm -v>"` to `nextjs/package.json`. Confirm the next
production log says pnpm, not npm.

### Chain sync — DB vs chain
Direct `claimCdKey` / burn / pre-claim transfer bypasses the API. Planned: Alchemy Notify
for `Transfer`, `CdKeyClaimed`, `NFTBurned` → `nextjs/app/api/webhooks/alchemy/route.ts`.
Needs an Alchemy dashboard webhook + signing secret. Not a first Flash ticket.

### ENCRYPTION_KEY rotation script
Not written. Needed before a public mainnet if the AES key leaks.
Must decrypt both `v2gcm:` and legacy CBC, rewrite GCM. Confirmed-claim rows are already NULL.

### import-keys UNIQUE path
Confirm single-key and batch import both use `ON CONFLICT (commitment_hash) DO NOTHING`.
File: `nextjs/app/api/admin/import-keys/route.ts`.

### Refund: chain ok, API miss
If `processRefund` succeeds and `/api/refund` never records it, the key stays un-refunded in Neon.
Frontend refresh-resume covers the shop path. Direct Etherscan refunds still need a manual row
or a webhook.

ETH vs stablecoin value drift across the 14-day window is a known limitation, not a bug.

---

## 🟢 Low

- Empty key-pool message (get-commitment 404 text is already specific; UI may still look generic).
- Pending-tx UI while the tx mines (resume exists; loading state is incomplete).
- Delisted-game badge in Library.
- `image_claimed_cid` admin field (Neon SQL only today).
- `SKILL_API_DB.md` still mentions a missing `skills/references/GOTCHAS.md` and pre-X-Wing crypto.
  `SKILL_FRONTEND.md` encryption section is current (12/09/26).
- ~78 pre-existing lint errors (`no-explicit-any`, `set-state-in-effect`). Not a product blocker.
- Stale remote branches: `feat/pending-tx-resume`, `fix/refund-remint-overwrite` (merged via later PRs).

---

## 🔵 Future (v2 / public chain)

Developer-owned SoulKey, vault guardian pause, stake vs maxSupply, 24h pending keys for new
publishers, ERC-1271/6492 SIWE, EIP-5630 if wallets ship it, ZK deferred (ML-KEM not
ZK-friendly), Chainlink ETH/USD, AgentKit. CodeHawks when the cap-fix bytecode is the freeze
candidate — not the current Sepolia games.

---

## Checklist

- [x] Key deletion atomicity (confirm verifies chain, delete last)
- [x] Pinata failure non-fatal; `frozen_metadata_cid`
- [x] SIWE admin + 35 auth tests
- [x] Vitest 98 / 12 files
- [x] Foundry 98/98
- [x] X25519 v1 + X-Wing v2 default claim cipher
- [x] `clearEncryptedKey` last on confirm; failed claim keeps AES row
- [x] Availability requires `encrypted_key IS NOT NULL` + `redemption_tx_hash IS NULL`
- [x] Refund 409 on confirmed claim + receipt check
- [x] tokenURI frozen CID scoped by `contract_address`
- [x] `p.is_active = TRUE` in reserve queries
- [x] X-Wing claim gas measured on Sepolia: 946,011 (13/09/26)
- [ ] Pin Vercel to pnpm (`packageManager` + Install Command)
- [ ] Redeploy one Sepolia SoulKey with `_refundBurnedCount`
- [ ] Extract RPC chain helper (stop hardcoding sepolia)
- [ ] Alchemy webhooks
- [ ] ENCRYPTION_KEY rotation script
- [ ] CodeHawks on freeze bytecode
- [ ] Gas pass / Arbitrum cutover

---

## Recently resolved (Sep 2026)

- 13/09/26 — Production Vercel Ready on `4f4ce4c`. Smoke: mint → refresh → X-Wing claim →
  reveal → claimed refund reverts on-chain. New import batch writes `v2gcm:`.
- 13/09/26 — PR #4: inventory + refund receipt + tokenURI contract scope; npm lockfile deleted.
- 12/09/26 — PR #3: X-Wing claims, AES-GCM at rest, mint-cap source fix.
- 12/09/26 — PR #2: refresh-resume; refund idempotent; no 0-amount refund row on revert.
