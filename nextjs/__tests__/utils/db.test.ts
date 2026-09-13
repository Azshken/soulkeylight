// nextjs/__tests__/utils/db.test.ts
//
// Focused unit tests for the availability SQL in utils/db.ts (12/09/26):
// every key-selection query must exclude rows whose encrypted_key is NULL —
// clearEncryptedKey nulls it after a CONFIRMED claim, and such keys can
// never be re-minted (on-chain commitmentInUse stays set for claimed burns).
// The pool is mocked; assertions run on the captured SQL text and on the
// function results. No Neon, no chain.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@vercel/postgres", () => ({ sql: vi.fn(), db: { connect: vi.fn() } }));

import { db, sql } from "@vercel/postgres";
import {
  reserveCDKeyForWallet,
  getAvailableKeyCount,
  reserveAndMint,
} from "@/utils/db";

// ── Harness ──────────────────────────────────────────────────────────────────

const clientQueries: string[] = [];
const topQueries: string[] = [];
const client = { sql: vi.fn(), release: vi.fn() };

function installClient(dispatch?: (q: string) => { rows: unknown[] }) {
  clientQueries.length = 0;
  vi.mocked(client.sql).mockImplementation((async (
    strings: TemplateStringsArray,
  ) => {
    const q = strings.join("?");
    clientQueries.push(q);
    return dispatch?.(q) ?? { rows: [] };
  }) as unknown as typeof client.sql);
  vi.mocked(db.connect).mockResolvedValue(client as never);
}

function installTopSql(rows: unknown[]) {
  topQueries.length = 0;
  vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
    topQueries.push(strings.join("?"));
    return { rows };
  }) as unknown as typeof sql);
}

const KEY = {
  id: 9,
  encrypted_key: "v2gcm:aa:bb:cc",
  commitment_hash: "0xabc",
  batch_id: 1,
  created_at: new Date(0),
};

const CONTRACT = "0x0000000000000000000000000000000000001111";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("availability queries exclude keys without an AES copy", () => {
  it("reserveCDKeyForWallet: both SELECTs filter encrypted_key, redemption and refunds; rolls back when empty", async () => {
    installClient();

    const out = await reserveCDKeyForWallet(CONTRACT, "0xWALLET");

    expect(out).toBeNull();
    const selects = clientQueries.filter((q) => q.includes("FROM cd_keys ck"));
    expect(selects).toHaveLength(2); // existing-reservation + fresh pick
    for (const q of selects) {
      expect(q).toContain("ck.encrypted_key IS NOT NULL");
      expect(q).toContain("r.redemption_tx_hash IS NULL");
      expect(q).toContain("rf.refunded_at >= COALESCE(m.minted_at");
      expect(q).toContain("p.is_active = TRUE");
    }
    // no key found → nothing reserved, transaction rolled back
    expect(clientQueries.some((q) => q.includes("SET reserved_by = ?"))).toBe(
      false,
    );
    expect(clientQueries).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });

  it("reserveCDKeyForWallet: returns the wallet's still-valid reservation", async () => {
    installClient((q) =>
      q.includes("ck.reserved_at >=") ? { rows: [KEY] } : { rows: [] },
    );

    const out = await reserveCDKeyForWallet(CONTRACT, "0xWALLET");

    expect(out).toEqual(KEY);
    expect(clientQueries).toContain("COMMIT");
  });

  it("getAvailableKeyCount: count query filters encrypted_key, redemption and refunds", async () => {
    installTopSql([{ cnt: "3" }]);

    const n = await getAvailableKeyCount(CONTRACT);

    expect(n).toBe(3);
    expect(topQueries).toHaveLength(1);
    const q = topQueries[0];
    expect(q).toContain("ck.encrypted_key IS NOT NULL");
    expect(q).toContain("r.redemption_tx_hash IS NULL");
    expect(q).toContain("rf.refunded_at >= COALESCE(m.minted_at");
    expect(q).toContain("p.is_active = TRUE");
  });

  it("reserveAndMint: key SELECT filters encrypted_key; the mint_tx_hash idempotency lookup does NOT", async () => {
    installClient((q) =>
      q.includes("LOWER(ck.commitment_hash) IN") ? { rows: [KEY] } : { rows: [] },
    );

    const out = await reserveAndMint({
      contractAddress: CONTRACT,
      commitmentHash: "0xABC",
      tokenId: 5n,
      mintedBy: "0xWALLET",
      mintTxHash: "0x" + "bb".repeat(32),
      blockNumber: 99n,
      paymentToken: "ETH",
      paymentAmount: "1000000000000000000",
    });

    expect(out).toEqual(KEY);
    const keySelect = clientQueries.find((q) =>
      q.includes("LOWER(ck.commitment_hash) IN"),
    )!;
    expect(keySelect).toContain("ck.encrypted_key IS NOT NULL");
    expect(keySelect).toContain("r.redemption_tx_hash IS NULL");
    // link-token retries must still resolve rows whose key was already minted
    // (and possibly confirmed → encrypted_key NULL): no filter on this lookup.
    const linked = clientQueries.find((q) =>
      q.includes("LOWER(m.mint_tx_hash)"),
    )!;
    expect(linked).toBeDefined();
    expect(linked).not.toContain("encrypted_key IS NOT NULL");
    expect(clientQueries.some((q) => q.includes("INSERT INTO mints"))).toBe(
      true,
    );
    expect(clientQueries).toContain("COMMIT");
  });
});
