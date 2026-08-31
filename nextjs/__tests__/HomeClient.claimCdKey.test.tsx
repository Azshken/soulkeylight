/**
 * Tests for handleClaimCDKey in app/page.tsx
 *
 * Focus: the atomicity fix — /api/redeem/confirm is only called when the
 * on-chain tx actually succeeded (receipt.status === 'success').
 *
 * Wagmi hooks and window.ethereum are fully mocked — no RPC calls are made.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

const mockWriteContractAsync       = vi.fn();
const mockWaitForTransactionReceipt = vi.fn();
const mockRefetchClaimTimestamp    = vi.fn();

vi.mock('wagmi', () => ({
  useAccount:       vi.fn(),
  usePublicClient:  vi.fn(),
  useWriteContract: vi.fn(),
  useReadContract:  vi.fn(),
  useReadContracts: vi.fn(),
}));

import * as wagmi from 'wagmi';
import Home from '@/app/page';

const MOCK_ADDRESS  = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`;
const MOCK_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as `0x${string}`;
const MOCK_TX_HASH  = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const MOCK_TOKEN_ID = 1;
const MOCK_PERSONAL_SIGN = '0x' + 'ab'.repeat(32) + '01';

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
      token_ids:         [MOCK_TOKEN_ID],
    },
  ],
};

const MOCK_REDEEM_RESPONSE = {
  success:        true,
  cdkeyId:        '42',
  encryptedCDKey: '0x' + 'ef'.repeat(64),
  commitmentHash: '0x' + 'aa'.repeat(32),
};

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

  vi.mocked(wagmi.useReadContracts).mockReturnValue({
    data: [
      { result: BigInt('10000000000000000') },
      { result: BigInt('2500000') },
      { result: 5n },
      { result: 100n },
    ],
    isLoading: false,
  } as any);
}

function setupFetchMocks(overrides: { redeemConfirm?: object } = {}) {
  const confirmResponse = overrides.redeemConfirm ?? { success: true };

  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/products')) {
      return Promise.resolve({
        ok:   true,
        json: () => Promise.resolve({ success: true, products: [MOCK_PRODUCT] }),
      });
    }
    if (url.includes('/api/library')) {
      return Promise.resolve({
        ok:   true,
        json: () => Promise.resolve(MOCK_LIBRARY_RESPONSE),
      });
    }
    if (url.includes('/api/redeem/confirm')) {
      return Promise.resolve({
        ok:   (confirmResponse as any).success !== false,
        json: () => Promise.resolve(confirmResponse),
      });
    }
    if (url.includes('/api/redeem')) {
      return Promise.resolve({
        ok:   true,
        json: () => Promise.resolve(MOCK_REDEEM_RESPONSE),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
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

beforeEach(() => {
  vi.clearAllMocks();
  setupEthereumMock();
});

describe('handleClaimCDKey — receipt status check (atomicity fix)', () => {

  it('calls /api/redeem/confirm when receipt.status is "success"', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWriteContractAsync.mockResolvedValue(MOCK_TX_HASH);
    mockWaitForTransactionReceipt.mockResolvedValue({
      status:      'success',
      blockNumber: 12345n,
      logs:        [],
    });
    mockRefetchClaimTimestamp.mockResolvedValue({});

    render(<Home />);

    const claimBtn = await screen.findByRole('button', { name: /claim cd key/i });
    await userEvent.click(claimBtn);

    await waitFor(() => {
      const calls = vi.mocked(global.fetch).mock.calls.map(([url]) => url as string);
      expect(calls.some(url => url.includes('/api/redeem/confirm'))).toBe(true);
    });

    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('CD key claimed'),
    );
  });

  it('does NOT call /api/redeem/confirm when receipt.status is "reverted"', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWriteContractAsync.mockResolvedValue(MOCK_TX_HASH);
    mockWaitForTransactionReceipt.mockResolvedValue({
      status:      'reverted',
      blockNumber: 12345n,
      logs:        [],
    });

    render(<Home />);

    const claimBtn = await screen.findByRole('button', { name: /claim cd key/i });
    await userEvent.click(claimBtn);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('reverted'),
      );
    });

    const calls = vi.mocked(global.fetch).mock.calls.map(([url]) => url as string);
    expect(calls.some(url => url.includes('/api/redeem/confirm'))).toBe(false);
  });

  it('does NOT call /api/redeem/confirm when writeContractAsync throws (user rejection)', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWriteContractAsync.mockRejectedValue(
      Object.assign(new Error('User rejected the request'), { code: 4001 }),
    );

    render(<Home />);

    const claimBtn = await screen.findByRole('button', { name: /claim cd key/i });
    await userEvent.click(claimBtn);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });

    const calls = vi.mocked(global.fetch).mock.calls.map(([url]) => url as string);
    expect(calls.some(url => url.includes('/api/redeem/confirm'))).toBe(false);
  });

  it('does NOT call /api/redeem/confirm when /api/redeem itself fails', async () => {
    setupWagmiMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/products')) {
        return Promise.resolve({
          ok:   true,
          json: () => Promise.resolve({ success: true, products: [MOCK_PRODUCT] }),
        });
      }
      if (url.includes('/api/library')) {
        return Promise.resolve({
          ok:   true,
          json: () => Promise.resolve(MOCK_LIBRARY_RESPONSE),
        });
      }
      if (url.includes('/api/redeem/confirm')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      }
      if (url.includes('/api/redeem')) {
        return Promise.resolve({
          ok:   false,
          json: () => Promise.resolve({ success: false, error: 'No key available' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<Home />);

    const claimBtn = await screen.findByRole('button', { name: /claim cd key/i });
    await userEvent.click(claimBtn);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('No key available'),
      );
    });

    expect(mockWriteContractAsync).not.toHaveBeenCalled();
    const calls = vi.mocked(global.fetch).mock.calls.map(([url]) => url as string);
    expect(calls.some(url => url.includes('/api/redeem/confirm'))).toBe(false);
  });
});

describe('handleClaimCDKey — guard conditions', () => {

  it('does not render the Claim button when wallet is not connected', async () => {
    vi.mocked(wagmi.useAccount).mockReturnValue({ address: undefined, isConnected: false } as any);
    vi.mocked(wagmi.usePublicClient).mockReturnValue(undefined as any);
    vi.mocked(wagmi.useWriteContract).mockReturnValue({ writeContractAsync: mockWriteContractAsync } as any);
    vi.mocked(wagmi.useReadContract).mockReturnValue({ data: 0n, refetch: vi.fn() } as any);
    vi.mocked(wagmi.useReadContracts).mockReturnValue({ data: [], isLoading: false } as any);
    setupFetchMocks();

    render(<Home />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /claim cd key/i })).not.toBeInTheDocument();
    });

    expect(mockWriteContractAsync).not.toHaveBeenCalled();
  });

  it('does not render the Claim button when token is already claimed', async () => {
    setupWagmiMocks({ claimTimestamp: 1_700_000_000n });
    setupFetchMocks();

    render(<Home />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /claim cd key/i })).not.toBeInTheDocument();
    });

    expect(await screen.findByRole('button', { name: /reveal cd key/i })).toBeInTheDocument();
  });
});

describe('handleClaimCDKey — loading state feedback', () => {

  it('shows a step label and spinner in the button while the tx is pending', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWriteContractAsync.mockResolvedValue(MOCK_TX_HASH);
    mockWaitForTransactionReceipt.mockImplementation(() => new Promise(() => {}));

    render(<Home />);

    const claimBtn = await screen.findByRole('button', { name: /claim cd key/i });
    await userEvent.click(claimBtn);

    const stepLabels = await screen.findAllByText(/waiting for claim confirmation/i);
    expect(stepLabels.length).toBeGreaterThan(0);

    expect(
      screen.queryByRole('button', { name: /\u{1F511} Claim CD Key \u2014 Makes NFT Soulbound/u }),
    ).not.toBeInTheDocument();

    expect(document.querySelector('.loading.loading-spinner')).toBeInTheDocument();
  });
});
