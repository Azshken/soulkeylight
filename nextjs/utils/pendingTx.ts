// SPDX-License-Identifier: AGPL-3.0-only
// Survives a refresh between wallet submit and the DB write.

const STORAGE_KEY = "soulkey:pendingTx";

export type PendingMint = {
  kind: "mint";
  txHash: `0x${string}`;
  wallet: string;
  contractAddress: string;
  commitmentHash: string;
  payment: "ETH" | "USDT" | "USDC";
  paymentAmount: string;
};

export type PendingRefund = {
  kind: "refund";
  txHash: `0x${string}`;
  wallet: string;
  contractAddress: string;
  tokenId: string;
  refundReason: string;
};

export type PendingClaim = {
  kind: "claim";
  txHash: `0x${string}`;
  wallet: string;
  contractAddress: string;
  tokenId: string;
  cdkeyId: number;
};

export type PendingTx = PendingMint | PendingRefund | PendingClaim;

export function savePendingTx(tx: PendingTx): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tx));
  } catch {
    /* private mode / quota */
  }
}

export function loadPendingTx(): PendingTx | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingTx;
    if (!parsed?.kind || !parsed.txHash) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingTx(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
