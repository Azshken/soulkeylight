# SoulKey — Decisions Log

Why things were built the way they were. Useful when revisiting old code or starting a new Claude Code session on a tricky problem.

---

## Smart Contract

### One SoulKey contract per game (not a registry)
Deploy a fresh SoulKey.sol for each game. MasterKeyVault is deployed once and shared.
**Why:** Isolates game economies. A bug in one game doesn't affect others. Deregistering a game is a DB flag, not a contract change. Each game has its own token ID space starting from 1.

### SoulKey holds no funds
All ETH/USDT/USDC is forwarded to MasterKeyVault via `vault.collectPayment` at mint time.
**Why:** Cleaner separation of concerns. All financial logic lives in one auditable place. SoulKey is purely an NFT contract. Also means `recoverERC20` on SoulKey is safe with no reserve check.

### Exact ETH amount required at mint (no excess refund)
`mintWithETH` reverts if `msg.value != mintPriceETH` — no refund path for excess.
**Why:** Eliminates the smart-contract-receiver griefing vector where a malicious contract could block the excess refund call and grief the mint. Frontend reads `mintPriceETH` and constructs the exact tx.

### claimTimestamp instead of a bool for soulbound tracking
`claimTimestamp[tokenId]` stores the block timestamp at claim (0 = unclaimed).
**Why:** Gives you the claim time for free with no extra storage. Useful for the 14-day refund window and metadata. A bool would require a separate timestamp mapping.

### burnByVault separate from user burn
`burnByVault` is restricted to the vault (`onlyVault`). User `burn` only works on claimed tokens.
**Why:** Unclaimed tokens must go through `processRefund` so the vault settles the payment. If a user could directly burn an unclaimed token, their funds would be locked in the vault reserve forever.

### Commitment hash pattern (not key-on-mint)
User mints with `commitmentHash = keccak256(encryptedKey)`, not the key itself.
**Why:** Separates "I own this key" (mint) from "I want my key" (claim). Keeps the encrypted key off-chain until the user actively claims.

### No merkle tree for front-running protection
Removed the merkle tree safeguard.
**Why:** Front-running doesn't work here. If an attacker copies a `commitmentHash` from the mempool, they still have to pay for the NFT — and they'd get an NFT they can never redeem because they don't have the matching encrypted key. They gain nothing but a paid-for worthless NFT. No protection needed.

### Ownable2Step on both contracts
**Why:** Prevents accidental ownership loss from a typo'd transfer address. The new owner must explicitly accept before ownership transfers.

### 5% refund fee as anti-griefing
**Why:** Without a fee, someone could mint your entire supply then refund before expiry, blocking all legitimate buyers. A 5% cost makes this economically irrational. `releaseReserveOnExpiry` is permissionless so the reserve unlocks even if the owner is unresponsive.

---

## Database

### reserved_by + SKIP LOCKED for key reservation
When a user requests a commitmentHash, the key is soft-reserved at the wallet level using `SELECT ... FOR UPDATE SKIP LOCKED`.
**Why:** Prevents two concurrent users getting the same key under high load. No application-level lock needed. SKIP LOCKED skips rows already locked by another transaction instead of waiting.

### No global UNIQUE on mints.token_id
**Why:** Each SoulKey contract starts token IDs from 1. Game A token #1 and Game B token #1 are different NFTs. A global UNIQUE constraint caused silent rollbacks when a second game tried to register token #1. Dropped the constraint; uniqueness enforced by `(contract_address, token_id)` combination. `cdkey_id UNIQUE` already prevents double-minting.

### DB-first token status (not RPC)
Token ownership and claim status are read from the `mints` table, not from RPC calls.
**Why:** 200-500ms faster. Fewer Alchemy calls (which have rate limits). More reliable. DB is authoritative for what the frontend has processed.
**Risk acknowledged:** Can go out of sync if users interact with the contract directly. No event listener yet.

### Refunds table checked for key availability
When finding available keys, `utils/db.ts` checks the `refunds` table as well as `cd_keys`.
**Why:** Refunded keys must be re-issuable. Before this fix, refunded keys were never returned to the available pool — they were just lost inventory.

### Unique constraint on commitment_hash in cd_keys
**Why:** Prevents the same CD key from being imported twice. Previous bug: duplicate insertions would increment `cdkey_id` and `batch_id` even when no key was actually added, causing phantom counts.

---

## API & Frontend

### contractAddress in every API request
Every route accepts `contractAddress` in the body or query string.
**Why:** Multi-game support. Games discovered at runtime from DB, not hardcoded at build time. Previously scaffold-ETH baked the address into `deployedContracts.ts` at deploy time — that's why multi-game was painful.

### Signed message + on-chain ownership for admin auth
Admin routes verify: (1) signature timestamp not older than 5 minutes, (2) viem `verifyMessage` signature check, (3) on-chain `owner()` call to confirm wallet owns the contract.
**Why:** More secure than just checking a wallet address in the request body (trivially spoofed). Current implementation avoids SIWE dependency while still being reasonably secure.
**Future:** Full SIWE when going to mainnet — see OPEN_ISSUES.

### Always checksum contract addresses
Use `getAddress()` from viem when reading addresses from DB.
**Why:** DB stores lowercase addresses. Wagmi/viem's internal `checksumAddress` throws or silently rejects lowercase addresses in some call paths. Caused a very painful debugging session where all contract reads returned `undefined`. Fix: either checksum before storing (in register-game route) or checksum when reading (in page.tsx).

### Dynamic NFT metadata (not static IPFS per mint)
`tokenURI` points to the Vercel API route which returns different JSON based on claim state.
**Why:** Avoids Pinata upload cost per mint. Only uploads frozen metadata to IPFS at claim time when the state is permanent. Frozen CID stored in `redemptions.frozen_metadata_cid`.

### Scaffold-ETH 2 fully removed (25/03/26)
Re-initialised as pure foundry + Next.js without scaffold-ETH.
**Why:** scaffold-ETH baked contract addresses into `deployedContracts.ts`, making multi-game support painful. Caused `useScaffoldReadContract` to always read from the first deployed address. Also caused yarn/npm conflicts on Vercel. The `indexedDB` wagmi SSR error was also traced back to scaffold's provider setup.

### Manual key import (not auto-generation)
Admin imports plaintext keys via `/admin` page. Old `generate-keys` route removed.
**Why:** Real game publishers supply their own keys — SoulKey doesn't generate them. The old generate route was only useful for testing. Manual import matches how actual key distribution works.

---

## Lessons from Dev History

- `NEXT_PUBLIC_` variables are public to the browser bundle. Never use for secrets (learned the hard way on 21/02/26).
- Foundry dependencies use git submodules, not a lockfile. `forge install` reads `.gitmodules`. If submodules are lost, re-run `forge install OpenZeppelin/openzeppelin-contracts --no-commit` etc. individually.
- `wagmi@3` and `@rainbow-me/rainbowkit` are incompatible. Pinned to `wagmi@^2` for RainbowKit compatibility.
- Scaffold-ETH's `generateTsAbis.js` rebuilds `deployedContracts.ts` on every deploy, wiping multi-contract support. The solution was removing scaffold-ETH entirely.
- Vercel rebuilds on every `.md` file commit to GitHub (watched repo). Useful for forced redeployments but annoying if you're just updating docs.
