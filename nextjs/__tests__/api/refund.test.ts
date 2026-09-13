// nextjs/__tests__/api/refund.test.ts
//
// Focused route tests for POST /api/refund (12/09/26 inventory & metadata
// slice): confirmed-claim tokens 409 (DB mirror of the on-chain
// ReleasedByClaim non-refundability), the refund tx receipt is verified via
// RPC BEFORE the append-only refunds insert, and the existing
// refund_tx_hash idempotency short-circuit still wins over both.
// DB and RPC are fully mocked — no wallet, no chain, no Neon.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@vercel/postgres", () => ({ sql: vi.fn() }));
vi.mock("@/utils/db", () => ({
  recordRefund: vi.fn().mockResolvedValue(undefined),
}));

const mocks = vi.hoisted(() => ({
  getTransactionReceipt: vi.fn(),
  createPublicClient: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: mocks.createPublicClient,
    http: vi.fn(),
  };
});

import { sql } from "@vercel/postgres";
import { recordRefund } from "@/utils/db";
import { POST } from "@/app/api/refund/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

// Per-test DB state, dispatched by query content (the route runs three
// distinct SELECTs: refunds idempotency, mints live-mint, redemptions claim).
let refundsRows: Record<string, unknown>[];
let mintRows: Record<string, unknown>[];
let redemptionRows: Record<string, unknown>[];
let sqlQueries: string[];

const BODY = {
  contractAddress: "0x0000000000000000000000000000000000001111",
  tokenId: 7,
  refundedBy: "0x0000000000000000000000000000000000002222",
  refundReason: "changed mind",
  refundTxHash: "0x" + "aa".repeat(32),
  blockNumber: 123,
  paymentToken: "ETH",
  refundedAmount: "950000000000000000",
  feeRetained: "50000000000000000",
};

function makePost(body: unknown = BODY): NextRequest {
  return new NextRequest("http://localhost/api/refund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const RPC_URL = "https://sepolia.example.rpc";
let savedRpc: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  refundsRows = [];
  mintRows = [{ cdkey_id: 42 }];
  redemptionRows = [];
  sqlQueries = [];
  vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
    const q = strings.join("?");
    sqlQueries.push(q);
    // Order matters: the live-mint SELECT embeds a refunds subquery.
    if (q.includes("FROM mints")) return { rows: mintRows };
    if (q.includes("FROM refunds")) return { rows: refundsRows };
    if (q.includes("FROM redemptions")) return { rows: redemptionRows };
    return { rows: [] };
  }) as unknown as typeof sql);
  mocks.createPublicClient.mockReturnValue({
    getTransactionReceipt: mocks.getTransactionReceipt,
  });
  mocks.getTransactionReceipt.mockResolvedValue({ status: "success" });
  savedRpc = process.env.ALCHEMY_RPC_URL;
  process.env.ALCHEMY_RPC_URL = RPC_URL;
});

afterEach(() => {
  if (savedRpc === undefined) delete process.env.ALCHEMY_RPC_URL;
  else process.env.ALCHEMY_RPC_URL = savedRpc;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/refund", () => {
  it("records a refund for a live, unclaimed mint after receipt verification", async () => {
    const res = await POST(makePost());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, cdkeyId: 42 });
    expect(recordRefund).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordRefund).mock.calls[0][0]).toMatchObject({
      cdkeyId: 42,
      tokenId: "7",
      refundTxHash: BODY.refundTxHash,
      blockNumber: 123n,
      paymentToken: "ETH",
      refundedAmount: "950000000000000000",
      feeRetained: "50000000000000000",
    });
    // the claim guard ran, and the RPC receipt was fetched with our tx hash
    expect(sqlQueries.some((q) => q.includes("FROM redemptions"))).toBe(true);
    expect(mocks.getTransactionReceipt).toHaveBeenCalledWith({
      hash: BODY.refundTxHash,
    });
  });

  it("409s a confirmed-claim token — nothing recorded, no RPC call", async () => {
    redemptionRows = [{ claimed: 1 }];

    const res = await POST(makePost());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Token already claimed; refunds are not recorded");
    expect(recordRefund).not.toHaveBeenCalled();
    expect(mocks.createPublicClient).not.toHaveBeenCalled();
    expect(mocks.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("400s when the refund receipt is reverted — no insert", async () => {
    mocks.getTransactionReceipt.mockResolvedValue({ status: "reverted" });

    const res = await POST(makePost());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/missing or reverted/i);
    expect(recordRefund).not.toHaveBeenCalled();
  });

  it("400s when the receipt is missing (RPC throws) — no insert", async () => {
    mocks.getTransactionReceipt.mockRejectedValue(
      new Error("could not find transaction receipt"),
    );

    const res = await POST(makePost());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(recordRefund).not.toHaveBeenCalled();
  });

  it("idempotent retry: existing refund row short-circuits before claim guard and RPC", async () => {
    refundsRows = [{ cdkey_id: 42 }];

    const res = await POST(makePost());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, cdkeyId: 42, alreadyRecorded: true });
    expect(recordRefund).not.toHaveBeenCalled();
    expect(mocks.createPublicClient).not.toHaveBeenCalled();
    // exactly one DB query: the idempotency lookup
    expect(sqlQueries).toHaveLength(1);
  });

  it("404s when there is no live mint row for the token", async () => {
    mintRows = [];

    const res = await POST(makePost());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toMatch(/no mint record/i);
    expect(recordRefund).not.toHaveBeenCalled();
  });

  it("500s when ALCHEMY_RPC_URL is not configured", async () => {
    delete process.env.ALCHEMY_RPC_URL;

    const res = await POST(makePost());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toMatch(/missing RPC/);
    expect(recordRefund).not.toHaveBeenCalled();
  });
});
