# SoulKey 🗝️

> NFT-based game key distribution — own your games, provably.

Live demo (Sepolia testnet): https://soulkey.vercel.app/

## What It Does

SoulKey lets game publishers distribute CD keys as NFTs. Players mint an NFT
that represents a cryptographic claim to a game key. When they redeem it, the
key is encrypted directly to their wallet — and the NFT becomes soulbound
(non-transferable) forever.

No plain text keys are ever exposed. Ever.

## Why It's Different

- **True ownership** — your game lives in your wallet, not a platform account
- **Platform-portable** — NFT proves legitimate purchase across any storefront
- **Tradeable before redemption** — gift or sell unclaimed keys on secondary markets
- **Soulbound after redemption** — claimed keys can't be stolen or resold
- **Developer royalties** — 5% on every secondary sale via ERC-2981

## How It Works

1. Publisher generates CD keys — stored encrypted in PostgreSQL, never in plain text
2. Player mints NFT with a `commitmentHash` (cryptographic claim to a specific key)
3. Player claims the key — it gets encrypted with their MetaMask public key
   and written on-chain; plain text key is deleted from the database
4. NFT becomes soulbound — transfers are permanently blocked at the contract level

Mint NFT (commitmentHash) → Claim Key (encrypt to wallet) → Soulbound ✓

## Tech Stack

| Layer          | Technology                                                 |
| -------------- | ---------------------------------------------------------- |
| Smart Contract | Solidity, Foundry, OpenZeppelin                            |
| Frontend       | Next.js, Scaffold-ETH 2, RainbowKit, Wagmi, Viem           |
| Backend / DB   | Next.js API routes, PostgreSQL (Neon)                      |
| Encryption     | AES-256 (server-side), x25519-xsalsa20-poly1305 (MetaMask) |
| Payments       | ETH, USDT, USDC                                            |

## Contract

- Network: Ethereum Sepolia testnet
- Standard: ERC-721 + ERC-2981
- License: AGPL-3.0-only

## Local Setup

```bash
# 1. Install dependencies
yarn install

# 2. Copy environment variables
cp .env.example .env.local
# Fill in: ENCRYPTION_KEY, DATABASE_URL, NEXT_PUBLIC_*

# 3. Start local chain
yarn chain

# 4. Deploy contracts (new terminal)
yarn deploy

# 5. Start frontend (new terminal)
yarn start
```

Visit: http://localhost:3000
Environment Variables

```
ENCRYPTION_KEY=        # AES-256 key — must match Vercel deployment exactly
DATABASE_URL=          # Neon PostgreSQL connection string
```

> ⚠️ Never rotate ENCRYPTION_KEY without migrating all existing DB records first.
> Generate CD keys via /admin only after setting this variable.

Testing

```
yarn foundry:test
# or
forge test --match-path test/SoulKey.t.sol -vv
```

License

AGPL-3.0-only — see [LICENSE](https://github.com/Azshken/SoulKey?tab=AGPL-3.0-1-ov-file)

Built with [Scaffold-ETH 2](https://scaffoldeth.io)

Please see [CONTRIBUTING.MD](https://github.com/scaffold-eth/scaffold-eth-2/blob/main/CONTRIBUTING.md) for more information and guidelines for contributing to Scaffold-ETH 2.
