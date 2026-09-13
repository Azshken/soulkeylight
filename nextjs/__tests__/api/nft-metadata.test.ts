// nextjs/__tests__/api/nft-metadata.test.ts
//
// Focused route tests for GET /api/nft/[contractAddress]/[tokenId]
// (12/09/26 inventory & metadata slice): the frozen-CID lookup must be
// contract-scoped (mints.token_id is unique only PER GAME — a bare token_id
// key collided across games), and the dynamic unclaimed JSON serves
// image_claimed_cid when the token is claimed, falling back to image_cid
// (same rule as the confirm route's Pinata payload). DB fully mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { getAddress } from "viem";

vi.mock("@vercel/postgres", () => ({ sql: vi.fn() }));

import { sql } from "@vercel/postgres";
import { GET } from "@/app/api/nft/[contractAddress]/[tokenId]/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

const CONTRACT = "0x0000000000000000000000000000000000001111";
const CONTRACT_2 = "0x0000000000000000000000000000000000002222";

let productRows: Record<string, unknown>[];
let frozenRows: Record<string, unknown>[];
let claimRows: Record<string, unknown>[];
let calls: { q: string; values: unknown[] }[];

function product(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Game",
    genre: "RPG",
    description: "A test game.",
    image_cid: "QmStore",
    image_claimed_cid: null,
    ...overrides,
  };
}

function makeGet(contractAddress = CONTRACT, tokenId = "1") {
  return GET(
    new NextRequest(
      `http://localhost/api/nft/${contractAddress}/${tokenId}`,
    ),
    { params: Promise.resolve({ contractAddress, tokenId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  productRows = [product()];
  frozenRows = [];
  claimRows = [];
  calls = [];
  vi.mocked(sql).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const q = strings.join("?");
    calls.push({ q, values });
    if (q.includes("frozen_metadata_cid")) return { rows: frozenRows };
    if (q.includes("redeemed_at")) return { rows: claimRows };
    if (q.includes("FROM products")) return { rows: productRows };
    return { rows: [] };
  }) as unknown as typeof sql);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/nft/[contractAddress]/[tokenId]", () => {
  it("301s to ipfs.io when a frozen CID exists", async () => {
    frozenRows = [{ frozen_metadata_cid: "QmFrozen" }];

    const res = await makeGet();

    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://ipfs.io/ipfs/QmFrozen");
    // products + frozen only — the claim-status query never runs
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.q.includes("redeemed_at"))).toBe(false);
  });

  it("frozen-CID lookup is contract-scoped (cross-game token_id collision)", async () => {
    frozenRows = [{ frozen_metadata_cid: "QmFrozen" }];

    await makeGet(CONTRACT_2, "1");

    const frozen = calls.find((c) => c.q.includes("frozen_metadata_cid"))!;
    expect(frozen.q).toContain("JOIN products p");
    expect(frozen.q).toContain("LOWER(p.contract_address)");
    // tokenId "1" collides across games — the query must carry THIS contract
    expect(frozen.values).toContain("1");
    expect(frozen.values).toContain(getAddress(CONTRACT_2));
  });

  it("unclaimed JSON: storefront image, Unclaimed attrs, short cache", async () => {
    const res = await makeGet(CONTRACT, "7");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.name).toBe("Test Game CD Key #7");
    expect(body.description).toBe("A test game.");
    expect(body.image).toBe("ipfs://QmStore");
    expect(body.attributes).toContainEqual({
      trait_type: "Status",
      value: "Unclaimed",
    });
    expect(body.attributes).toContainEqual({
      trait_type: "Soulbound",
      value: "No",
    });
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
  });

  it("claimed without a frozen CID serves image_claimed_cid", async () => {
    productRows = [product({ image_claimed_cid: "QmClaimed" })];
    claimRows = [{ redeemed_at: "2026-09-12T00:00:00Z" }];

    const res = await makeGet();
    const body = await res.json();

    expect(body.image).toBe("ipfs://QmClaimed");
    expect(body.attributes).toContainEqual({
      trait_type: "Status",
      value: "Claimed",
    });
    expect(body.attributes).toContainEqual({
      trait_type: "Soulbound",
      value: "Yes",
    });
  });

  it("claimed without claimed art falls back to image_cid", async () => {
    claimRows = [{ redeemed_at: "2026-09-12T00:00:00Z" }]; // image_claimed_cid null

    const res = await makeGet();
    const body = await res.json();

    expect(body.image).toBe("ipfs://QmStore");
  });

  it("404s for an unknown contract", async () => {
    productRows = [];

    const res = await makeGet();
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Contract not found");
    expect(calls).toHaveLength(1);
  });
});
