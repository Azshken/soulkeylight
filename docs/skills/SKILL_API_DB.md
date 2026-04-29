---
name: soulkey-api-db
description: >
  Patterns and invariants for SoulKey's API routes and database layer. Use this
  skill whenever writing, modifying, or debugging ANY file in nextjs/app/api/ or
  nextjs/utils/db.ts. Triggers on: new route, modifying a route, writing SQL,
  debugging a 400/401/403/500, touching the claim/redeem/refund flow, or any
  mention of "route", "endpoint", "query", "schema", "redemption",
  "confirmRedemption", "clearEncryptedKey", "requireAdminSession", "SIWE",
  "iron-session", or "SKIP LOCKED".
  DO NOT use for: smart contract code, frontend components, wagmi hooks, or
  purely Solidity questions — use soulkey-contracts instead.
---

# SoulKey API + Database Patterns

Reference: `docs/ARCHITECTURE.md` for flow diagrams. `skills/references/GOTCHAS.md` for bug history.

---

## The Two Cardinal Rules

### 1. Server Never Trusts the Client for On-Chain State

```typescript
// WRONG — trusting client-provided status
if (body.status === 'success') { deleteKey(); }

// RIGHT — server fetches its own receipt
const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
if (receipt.status !== 'success') throw new Error('Transaction reverted');
```

### 2. clearEncryptedKey Is Always the Last Step

The confirm flow has exactly this order — never reorder it:

```
Step 1: getTransactionReceipt()     — on-chain verify (server-fetched)
Step 2: getClaimTimestamp()         — on-chain verify claimTimestamp != 0
Step 3: confirmRedemption()         — DB write (throws if rowCount == 0)
Step 4: Pinata upload               — non-fatal, wrapped in try/catch
Step 5: recordReserveRelease()      — audit log
Step 6: clearEncryptedKey()         — POINT OF NO RETURN, always last
```

If `clearEncryptedKey` runs before on-chain verification and the tx reverted, the user has no key. Even if step 6 fails, the user is safe — they can decrypt via `getEncryptedCDKey` on-chain.

---

## Multi-Game: contractAddress in Every Route

```typescript
// Every route accepts contractAddress — never hardcode
const { contractAddress, walletAddress } = await req.json();
```

---

## Claim Flow: Two-Phase Redemption

```
POST /api/redeem
  └─ INSERT redemptions: { wallet_encrypted_cdkey } only — partial row

[User calls claimCdKey on-chain]

POST /api/redeem/confirm
  └─ Steps 1–6 above
```

`confirmRedemption` is **NOT an upsert**. A missing partial row (rowCount == 0) means `/api/redeem` never completed — throw loudly, do not proceed.

---

## Admin Auth: SIWE EIP-4361 (current implementation)

```
GET  /api/admin/nonce   → generateSiweNonce() stored in iron-session
POST /api/admin/verify  → parseSiweMessage → domain check → nonce check
                           → expiry check → verifyMessage() → owner() on-chain
                           → session.save({ address, authenticated: true })
Protected routes        → requireAdminSession() — first line, always
POST /api/admin/logout  → session.destroy() on wallet change/disconnect
```

**Critical implementation details:**
- `requireAdminSession()` is in `utils/adminSession.ts` — import from there, never inline
- Use `viem/siwe` not the `siwe` npm package (class serialisation footgun)
- Use `generateSiweNonce()` not `crypto.randomUUID()` (hyphens fail EIP-4361)
- Nonce consumed **before** any validation — even on failure (replay attack guard)
- `SESSION_SECRET` must be in both `.env.local` AND Vercel dashboard
- SIWE proves identity. Per-route `owner()` check proves authorization — both required

**SESSION_SECRET missing cascade:** iron-session throws → nonce is `undefined` → SIWE message has `"Nonce: undefined"` → EIP-4361 parser fails with `"max line number was 9"`. No obvious connection to the env var.

---

## SQL Column Names: Exact snake_case WITH Underscores

`@vercel/postgres` template literals are **never transformed**. Wrong case silently returns undefined.

```typescript
// WRONG — camelCase, silently returns undefined
await sql`SELECT p.contractAddress FROM products p`

// ALSO WRONG — no underscores
await sql`SELECT p.contractaddress FROM products p`

// RIGHT — exact snake_case with underscores
await sql`SELECT p.contract_address FROM products p`
```

Common columns to get right: `contract_address`, `cdkey_id`, `image_claimed_cid`, `frozen_metadata_cid`, `wallet_encrypted_cdkey`, `commitment_hash`, `reserved_by`.

**Always cross-reference the schema** when writing new queries.

---

## Address Checksumming

```typescript
import { getAddress } from 'viem';
const contractAddress = getAddress(row.contract_address); // always before RPC calls
```

DB stores lowercase. Wagmi/viem silently returns undefined for lowercase in some call paths.

---

## Database: Key Availability Logic

Key is available when it has no mint row, OR has a mint row AND a refund row:

```sql
AND NOT EXISTS (
  SELECT 1 FROM mints m
  LEFT JOIN refunds r ON r.cdkey_id = m.cdkey_id
  WHERE m.cdkey_id = ck.id AND r.cdkey_id IS NULL
)
```

Refunded keys must return to the available pool — always check the `refunds` table.

---

## Database: SKIP LOCKED for Concurrent Reservation

```sql
SELECT id, commitment_hash FROM cd_keys
WHERE reserved_by IS NULL
  AND <availability logic above>
ORDER BY created_at ASC
LIMIT 1
FOR UPDATE OF ck SKIP LOCKED;
```

---

## Schema Quick Reference

```
products        — contract_address, name, genre, description, image_cid, image_claimed_cid, metadata_cid, is_active
batches         — batch_id, product_id, created_at, notes
cd_keys         — id, batch_id, encrypted_key, commitment_hash, reserved_by VARCHAR(42), created_at
mints           — mint_id, cdkey_id UNIQUE FK, token_id (NO global UNIQUE), contract_address, minted_by, minted_at
redemptions     — redemption_id, cdkey_id UNIQUE FK, wallet_encrypted_cdkey, redeemed_by, redeemed_at,
                  redemption_tx_hash, block_number, frozen_metadata_cid
refunds         — refund_id, cdkey_id, refunded_by, refunded_at, refund_tx_hash
reserve_releases — audit log
```

**`mints.token_id` has NO global UNIQUE** — each game starts from token_id=1.
**`cd_keys.commitment_hash` HAS a UNIQUE constraint** — prevents duplicate import phantom counts.

---

## Checklist Before Any Route Change

- [ ] Accepts `contractAddress` in body/query?
- [ ] Calls `requireAdminSession()` as first line if admin-protected?
- [ ] Checksums DB addresses with `getAddress()` before RPC?
- [ ] Server fetches its own tx receipt — never trusts client?
- [ ] SQL column names verified as exact snake_case with underscores?
- [ ] `clearEncryptedKey` is still the last step in confirm flow?
- [ ] Non-fatal side effects (Pinata) wrapped in try/catch?
- [ ] `is_active` checked before issuing keys for deregistered games?
