---
name: soulkey-frontend
description: >
  Patterns and conventions for SoulKey's Next.js frontend. Use this skill
  whenever modifying HomeClient.tsx, AdminClient.tsx, any component, any page,
  or Providers.tsx. Triggers on: "HomeClient", "AdminClient", "wagmi hook",
  "RainbowKit", "ConnectButton", "useReadContract", "writeContractAsync",
  "handleClaimCDKey", "handleMint", "handleRefund", "deriveClaimKeys", "X-Wing",
  "personal_sign", "receipt.status", UI layout,
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

## Wallet Encryption: personal_sign → X-Wing (v2), X25519 (v1 dual-read)

```typescript
// HomeClient.tsx — deriveClaimKeys: ONE personal_sign feeds both schemes
const sig = await window.ethereum.request({
  method: 'personal_sign',
  params: [`SoulKey encryption key v1\nAddress: ${wallet}`, wallet],
});
// v2 (default): HKDF-SHA256(IKM = full 65-byte sig, salt "soulkey-xwing-v2", 32)
//   → X-Wing seed → ml_kem768_x25519.keygen(seed)   (utils/xwing.ts)
// v1 (legacy):  HKDF-SHA256(IKM = full 65-byte sig, salt "soulkey-hybrid-v1", 32)
//   → X25519 secret key → X25519 public key          (utils/x25519.ts)
```

- **Claim:** POST `/api/redeem` with `xwingPublicKey` (1,216 B). The legacy 32-byte
  `x25519PublicKey` is still sent alongside for deploy-skew; the server prefers X-Wing and
  returns the v2 blob `0x02 || xwingCt(1120) || nonce(12) || tag(16) || aesCt` (~1.15 KB),
  which `claimCdKey` writes on-chain.
- **Reveal:** `decryptClaimCiphertextWebCrypto(hex, { x25519SecretKey, xwingSeed })`
  dual-reads both versions — 0x02-prefixed blob ≥1150 bytes → X-Wing; unprefixed → v1
  X25519. Tokens claimed before 12/09/26 still decrypt.
- Both keypairs live in ONE `useRef` cache (`claimKeysRef`), cleared on wallet change:
  claim + immediate reveal = one `personal_sign` prompt per session.

⚠️ HKDF IKM is the FULL 65-byte signature — never `.slice(0, 32)` (halves entropy silently
and changes the derived keypairs). See GOTCHAS.md.
⚠️ `eth_getEncryptionPublicKey` / `eth_decrypt` are DEAD — never reintroduce them. The
`CDKeyEncryption.tsx` component that used them was deleted 31/03/26; personal_sign + X25519
shipped as v1, and X-Wing (ML-KEM-768 + X25519, `@noble/post-quantum` 0.7.1) became the
default claim cipher 12/09/26. No HQC, no McEliece, no homemade hybrid.

---

## Helper Utilities

- `utils/helpers.ts` — `toBytes32`, `toHexBytes`. Must be importable without rendering any component (needed for tests).
- `utils/crypto.ts` — server-side only. AES-256-GCM at rest (`v2gcm:` writes, legacy CBC dual-read), `encryptWithXWing` (v2) / `encryptWithX25519` (v1), keccak256 hash.
- `utils/xwing.ts` / `utils/x25519.ts` — browser derivation from one `personal_sign` + WebCrypto decrypt (v2 / v1 dual-read).
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
