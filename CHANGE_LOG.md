13/03/26

- Added frozen_metadata_cid into the redemptions table
- Added frozenmetadata into confirm/routes.ts
- Added PINATA_JWT to Vercel environments
- Added API route to check for frozen CID first and redirect to IPFS if found
- Fixed the read from attributes products table insertion
- Fixed the app/page ui didn't read the tokens in the wallet

14/03/26

- Fixed the refund issue.
- Deployed a second game contract.

16/03/26

- app/page.tsx new render and handlers - ui overhaul
- Added EIP-4906 support to SoulKey.sol
- Changed the image_cid to image_claimed_cid when building the frozen_metadata (confirm/route.ts)

19/03/26

- utils/db.ts changed so it checks refunds table for available keys.
- Added index: CREATE INDEX idx_cdkeys_batch_created ON cd_keys(batch_id, created_at ASC);
- [tokenID]/route.ts changed the RPC call to DB call.
- Added is_active to products table.
- Added deregister game to /admin page.
- Added a game selector to 'Your Library' section of the app/ page

23/03/26

- Deployed a new SoulKey contract.
- Uploaded a new Pinata game image and metadata.
- Removed the scaffold-eth 2 components, hooks and dependencies.
- Changed the layout and the components to use viem, rainbowkit directly
- Installed sonner/toast for error messages
- Debugged the indexedDB error (wagmi SSR) and the yarn installing on Vercel.

24/03/26

- Finally fixed the indexedDB and the yarn install errors.

25/03/26

- Re-initialized the whole project without the scaffold-eth, purely just by creating a foundry and nextjs directories. 

27/03/26

- Automatic generate-keys was changed to a manual import-keys
- Fixed duplicate key entries in database
- Fixed phantom duplicate counting

31/03/26

- Fixed the failed on-chain claim TX deleted a CD key in databas
- Added nextjs tests
- Deleted CDKeyEncryption.ts component it was an relic from previous implementations

01/04/26

- Changed viem.verifyMessage to SIWE
- Added tests

12/09/26

- In-flight mint/claim/refund txs now survive a page refresh:
  - utils/pendingTx.ts (sessionStorage) record saved the moment the wallet returns a txHash; cleared only after the server DB write succeeds
  - HomeClient resume-on-load effect finishes link-token / redeem-confirm / refund from the tx receipt
  - /api/refund made idempotent on refund_tx_hash so resume retries are safe
- Fixed: a reverted refund tx is no longer recorded in the DB (previously wrote a 0-amount refund row and hid a live token)
- Fixed: reverted mint tx now reports a clear error instead of "Could not extract token ID"
- Fixed: claim-flow test mock now returns a real 65-byte personal_sign signature (was 33 bytes — 4 tests failing at baseline); CLAUDE.md example corrected
- Added __tests__/HomeClient.resume.test.tsx — 11 tests (record lifecycle, resume per kind, wallet mismatch, revert, timeout). Suite: 63 tests / 7 files

12/09/26 — crypto & supply (feat/crypto-and-supply)

- Mint cap fixed in SoulKey.sol: gate now counts lifetime mints minus UNCLAIMED refund burns
  (_refundBurnedCount); burning a claimed token no longer frees a slot (totalSupply() used to
  subtract it while commitmentInUse stayed set). setMaxSupply lower bound uses the same figure.
  Existing Sepolia bytecode is immutable — future deployments only. Foundry: 98/98 including the
  new mint-cap tests.
- Neon at-rest encryption: new cd_keys.encrypted_key writes are AES-256-GCM
  ("v2gcm:iv:ct:tag"); legacy ivHex:ctHex CBC rows still decrypt; tamper throws. Same
  ENCRYPTION_KEY, no rotation, no rewrite job.
- Confirmed claims now DELETE cd_keys.encrypted_key — clearEncryptedKey restored as the last
  /api/redeem/confirm step (after receipt success + claimTimestamp>0 + confirmRedemption).
  Failed claims keep the row. No v1→v2 migration; first public deploy is production.
- On-chain claim ciphertext v2 = X-Wing (ML-KEM-768 + X25519) via @noble/post-quantum 0.7.1
  (pinned): 0x02 || xwingCt(1120) || nonce(12) || tag(16) || aesCt, AES-256-GCM keyed by the
  32-byte X-Wing shared secret. Seed = HKDF-SHA256(full 65-byte personal_sign, salt
  "soulkey-xwing-v2", 32). Reveal dual-reads v1/v2; one personal_sign derives both keypairs.
  /api/redeem prefers xwingPublicKey, still accepts legacy x25519PublicKey (deploy skew).
- Supersedes DECISIONS.md (April): HKDF length-96 v2 expansion and AES-copy retention are dead.
- Local env repaired: nextjs pnpm-lock.yaml regenerated (was stale), build green again,
  81/81 tests (9 files) + tsc clean.

12/09/26 — inventory & metadata (feat/inventory-and-metadata)

- Inventory: every availability SELECT (reserveCDKeyForWallet ×2, getAvailableKeyCount,
  reserveAndMint key pick) now requires ck.encrypted_key IS NOT NULL — keys released by a
  confirmed claim (clearEncryptedKey) can never be offered again; their commitmentInUse stays
  set on-chain, so re-minting them would revert. The mint_tx_hash idempotency lookup in
  reserveAndMint is deliberately unfiltered (link-token retries must still resolve).
- /api/refund: confirmed-claim tokens 409 ("Token already claimed; refunds are not recorded")
  — DB mirror of the on-chain ReleasedByClaim non-refundability. The refund tx receipt is
  verified via ALCHEMY_RPC_URL (hardcoded sepolia client, same pattern as confirm) BEFORE the
  append-only insert; missing/reverted → 400. refund_tx_hash idempotency still short-circuits
  first. Refunds stay append-only; no on-chain ReserveStatus read.
- tokenURI (/api/nft/[contractAddress]/[tokenId]): frozen-CID lookup is contract-scoped — it
  keyed on mints.token_id alone, which is unique only PER GAME (token #1 of game A could 301
  to game B's frozen metadata). Dynamic JSON now serves image_claimed_cid when claimed with
  image_cid fallback (same rule as the confirm Pinata payload). 301 + short Cache-Control
  unchanged.
- Deleted nextjs/package-lock.json — pnpm-lock.yaml is the only lockfile.
- Tests: +7 refund route, +4 db availability SQL, +6 nft metadata. Suite: 98 tests / 12
  files; tsc clean.

13/09/26 — production smoke

- Vercel production Ready on main 4f4ce4c (soulkey.vercel.app). Install log still ran
  `npm install` (peer warnings only); pin packageManager + Vercel Install Command next.
- Full loop on Ethereum Sepolia: mint → refresh-resume → X-Wing claim → reveal → claimed
  refund reverted on-chain. Unclaimed refund + remint OK. New import batch is v2gcm.
- claimCdKey gas measured: 946,011 (tx 0x2f27049e71c13ae2d6637078707ad7acb615b387ce98d66c15342ee444cb2991,
  token 51, game 0x872952D3a86e0cBd8E56aF38f73bce1A28D356EF). Higher than the 800k guess;
  fine on L2, not a reason to stay on Ethereum L1.

23/09/26

- docs/OPEN_ISSUES.md rewritten to current state: DONE items removed from Medium; claim gas
  ticked; remaining work is pnpm pin, SoulKey redeploy, chain helper, Alchemy, AES rotation.
