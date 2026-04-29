---
name: soulkey-frontend
description: >
  Patterns and conventions for SoulKey's Next.js frontend. Use this skill
  whenever modifying HomeClient.tsx, AdminClient.tsx, any component, any page,
  or Providers.tsx. Triggers on: "HomeClient", "AdminClient", "wagmi hook",
  "RainbowKit", "ConnectButton", "useReadContract", "writeContractAsync",
  "handleClaimCDKey", "handleMint", "handleRefund", "receipt.status", UI layout,
  wallet connection behaviour, or SIWE sign-in flow in the admin UI.
  DO NOT use for: API routes, database queries, Solidity contracts, or
  Foundry tests — use soulkey-api-db or soulkey-contracts instead.
---

# SoulKey Frontend Patterns

Reference: `docs/ARCHITECTURE.md` for multi-game discovery flow.

---

## Stack (Locked — Do Not Upgrade Independently)

| Concern | Library | Critical Note |
|---|---|---|
| Framework | Next.js App Router | `app/` directory |
| Wallet UI | RainbowKit | **Must stay on wagmi v2** |
| Wallet hooks | wagmi v2 | Direct hooks — NOT Scaffold-ETH wrappers |
| RPC / contracts | viem | Direct `readContract` / `writeContract` |
| Providers | `components/Providers.tsx` | Wagmi → QueryClient → RainbowKit |

**wagmi v3 is incompatible with RainbowKit.** Do not upgrade wagmi without verifying RainbowKit compatibility first.

**Do not re-introduce Scaffold-ETH.** It baked addresses into `deployedContracts.ts`, caused yarn/Vercel conflicts, and caused the indexedDB wagmi SSR error. Removed permanently 25/03/26.

---

## Address Checksumming: Always

```typescript
import { getAddress } from 'viem';

// When reading contractAddress from API/DB before wagmi hooks:
const contractAddress = getAddress(product.contract_address);
```

DB stores lowercase. Wagmi/viem silently returns `undefined` for all contract reads with lowercase addresses — no error thrown, just empty data.

---

## Multi-Game: Runtime Discovery

```typescript
// Games discovered at runtime — never hardcoded
const products = await fetch('/api/products').then(r => r.json());
// Game selector appears automatically when 2+ active products exist
```

All API calls include `contractAddress`. No global singleton address anywhere.

---

## ABIs: Single Source of Truth

```typescript
// utils/abis.ts — import from here, never inline
import { SOULKEY_ABI, VAULT_ABI } from '@/utils/abis';
```

---

## Claim Flow: Defence in Depth

```typescript
// HomeClient.tsx — handleClaimCDKey
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

// Frontend checks BEFORE calling confirm — defence in depth
if (receipt.status !== 'success') {
  throw new Error('claimCdKey transaction reverted. Your key is safe — please try again.');
}

await fetch('/api/redeem/confirm', { ... });
```

The **server** is the real guard (it fetches its own receipt). The frontend check prevents a wasted round-trip and gives the user an immediate clear error. **Do not remove this check** — the regression test in `HomeClient.claimCdKey.test.tsx` will catch removal.

---

## Admin UI Auth Flow (SIWE)

```
1. Wallet connects
2. Client-side: check vault owner on-chain (UX shortcut — non-owners never see SIWE prompt)
3. GET /api/admin/nonce
4. Admin signs SIWE message (ONE MetaMask popup for the whole session)
5. POST /api/admin/verify → session cookie written
6. All subsequent admin actions use cookie — no more signing popups
7. On wallet disconnect or address change → POST /api/admin/logout
```

---

## MetaMask Encryption (CDKeyEncryption.tsx)

```typescript
// 1. Get user's public key
const pubKey = await window.ethereum.request({
  method: 'eth_getEncryptionPublicKey',
  params: [userAddress]
});

// 2. Server re-encrypts CD key with this public key (x25519-xsalsa20-poly1305)

// 3. User decrypts locally with MetaMask
const decrypted = await window.ethereum.request({
  method: 'eth_decrypt',
  params: [encryptedKey, userAddress]
});
```

⚠️ `eth_getEncryptionPublicKey` is deprecated in MetaMask Flask and unsupported in non-MetaMask wallets. Known structural risk — see `docs/OPEN_ISSUES.md`.

---

## Helper Utilities

- `utils/helpers.ts` — `toBytes32`, `toHexBytes`. Must be importable without rendering any component (needed for tests).
- `utils/crypto.ts` — server-side only. AES-256 encrypt + keccak256 hash.
- `utils/adminSession.ts` — iron-session config + `requireAdminSession`. Do not duplicate session reads in individual routes.

---

## Checklist Before Any Frontend Change

- [ ] Contract addresses from API/DB go through `getAddress()` before wagmi?
- [ ] `handleClaimCDKey` still checks `receipt.status !== 'success'` before confirm?
- [ ] ABIs imported from `utils/abis.ts` (not inlined)?
- [ ] `contractAddress` passed to every API call?
- [ ] Admin logout triggered on wallet disconnect and address change?
- [ ] New utility functions that need testing extracted to `utils/helpers.ts`?
- [ ] wagmi still pinned to v2 (no accidental upgrade)?
