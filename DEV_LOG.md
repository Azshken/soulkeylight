START_OF_DEVELOPMENT

- I've had this idea of the NFT game keys in my head for longer time, however I've lacked the expertise to realize it.
  I've decided to use Claude Sonnet 4.5(now 4.6) thinking model to help me develop it (It's finally getting usable).
  Project development space on [perplexity](https://www.perplexity.ai/search/yarn-start-found-lockfile-miss-PW9.XhYZRzWs0LeW4s1XjA#0).

6/02/2026

- I've set up VSCode + WSL, foundry dev environment,
- developed the first implementation of the smart contract.

07/02/2026

- I've set up the deployment on foundry; spun up a wallet; found a testnet with UDST&USDC (Sepolia Arbitrum); I've got some testnet ETH through Alchemy.

8/02/2026

- I'm migrating to desktop PC because the laptop will be slow with Scaffold-ETH-2 (react front end) running.
- I'm creating a new Github repo NFTGames where I'll continue logging and developing the project -- I'm using foundry for smart contract development/testing. Scaffold-ETH-2 as frontend for fast iterations and testing. Vercel as a hosting service with PostgreSQL (neon) as a database.

9/02/2026

- I've developed the front end tested the mint functions.

10-15/02/2026

- I was building the database and figuring out how to connect the front end with the database.
- Created pinata account for IPFS hosting for NFT pictures and metadata.

16/02/2026
-Today I've made a functional database for CD keys and I can generate and populate the tables. Recording the time of generation, redemption and tracking is_redeemed (true/false). The CD keys in the database are hashed (for verification) and encrypted for security.

- The front end is running, communicating with the backend (DB) through Vercel and neon serverless database. Previously I could mint from the front end by providing the cdkeyHash. Now I need make it that the hash is coming from the DB as well as the redemption decryption/encryption and modification of the NFT.

17-18/02/2026
Refactoring the code:

- Implementing merkletrees to prevent frontrunning the minting of the commitmentHashes.
- Removing mintAndClaim function due to security issues -- doing the commitmentHash and the keyEncryption in one transaction
- Renamed DeleteNFT to burn as it fits better to naming conventions
- Added NFT URI. I'm using pinata for IPFS hosting.
- Made some gas optimization changes (pack variables into the same slot)
- Left the Chainlink price feed for the ETH price on later development (using chainlink can complicate things at this stage of development).
- Adjusted the frontend/backend to fit the implementation.
- Reinitialized the code as I'll be working on a laptop, too.

19/02/2026

- I've redeployed the contract on the PC I use different keystore account on PC and the laptop -> I couldn't commit/push the code from laptop without deployment.
- Removed the merkletree safeguard it's redundant. Redeployed the contract and changed the frontend. NOTE: If you edit the .md file on github the Vercel rebuilds the app every time.

20/02/2026

- I'm reading on EIP-712 and troubleshooting why the redeem function doesn't work.

21/02/2026

- Implementing the fixes. Never use NEXT*PUBLIC* for API Keys and secrets in Vercel! The NEXT*PUBLIC* flag makes it available publicly (it's not just a naming convention).
- I'm slowly reducing the reliance on scaffold-eth. Using ALCHEMY_RPC_URL, CONTRACT_ADDRESS variables; trying to not rely on deploydContracts.ts

22/02/2026

- The whole mint-claim-reveal system works!
- Now I need to polish the project.

23/02/26

- I've created the docs website on [gitbook](https://regenfund-dao.gitbook.io/nftgamekeys/).

24/02/26

- Brainstormed about the project's name. It's SoulKey from now on. I've began renaming it. The full rename will be at redeployment of the contract.
- Revisited the database tables, making the tables more clearer and populated correctly. Remodeling the relational DB to be future proof.
- Added new tables for the future batches, products, refunds.
- Thinking about a solution how to implement the refund function.

25/02/26

- Finished the new database Schema. I've learned a critical database design practice for blockchains (Article).
- Worked on the refund function (I can't implement the new schema without the refund function).
- Refund function will be a separate contract (Article).
- Brainstormed about how to share my project with people.
- Made my first post on X.

26/02/26

- Wrote my first article about the schema design for blockchain apps and the bugs that led me to the current design. Published on mirror.xyz and X post.
- I'm conflicted about the use of AI to help me write and polish the article -- it looks more profesional and polished, but it's not fully written by me.

27/02/26

- Worked on the refund function implementation.
- There are more issues than I thought, tomorrow I try to fix them.

28/02/26

- I've finished the refund contract now MasterKeyVault contract.
- I'm updating the documentation webpage.

01/02/26

- MasterKeyVault and SoulKey contracts are bugfree, tested and ready for deployment. Whoa, the refund function made the contracts exponencially harder to develop and fix -- so much so that there are two contracts now. One for the NFT handling and one for fund management.

02/02/26

- I've redone the frontend and all the api/route.ts

03/02/26

- Deployed the contracts
- Normalized and added the tables into the neon database

04/03/26

- Reinitialized the project on my PC and redeployed the contracts (I can't git push from laptop without a deployment, and can't switch the owner without the copying and adding the private keys into wsl).
- Fixing the multiple contracts. As games will be added so will the contract addresses in vercel environment. I'll track them in the DB under products/contract_address and reference the addresses from there (for the frontend). Each registerGame must add an entry into products table.
- Fixed multiple issues.

05/03/26

- Testing
- The scaffold-ETH is breaking my front end witht the baked in contract addresses from the first deployment. Issues with multi-contract project.

06/03/26

- Testing, redoing the front end fixing the issues.
- Slowly removing the scaffolding.
- new abis.ts manual control of the ABI -- It defines exactly which functions and events the frontend needs to talk to, using viem's parseAbi helper to turn human-readable Solidity signatures into the binary format the EVM expects.
- new products/route.ts -- game catalogue. It returns the list of registered games from the database with contract addresses (each game is a separate SoulKey contract). The frontend needs to discover all of them at runtime, not at build time (de-registered games), + Cache-Control.
- new tokens/route.ts, tracks which token an address holds. -- important for RPC querries overload (shows no tokens owned). The route queries the mints table instead (reliable and fast regardless of chain history length), burned NFT never appears in the user's list.

09/03/26

- Removed the useScaffoldReadContract that reads whichever address is in the deployedContracts.ts. This scaffold-eth hook gates the address to the deployed contract that is in deployedContracts.ts and if I deploy multiple contracts it registers only one address. DeployedContracts.ts can be updated only with redeployment of the contract -- a little bit of a headache if you're working on two computers with different wallets.
- Bug fixes, hardening the code and pushing the changes to git.

10/03/26

- Debugging the frontend
- Fixed the admin ui authentication issue of the deployer.
- Users cannot mint.

11/03/26

- Fixed the minting issue
- Adding NFT metadata

12/03/26

- NFT metadata is on pinata and the db is upserted from the metadata when the game registered on the /admin/page
- Architecture design: games metadata is on the static IPFS on pinata (do I need an IPFS for the db entry?). The baseURI is pointing to the application contract address. After claiming the NFT metada bakes in and there will be no more reliance on the DB.

13/03/26

- Prepared the backend for permanent metadata creation on pinata when CD key is claimed.
- Worked on the frontend fixes.
- Created a CHANGELOG.md

14/03/26

- Fixed the refund issue.

16/03/26

- Decided the pinata architecture dynamic or static metadata. I'm staying with static metadat.
- Added a new image with a claimed game watermark. Claim -> frozen_metadata issued.
- Updated the SoulKey.sol to support EIP-4906 (needs redeploy).
- Redesigned the web site.

17/03/26

- Sharing the project.
- Testing and thinking about the design what to fix.

18/03/26

- Chill prepping for fixes.
- Testing, logging bugs.

19/03/26

- Fixed bug: refunded keys were never minted again.
  - utils/db.ts checks refunds table now as well.
  - Changed partial indexing to simpler full index.
- Changed the status check to DB, not an RPC call -> faster by 200-500 ms, less RPC calls.
- Deregistered games doesn't show in products selection, but show up in the user's library
  - Redesigned the user's Game Library, there is a game selection now.
  - Now is_active attribute in products table, tracking game registration
  - Deregister Game option added in /admin page

23/03/26
  
- Deployed a Deus Ex Soulkey with baseURI and metadata to test out multiple game deployments.
- I've removed all the scaffolding and redesigned the Header and the Footer.

24/03/26

- This was a tough one. Fully removed the Scaffold-ETH 2 had problems with yarn installing on Vercel when using npm. 

25/03/26

- Re-initialized the whole project without the scaffold-eth, purely just by creating a foundry and nextjs directories - the project cannot be more lean and snappy than this.
- Most up to date dependecies as possible.

26/03/26

- Fixed the /admin page ui where the Game Setup menu was not showing up correctly.
- /page ui update with larger tabs for game selection. Also game selection is now the Hero section.

27/03/26

- Changed the /admin page key-generation manual key insertion single/batch keys
  - More like the real Game key stores.
- Database bug: Same CD key could be put into the DB multiple times.
  - added a unique constraint on commitmentHash -> new bug: duplicate cd key insertions were incrementing the cdkey_id and the batch_id even if no key was added -> all fixed

29/03/26

- Went through my notes and sessions with perplexity and made Claude memory/context files

31/03/26

- Major bug: when the TX on-chain fails during redemption the backend deletes the key from the database anyways.
  - Separated confirmRedemption and clearEncryptedKey in utils/db.ts
  - Adjusted confirm/route.ts -> verify on-chain first, delete last
- Added nextjs tests.
- Deleted CDKeyEncryption.ts component. No longer needed, the encryption is handled elsewhere.

01/04/26

- Swapped the viem.verigyMessage to SIWE authentication -> tighter security
- Added tests

05/09/26

- Soulkey.sol, game contract -> added a _validatecommit function to check and prevent multiple mints with the same hash.
- Cdkey was reserved forever in the DB after metamask mint cancellation, now expires after 15 mins. (refunds still don't register in the DB when a site is refreshed)

06/09/26

- DB refunded cdkeys are now mintable again.
- Soulkey.sol, totalSupply >= maxSupply -> refunds no longer block maxSupply. Refunds reduce totalSupply.

12/09/26

- Rebuilt the refresh-resume feature properly after the last attempt mangled HomeClient (1317-line deletion, manually reverted 06/09):
  - pendingTx.ts wired into mint/claim/refund; a resume effect finishes the missing DB step from the tx receipt on next page load
  - /api/refund idempotent on refund_tx_hash; reverted refunds no longer recorded in the DB (was a live bug)
- Fixed the 4 failing claim tests — the personal_sign mock was 33 bytes, the X25519 derivation demands the full 65
- 63/63 tests green, tsc clean. Lint and production build fail identically at HEAD — broken root pnpm store (eslint-config-next peer link; missing @x402/* deps of @coinbase/cdp-sdk), not related to these changes

12/09/26 (crypto & supply)

- Shipped post-quantum claims NOW instead of post-grant: X-Wing (ML-KEM-768 + X25519) is the
  default claim cipher — @noble/post-quantum 0.7.1 pinned, no homemade hybrid, no HQC/McEliece.
  On-chain blob is 0x02-prefixed (~1.15 KB). The same single personal_sign feeds both schemes:
  HKDF salt "soulkey-xwing-v2" → 32-byte seed (the KEM expands it internally — the April
  length-96 plan is dead). Reveal dual-reads, so already-claimed Sepolia v1 tokens keep working.
- Killed the v1→v2 migration idea entirely: a confirmed claim now DELETES cd_keys.encrypted_key
  (clearEncryptedKey restored, last confirm step). First public deploy is production.
- Neon at-rest copy moved to AES-256-GCM (v2gcm: prefix); old CBC rows keep decrypting; a
  tampered nibble now throws instead of yielding garbage.
- Fixed the mint-cap accounting in SoulKey.sol: totalSupply() subtracted claimed burns and
  silently freed slots the chain never frees (commitmentInUse stays set). Gate = lifetime mints
  minus refund burns now. Sepolia bytecode is immutable — lands with the next deployment.
- Env: regenerated the stale nextjs lockfile, rebuilt node_modules — build green again, 81/81
  tests, tsc clean. forge test on Fedora: 98/98.

12/09/26 (inventory & metadata)

- Closed the poison-reservation hole end to end: rows released by a confirmed claim
  (encrypted_key NULLed, commitmentInUse still set on-chain) are now filtered out of every
  availability SELECT, and /api/refund refuses confirmed-claim tokens (409) — the DB mirrors
  the vault's ReleasedByClaim state instead of trusting the client or racing the chain.
- /api/refund also fetches the refund receipt itself (same ALCHEMY_RPC_URL pattern as
  confirm) before the append-only insert: a reverted or vanished tx can no longer mark a key
  refundable. The refund_tx_hash idempotency check stays first, so refresh-resume retries
  still converge on success.
- tokenURI had a cross-game collision: the frozen-CID lookup keyed on mints.token_id alone,
  but token IDs restart at 1 per contract — game A's token #1 could 301 to game B's frozen
  metadata. Now joins through products with LOWER(contract_address). Claimed tokens without a
  frozen CID (Pinata failed at claim) get image_claimed_cid in the dynamic JSON, image_cid
  fallback — same rule as the Pinata payload.
- Deleted nextjs/package-lock.json: with both lockfiles tracked, Vercel could pick npm and
  install an untested tree.
- Focused route/db tests instead of HomeClient surgery: +17 (refund guards, availability SQL
  predicates, metadata JSON). Suite 98/98 / 12 files, tsc clean.

13/09/26

- Production Vercel on 4f4ce4c. Smoke-tested the live shop: mint, refresh-resume, X-Wing
  claim, reveal, claimed refund reverted on Etherscan. Unclaimed refund remints. New batch
  encrypts with AES-GCM.
- Claim gas on Sepolia is 946,011 — not the 800k guess. Acceptable on L2.
- Vercel still invoked npm install despite the deleted package-lock. Next: pin packageManager.

23/09/26

- Rewrote docs/OPEN_ISSUES.md. Medium now only lists work that is still open (pnpm pin,
  SoulKey cap redeploy, chain helper, Alchemy, AES rotation, import-keys check).

Notes:

- This type of learning suits me the best (vibe coding). I have ideas in my head and no years of expertise. I can't learn for the sake of learning I hit a wall (because there is so much to know), get quickly demotivated and lose my goal by learning bloat that I may or may not use for my project ideas. With vibe coding I do, then fill up the gaps of knowledge by understanding how the pieces connect and how they work; step by step.

- I need to introduce a changelog (09/03/26)
