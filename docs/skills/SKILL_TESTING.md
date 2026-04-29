---
name: soulkey-testing
description: >
  Patterns and gotchas for SoulKey's Vitest test suite. Use this skill whenever
  writing, modifying, or debugging any test file, or when a test is failing
  unexpectedly. Triggers on: "test", "vitest", "vi.mock", "beforeEach",
  "expect", "waitFor", "screen.findByRole", ".test.ts", ".test.tsx", "pnpm test",
  "auth guard test", "verify.test", "claimCdKey.test", or any test failure.
  DO NOT use for: production code in API routes, contracts, or frontend
  components that are not test files.
---

# SoulKey Testing Patterns

Tests live in `nextjs/__tests__/`. Run: `cd nextjs && pnpm test`.
No wallet or DB needed — everything is mocked.

---

## Test Architecture

```
nextjs/__tests__/
  admin/
    adminSession.test.ts   — requireAdminSession: all 4 auth states
    nonce.test.ts          — nonce generation, session storage, stale auth cleared
    verify.test.ts         — full SIWE verify gauntlet (400/401/403/200)
    auth-guard.test.ts     — 401/403 on all 3 protected routes
  utils/
    helpers.test.ts        — toBytes32, toHexBytes unit tests
  HomeClient.claimCdKey.test.tsx  — claim flow integration tests
```

35 admin auth tests total.

---

## Critical Gotchas

### Setup file MUST be `.tsx`, not `.ts`
`vitest.setup.tsx` contains JSX. A `.ts` extension causes `<button>` to be parsed as a less-than operator — cryptic arithmetic type errors with no obvious connection to JSX.

### `require` inside `beforeEach` bypasses mock registry
```typescript
// WRONG — gets the real module, not the mock
beforeEach(() => { const { fn } = require('../utils/adminSession'); });

// RIGHT — top-level import gets the mocked version
import { fn } from '../utils/adminSession';
```

### Test addresses must be valid 40-char hex
```typescript
// WRONG — 'G' is not hex, causes 400 before the ownership check is ever reached
const addr = '0xGameContract1234567890123456789012345678';

// RIGHT
const CONTRACT = `0x${'0'.repeat(38)}AA`;
```

Non-hex characters fail route input validation with `400` before auth checks run, making `403` tests permanently unreachable.

---

## Regression Tests — Never Remove These

### 1. Reverted transaction guard (`HomeClient.claimCdKey.test.tsx`)

```typescript
it('does NOT call /api/redeem/confirm when receipt.status is reverted', ...)
```

If `if (receipt.status !== 'success')` is removed from `HomeClient.tsx`, this fails.

### 2. Nonce always consumed (`verify.test.ts`)

```typescript
it('always clears session nonce, even on failure', ...)
```

If `session.nonce = undefined` is removed from `verify/route.ts`, this fails. This guards against replay attacks being re-introduced.

---

## SIWE Verify: Required Coverage

`verify.test.ts` must cover ALL of these:

| Case | Expected |
|---|---|
| Missing body fields | `400` |
| Invalid SIWE message format | `400` |
| Domain mismatch | `401` |
| Nonce mismatch | `401` |
| Expired message | `401` |
| Bad signature | `401` |
| Address not vault owner | `403` |
| Happy path | `200` |
| Nonce consumed on failure | assert `session.nonce === undefined` |

---

## Auth Guard Coverage

`auth-guard.test.ts` verifies all three protected routes (`register-game`, `import-keys`, `deregister-game`) return:
- `401` for unauthenticated (no session)
- `403` for authenticated but wrong owner
- Neither DB nor RPC is called before auth passes

---

## Claim Flow Coverage (`HomeClient.claimCdKey.test.tsx`)

Required cases:
- Happy path → receipt success → confirm called → success toast
- Reverted tx → confirm never called → error toast contains "reverted"
- User rejects wallet popup → confirm never called
- `/api/redeem` server error → confirm never called
- Guards: no wallet connected, already claimed
- Loading state: spinner visible during pending tx

---

## Mock Strategy

| Layer | How |
|---|---|
| wagmi hooks | `vi.mock('wagmi')` |
| `window.ethereum` | Mocked in `vitest.setup.tsx` |
| iron-session | `vi.mock('iron-session')` returning controlled session objects |
| viem / RPC | `vi.mock('viem')` — `createPublicClient`, `verifyMessage`, `readContract` |
| DB | `vi.mock('@vercel/postgres')` — `sql` returns controlled rows |

---

## Checklist When Adding Tests

- [ ] Setup file uses `.tsx` extension if it contains JSX?
- [ ] Imports at top-level (not inside `beforeEach`)?
- [ ] Test addresses use valid 40-char hex (`0x` + 40 chars from `[0-9a-fA-F]`)?
- [ ] Any new guard (`if X throw`) has a test that fails when guard is removed?
- [ ] Auth guard tests verify DB and RPC are NOT called before auth passes?
- [ ] Nonce consumption tested for failure cases in SIWE tests?
