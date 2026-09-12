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

31/04/26

- Fixed the failed on-chain claim TX deleted a CD key in databas
- Added nextjs tests
- Deleted CDKeyEncryption.ts component it was an relic from previous implementations

01/03/26

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