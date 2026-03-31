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

// ── Mock wagmi before importing the component ─────────────────────────────────
// vi.mock must be at the top level, before any imports that use the mocked module.

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

// ── Import mocked wagmi + component AFTER vi.mock ─────────────────────────────

import * as wagmi from 'wagmi';
import Home from '@/app/page';

// ─────────────────────────────────────────────────────────────────────────────
// Constants shared across tests
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_ADDRESS  = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`;
const MOCK_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as `0x${string}`;
const MOCK_TX_HASH  = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const MOCK_TOKEN_ID = 1;

/**
 * A non-empty products array is required for the component to render its main
 * UI. An empty array triggers setProductsError(), which replaces the entire
 * page with an error screen — the library section (and Claim button) never
 * mounts.
 */
const MOCK_PRODUCT = {
  product_id:       1,
  contract_address: MOCK_CONTRACT,
  name:             'Test Game',
  genre:            'Action',
  description:      'A test game.',
  image_cid:        null,
};

/** Library response from /api/library */
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

/** Successful redeem response from /api/redeem */
const MOCK_REDEEM_RESPONSE = {
  success:        true,
  cdkeyId:        '42',
  encryptedCDKey: '0x' + 'ef'.repeat(64),
  commitmentHash: '0x' + 'aa'.repeat(32),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: set up wagmi hook return values
// ─────────────────────────────────────────────────────────────────────────────

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

  // useReadContract is used for getClaimTimestamp
  // 0n = not claimed → shows Claim button; non-zero = claimed → shows Reveal button
  vi.mocked(wagmi.useReadContract).mockReturnValue({
    data:    claimTimestamp,
    refetch: mockRefetchClaimTimestamp,
  } as any);

  // useReadContracts is called for [mintPriceETH, mintPriceUSD, totalSupply, maxSupply]
  // and also for [isRefundable, paymentRecords] (vault reads, only when VAULT_ADDRESS is set).
  // In the test environment NEXT_PUBLIC_VAULT_ADDRESS is undefined so vault reads are skipped.
  vi.mocked(wagmi.useReadContracts).mockReturnValue({
    data: [
      { result: BigInt('10000000000000000') }, // mintPriceETH: 0.01 ETH
      { result: BigInt('2500000') },            // mintPriceUSD: $2.50 (6-decimal)
      { result: 5n },                           // totalSupply
      { result: 100n },                         // maxSupply
    ],
    isLoading: false,
  } as any);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: stub global.fetch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sets up fetch mocks for the full normal flow.
 *
 * IMPORTANT: /api/products MUST return a non-empty products array.
 * An empty array causes loadProducts() to call setProductsError(), which renders
 * an error screen in place of the full UI — the library section (and Claim
 * button) never mounts, making every subsequent assertion fail.
 *
 * URL ordering: /api/redeem/confirm is checked before /api/redeem so that
 * `url.includes('/api/redeem')` does not accidentally match the confirm URL.
 */
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
    // Check confirm BEFORE the general /api/redeem so the longer URL matches first
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
    // Fallback — any other route returns empty success
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: stub window.ethereum
// ─────────────────────────────────────────────────────────────────────────────

function setupEthereumMock() {
  Object.defineProperty(window, 'ethereum', {
    value: {
      request: vi.fn().mockImplementation(({ method }: { method: string }) => {
        if (method === 'eth_getEncryptionPublicKey') return Promise.resolve('mock-pubkey-base64');
        if (method === 'eth_decrypt')                return Promise.resolve('XXXX-XXXX-XXXX-XXXX');
        return Promise.reject(new Error(`Unknown method: ${method}`));
      }),
    },
    writable:     true,
    configurable: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared reset
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  setupEthereumMock();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: receipt status check (the atomicity fix)
// ─────────────────────────────────────────────────────────────────────────────

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
    setupFetchMocks(); // /api/redeem returns MOCK_REDEEM_RESPONSE (success)
    mockWriteContractAsync.mockResolvedValue(MOCK_TX_HASH);
    // The tx is mined but the EVM reverted — viem still returns a receipt
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

    // The confirm route must never be reached after a reverted tx
    const calls = vi.mocked(global.fetch).mock.calls.map(([url]) => url as string);
    expect(calls.some(url => url.includes('/api/redeem/confirm'))).toBe(false);
  });

  it('does NOT call /api/redeem/confirm when writeContractAsync throws (user rejection)', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    // User rejects the MetaMask signing prompt — no txHash is produced
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
    /**
     * Override the shared fetch mock for this test only.
     * CRITICAL: /api/products must still return MOCK_PRODUCT or the library
     * section never renders and screen.findByRole() will time out.
     */
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
      // /api/redeem/confirm checked first (more specific URL)
      if (url.includes('/api/redeem/confirm')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      }
      if (url.includes('/api/redeem')) {
        // Simulate a server-side error (e.g. key pool exhausted)
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

    // /api/redeem failed → writeContractAsync never called → confirm never called
    expect(mockWriteContractAsync).not.toHaveBeenCalled();
    const calls = vi.mocked(global.fetch).mock.calls.map(([url]) => url as string);
    expect(calls.some(url => url.includes('/api/redeem/confirm'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: guard conditions
// ─────────────────────────────────────────────────────────────────────────────

describe('handleClaimCDKey — guard conditions', () => {

  it('does not render the Claim button when wallet is not connected', async () => {
    vi.mocked(wagmi.useAccount).mockReturnValue({ address: undefined, isConnected: false } as any);
    vi.mocked(wagmi.usePublicClient).mockReturnValue(undefined as any);
    vi.mocked(wagmi.useWriteContract).mockReturnValue({ writeContractAsync: mockWriteContractAsync } as any);
    vi.mocked(wagmi.useReadContract).mockReturnValue({ data: 0n, refetch: vi.fn() } as any);
    vi.mocked(wagmi.useReadContracts).mockReturnValue({ data: [], isLoading: false } as any);
    setupFetchMocks();

    render(<Home />);

    // The library section is gated on connectedAddress — no wallet = no library
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /claim cd key/i })).not.toBeInTheDocument();
    });

    expect(mockWriteContractAsync).not.toHaveBeenCalled();
  });

  it('does not render the Claim button when token is already claimed', async () => {
    // claimTimestamp > 0n means the key has been claimed and the NFT is soulbound
    setupWagmiMocks({ claimTimestamp: 1_700_000_000n });
    setupFetchMocks();

    render(<Home />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /claim cd key/i })).not.toBeInTheDocument();
    });

    // Instead, the Reveal button should be visible
    expect(await screen.findByRole('button', { name: /reveal cd key/i })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: loading state feedback
// ─────────────────────────────────────────────────────────────────────────────

describe('handleClaimCDKey — loading state feedback', () => {

  it('shows a step label and spinner in the button while the tx is pending', async () => {
    setupWagmiMocks();
    setupFetchMocks();
    mockWriteContractAsync.mockResolvedValue(MOCK_TX_HASH);

    /**
     * Never resolve — keeps the component in the "Waiting for claim
     * confirmation..." step indefinitely so the spinner is visible.
     *
     * The actual step label shown when waitForTransactionReceipt is pending is
     * "Waiting for claim confirmation..." — NOT "Claiming CD key on blockchain"
     * (that step exits as soon as writeContractAsync resolves).
     */
    mockWaitForTransactionReceipt.mockImplementation(() => new Promise(() => {}));

    render(<Home />);

    const claimBtn = await screen.findByRole('button', { name: /claim cd key/i });
    await userEvent.click(claimBtn);

    // Handles the shared loading state rendering the label in multiple buttons
    const stepLabels = await screen.findAllByText(/waiting for claim confirmation/i);
    expect(stepLabels.length).toBeGreaterThan(0);

    // The idle button label must no longer be shown
    expect(
      screen.queryByRole('button', { name: /🔑 Claim CD Key — Makes NFT Soulbound/i }),
    ).not.toBeInTheDocument();

    // A DaisyUI spinner must be present inside the button
    expect(document.querySelector('.loading.loading-spinner')).toBeInTheDocument();
  });
});
