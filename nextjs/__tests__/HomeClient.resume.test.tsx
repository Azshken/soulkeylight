/**
 * Tests for the refresh-resume lifecycle of in-flight mint/claim/refund txs.
 *
 * Focus:
 *  1. Each flow saves a PendingTx record the moment the wallet returns a txHash
 *     and clears it only after the server-side DB write succeeded.
 *  2. On mount, a record left behind by a page refresh is resumed: the receipt
 *     is re-fetched and the missing DB step (link-token / confirm / refund) is
 *     completed, then the record is cleared.
 *  3. Guard regressions: a reverted refund is NEVER recorded in the DB, and a
 *     record belonging to a different wallet is never resumed.
 *
 * Wagmi hooks, fetch and window.ethereum are fully mocked — no RPC or DB needed.
 * The receipt logs are real ABI encodings (viem encodeEventTopics /
 * encodeAbiParameters) so decodeEventLog runs for real.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { encodeAbiParameters, encodeEventTopics } from 'viem';

const mockWriteContractAsync        = vi.fn();
const mockWaitForTransactionReceipt = vi.fn();
const mockRefetchClaimTimestamp     = vi.fn();

vi.mock('wagmi', () => ({
  useAccount:       vi.fn(),
  usePublicClient:  vi.fn(),
  useWriteContract: vi.fn(),
  useReadContract:  vi.fn(),
  useReadContracts: vi.fn(),
}));

import * as wagmi from 'wagmi';
import { SOULKEY_ABI, VAULT_ABI } from '@/utils/abis';
import { loadPendingTx, savePendingTx } from '@/utils/pendingTx';

const MOCK_ADDRESS    = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`;
const MOCK_CONTRACT   = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as `0x${string}`;
const MOCK_VAULT      = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as `0x${string}`;
const MOCK_USDC       = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`;
const OTHER_WALLET    = ('0x' + 'cc'.repeat(20)) as `0x${string}`;
const MOCK_TX_HASH    = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const COMMITMENT_HASH = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const ZERO_ADDRESS    = '0x0000000000000000000000000000000000000000';
// 65 bytes (r || s || v) — deriveX25519SecretFromSignature rejects anything else.
const MOCK_PERSONAL_SIGN = '0x' + 'ab'.repeat(64) + '01';

const MOCK_PRODUCT = {
  product_id:       1,
  contract_address: MOCK_CONTRACT,
  name:             'Test Game',
  genre:            'Action',
  description:      'A test game.',
  image_cid:        null,
};

const MOCK_LIBRARY_RESPONSE = {
  success: true,
  games: [
    {
      product_id:        1,
      contract_address:  MOCK_CONTRACT,
      name:              'Test Game',
      genre:             'Action',
      description:       'A test game.',
      image_cid:         null,
      image_claimed_cid: null,
      is_active:         true,
      token_ids:         [1],
    },
  ],
};

const MOCK_REDEEM_RESPONSE = {
  success:        true,
  cdkeyId:        '42',
  encryptedCDKey: '0x' + 'ef'.repeat(64),
  commitmentHash: COMMITMENT_HASH,
};

// HomeClient captures NEXT_PUBLIC_VAULT_ADDRESS at module scope — set the env
// BEFORE the (dynamic) import below or every refund path short-circuits.
let Home: React.ComponentType = () => null;
beforeAll(async () => {
  process.env.NEXT_PUBLIC_VAULT_ADDRESS = MOCK_VAULT;
  Home = (await import('@/app/HomeClient')).default;
});
afterAll(() => {
  delete process.env.NEXT_PUBLIC_VAULT_ADDRESS;
});

// ── Receipt log builders — real ABI encodings ────────────────────────────────

function mockReceipt(status: 'success' | 'reverted', logs: unknown[] = [], blockNumber = 12345n) {
  return { status, logs, blockNumber };
}

function transferLog(tokenId: bigint, to: `0x${string}` = MOCK_ADDRESS) {
  return {
    data: '0x',
    topics: encodeEventTopics({
      abi: SOULKEY_ABI,
      eventName: 'Transfer',
      args: { from: ZERO_ADDRESS as `0x${string}`, to, tokenId },
    }),
  };
}

function nftMintedLog(tokenId: bigint, paymentToken: `0x${string}` = MOCK_USDC) {
  return {
    data: encodeAbiParameters([{ type: 'bytes32' }], [COMMITMENT_HASH]),
    topics: encodeEventTopics({
      abi: SOULKEY_ABI,
      eventName: 'NFTMinted',
      args: { tokenId, minter: MOCK_ADDRESS, paymentToken },
    }),
  };
}

function refundIssuedLog(
  tokenId: bigint,
  refundedAmount = 950n,
  feeRetained = 50n,
  paymentToken: `0x${string}` = MOCK_USDC,
) {
  return {
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'string' }],
      [paymentToken, refundedAmount, feeRetained, 'changed my mind'],
    ),
    topics: encodeEventTopics({
      abi: VAULT_ABI,
      eventName: 'RefundIssued',
      args: { soulKeyContract: MOCK_CONTRACT, tokenId, recipient: MOCK_ADDRESS },
    }),
  };
}

// ── Mock plumbing ─────────────────────────────────────────────────────────────

function setupWagmiMocks({ claimTimestamp = 0n }: { claimTimestamp?: bigint } = {}) {
  vi.mocked(wagmi.useAccount).mockReturnValue({
    address:     MOCK_ADDRESS,
    isConnected: true,
  } as any);

  vi.mocked(wagmi.usePublicClient).mockReturnValue({
    waitForTransactionReceipt: mockWaitForTransactionReceipt,
    readContract:              vi.fn().mockResolvedValue('0x'),
  } as any);

  vi.mocked(wagmi.useWriteContract).mockReturnValue({
    writeContractAsync: mockWriteContractAsync,
  } as any);

  vi.mocked(wagmi.useReadContract).mockReturnValue({
    data:    claimTimestamp,
    refetch: mockRefetchClaimTimestamp,
  } as any);

  // One mock serves BOTH useReadContracts call sites (prices/supply and refund
  // reads): [0] doubles as mintPriceETH and a truthy isRefundable, [1] as
  // mintPriceUSD (paymentRecord?.[1] on a bigint is undefined → paidAt unset).
  vi.mocked(wagmi.useReadContracts).mockReturnValue({
    data: [
      { result: 10000000000000000n },
      { result: 2500000n },
      { result: 5n },
      { result: 100n },
    ],
    isLoading: false,
  } as any);
}

function setupFetchMocks(overrides: { linkToken?: object; confirm?: object; refund?: object } = {}) {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    const json = (body: object) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    if (url.includes('/api/products')) return json({ success: true, products: [MOCK_PRODUCT] });
    if (url.includes('/api/library')) return json(MOCK_LIBRARY_RESPONSE);
    if (url.includes('/api/mint/get-commitment')) return json({ success: true, commitmentHash: COMMITMENT_HASH });
    if (url.includes('/api/mint/link-token')) return json(overrides.linkToken ?? { success: true });
    // confirm BEFORE redeem — substring ordering matters
    if (url.includes('/api/redeem/confirm')) return json(overrides.confirm ?? { success: true });
    if (url.includes('/api/redeem')) return json(MOCK_REDEEM_RESPONSE);
    if (url.includes('/api/refund')) return json(overrides.refund ?? { success: true, cdkeyId: 7 });
    return json({});
  });
}

function setupEthereumMock() {
  Object.defineProperty(window, 'ethereum', {
    value: {
      request: vi.fn().mockImplementation(({ method }: { method: string }) => {
        if (method === 'personal_sign') return Promise.resolve(MOCK_PERSONAL_SIGN);
        return Promise.reject(new Error(`Unknown method: ${method}`));
      }),
    },
    writable:     true,
    configurable: true,
  });
}

function fetchCalls(urlPart: string) {
  return vi
    .mocked(global.fetch)
    .mock.calls.filter(([u]) => (u as string).includes(urlPart));
}

function lastBody(urlPart: string): any {
  const calls = fetchCalls(urlPart);
  const call = calls[calls.length - 1];
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  setupEthereumMock();
});

// ── 1. Record lifecycle inside the live flows ────────────────────────────────

describe('pending record lifecycle during live flows', () => {

  it('mint: saves the record once the wallet returns a txHash, before the receipt', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWriteContractAsync.mockResolvedValue(MOCK_TX_HASH);
    mockWaitForTransactionReceipt.mockReturnValue(new Promise(() => {})); // stays in flight

    render(<Home />);
    await userEvent.click(await screen.findByRole('button', { name: /mint with eth/i }));

    await waitFor(() => expect(loadPendingTx()?.kind).toBe('mint'));
    const pending = loadPendingTx() as any;
    expect(pending.txHash).toBe(MOCK_TX_HASH);
    expect(pending.wallet).toBe(MOCK_ADDRESS);
    expect(pending.contractAddress).toBe(MOCK_CONTRACT);
    expect(pending.commitmentHash).toBe(COMMITMENT_HASH);
    expect(pending.payment).toBe('ETH');
    expect(pending.paymentAmount).toBe('10000000000000000');
  });

  it('mint: clears the record after link-token succeeds', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWriteContractAsync.mockResolvedValue(MOCK_TX_HASH);
    mockWaitForTransactionReceipt.mockResolvedValue(
      mockReceipt('success', [transferLog(7n), nftMintedLog(7n)]),
    );
    mockRefetchClaimTimestamp.mockResolvedValue({});

    render(<Home />);
    await userEvent.click(await screen.findByRole('button', { name: /mint with eth/i }));

    await waitFor(() => expect(fetchCalls('/api/mint/link-token').length).toBe(1));
    const body = lastBody('/api/mint/link-token');
    expect(body).toMatchObject({
      tokenId:         '7',
      walletAddress:   MOCK_ADDRESS,
      txHash:          MOCK_TX_HASH,
      blockNumber:     '12345',
      paymentAmount:   '10000000000000000',
      contractAddress: MOCK_CONTRACT,
      commitmentHash:  COMMITMENT_HASH,
    });
    expect(body.paymentToken.toLowerCase()).toBe(MOCK_USDC.toLowerCase());
    await waitFor(() => expect(loadPendingTx()).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('NFT minted'));
  });

  it('claim: clears the record after redeem/confirm succeeds', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWriteContractAsync.mockResolvedValue(MOCK_TX_HASH);
    mockWaitForTransactionReceipt.mockResolvedValue(mockReceipt('success'));
    mockRefetchClaimTimestamp.mockResolvedValue({});

    render(<Home />);
    await userEvent.click(await screen.findByRole('button', { name: /claim cd key/i }));

    await waitFor(() => expect(fetchCalls('/api/redeem/confirm').length).toBe(1));
    await waitFor(() => expect(loadPendingTx()).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('CD key claimed'));
  });

  it('claim: KEEPS the record when the server confirm fails (resume will retry)', async () => {
    setupWagmiMocks();
    setupFetchMocks({ confirm: { success: false, error: 'db unreachable' } });
    mockWriteContractAsync.mockResolvedValue(MOCK_TX_HASH);
    mockWaitForTransactionReceipt.mockResolvedValue(mockReceipt('success'));
    mockRefetchClaimTimestamp.mockResolvedValue({});

    render(<Home />);
    await userEvent.click(await screen.findByRole('button', { name: /claim cd key/i }));

    await waitFor(() => expect(fetchCalls('/api/redeem/confirm').length).toBe(1));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('server record failed'),
    ));
    const pending = loadPendingTx() as any;
    expect(pending?.kind).toBe('claim');
    expect(pending.txHash).toBe(MOCK_TX_HASH);
    expect(pending.cdkeyId).toBe(42);
    expect(pending.tokenId).toBe('1');
  });

  it('refund: does NOT record a reverted refund and clears the record (guard regression)', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWriteContractAsync.mockResolvedValue(MOCK_TX_HASH);
    mockWaitForTransactionReceipt.mockResolvedValue(mockReceipt('reverted'));

    render(<Home />);
    await userEvent.click(await screen.findByRole('button', { name: /request refund/i }));
    await userEvent.click(await screen.findByRole('button', { name: /confirm refund/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('reverted'),
    ));
    // Without the receipt.status guard the reverted tx would POST zero amounts
    // and hide a still-live token from the library.
    expect(fetchCalls('/api/refund').length).toBe(0);
    expect(loadPendingTx()).toBeNull();
  });
});

// ── 2. Resume on page load ───────────────────────────────────────────────────

describe('resume of a pending record left by a page refresh', () => {

  it('mint: re-reads the receipt and completes link-token, then clears', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWaitForTransactionReceipt.mockResolvedValue(
      mockReceipt('success', [transferLog(7n), nftMintedLog(7n)]),
    );
    mockRefetchClaimTimestamp.mockResolvedValue({});
    savePendingTx({
      kind: 'mint',
      txHash: MOCK_TX_HASH,
      wallet: MOCK_ADDRESS,
      contractAddress: MOCK_CONTRACT,
      commitmentHash: COMMITMENT_HASH,
      payment: 'ETH',
      paymentAmount: '10000000000000000',
    });

    render(<Home />);

    await waitFor(() => expect(fetchCalls('/api/mint/link-token').length).toBe(1));
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: MOCK_TX_HASH }),
    );
    const body = lastBody('/api/mint/link-token');
    expect(body).toMatchObject({
      tokenId:         '7',
      walletAddress:   MOCK_ADDRESS,
      txHash:          MOCK_TX_HASH,
      blockNumber:     '12345',
      paymentAmount:   '10000000000000000',
      contractAddress: MOCK_CONTRACT,
      commitmentHash:  COMMITMENT_HASH,
    });
    expect(body.paymentToken.toLowerCase()).toBe(MOCK_USDC.toLowerCase());
    await waitFor(() => expect(loadPendingTx()).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('Pending mint recovered'),
    );
  });

  it('claim: completes redeem/confirm from the stored record, then clears', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWaitForTransactionReceipt.mockResolvedValue(mockReceipt('success'));
    mockRefetchClaimTimestamp.mockResolvedValue({});
    savePendingTx({
      kind: 'claim',
      txHash: MOCK_TX_HASH,
      wallet: MOCK_ADDRESS,
      contractAddress: MOCK_CONTRACT,
      tokenId: '1',
      cdkeyId: 42,
    });

    render(<Home />);

    await waitFor(() => expect(fetchCalls('/api/redeem/confirm').length).toBe(1));
    expect(lastBody('/api/redeem/confirm')).toMatchObject({
      cdkeyId:         42,
      userAddress:     MOCK_ADDRESS,
      txHash:          MOCK_TX_HASH,
      blockNumber:     '12345',
      contractAddress: MOCK_CONTRACT,
      tokenId:         '1',
    });
    await waitFor(() => expect(loadPendingTx()).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('Pending claim recovered'),
    );
  });

  it('refund: records the refund from receipt logs, then clears', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWaitForTransactionReceipt.mockResolvedValue(
      mockReceipt('success', [refundIssuedLog(1n)]),
    );
    savePendingTx({
      kind: 'refund',
      txHash: MOCK_TX_HASH,
      wallet: MOCK_ADDRESS,
      contractAddress: MOCK_CONTRACT,
      tokenId: '1',
      refundReason: 'changed my mind',
    });

    render(<Home />);

    await waitFor(() => expect(fetchCalls('/api/refund').length).toBe(1));
    const body = lastBody('/api/refund');
    expect(body).toMatchObject({
      contractAddress: MOCK_CONTRACT,
      tokenId:         '1',
      refundedBy:      MOCK_ADDRESS,
      refundReason:    'changed my mind',
      refundTxHash:    MOCK_TX_HASH,
      blockNumber:     '12345',
      refundedAmount:  '950',
      feeRetained:     '50',
    });
    expect(body.paymentToken.toLowerCase()).toBe(MOCK_USDC.toLowerCase());
    await waitFor(() => expect(loadPendingTx()).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('Pending refund recorded'),
    );
  });

  it('does NOT resume a record that belongs to a different wallet', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWaitForTransactionReceipt.mockResolvedValue(mockReceipt('success'));
    savePendingTx({
      kind: 'mint',
      txHash: MOCK_TX_HASH,
      wallet: OTHER_WALLET,
      contractAddress: MOCK_CONTRACT,
      commitmentHash: COMMITMENT_HASH,
      payment: 'ETH',
      paymentAmount: '10000000000000000',
    });

    render(<Home />);

    // Let mount effects settle (library fetch resolves) — the resume effect has
    // had every chance to run by the time the products UI is up.
    await screen.findByRole('button', { name: /mint with eth/i });
    await waitFor(() => expect(fetchCalls('/api/library').length).toBeGreaterThan(0));
    expect(mockWaitForTransactionReceipt).not.toHaveBeenCalled();
    expect(fetchCalls('/api/mint/link-token').length).toBe(0);
    expect(loadPendingTx()?.wallet).toBe(OTHER_WALLET); // record preserved for its owner
  });

  it('clears the record without any DB call when the pending tx reverted', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWaitForTransactionReceipt.mockResolvedValue(mockReceipt('reverted'));
    savePendingTx({
      kind: 'mint',
      txHash: MOCK_TX_HASH,
      wallet: MOCK_ADDRESS,
      contractAddress: MOCK_CONTRACT,
      commitmentHash: COMMITMENT_HASH,
      payment: 'ETH',
      paymentAmount: '10000000000000000',
    });

    render(<Home />);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('reverted'),
    ));
    expect(fetchCalls('/api/mint/link-token').length).toBe(0);
    expect(loadPendingTx()).toBeNull();
  });

  it('KEEPS the record when the receipt wait times out (retried on next load)', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWaitForTransactionReceipt.mockRejectedValue(
      Object.assign(new Error('Timed out while waiting for transaction'), {
        name: 'TimeoutError',
      }),
    );
    savePendingTx({
      kind: 'mint',
      txHash: MOCK_TX_HASH,
      wallet: MOCK_ADDRESS,
      contractAddress: MOCK_CONTRACT,
      commitmentHash: COMMITMENT_HASH,
      payment: 'ETH',
      paymentAmount: '10000000000000000',
    });

    render(<Home />);

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('retry when you refresh'),
    ));
    expect(fetchCalls('/api/mint/link-token').length).toBe(0);
    expect(loadPendingTx()?.txHash).toBe(MOCK_TX_HASH);
  });
});
