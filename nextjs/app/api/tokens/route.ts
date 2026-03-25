// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/api/tokens/route.ts
//
// Returns token IDs minted by a given wallet for a given SoulKey contract.
// Tracks original minter only — tokens become soulbound after claim so transfers are rare.
// Refunded (burned) tokens are excluded.
// Contract is validated against the products table to prevent enumeration of arbitrary addresses.
//
// Rate limiting: in-memory, best-effort per Vercel warm instance (1 req/2s per IP).
// The map is periodically swept to prevent unbounded memory growth on long-lived instances.
// For multi-instance production use, replace with Vercel KV or Upstash Redis.
//
// IP source: Vercel infrastructure injects the real client IP into x-real-ip and appends it
// as the last entry in x-forwarded-for. Both are infrastructure-controlled and cannot be
// forged by a client. We prefer x-real-ip and fall back to the LAST x-forwarded-for entry.
// Using split(",")[0] (the FIRST entry) is WRONG on Vercel — a client can inject an arbitrary
// IP as the first entry and bypass rate limiting entirely.
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 2_000; // minimum ms between requests per IP
const SWEEP_THRESHOLD = 5_000; // sweep when map grows beyond this many entries
const SWEEP_TTL_MS = 60_000; // drop entries not seen within this window

/**
 * Returns true if the request is allowed, false if it should be rate-limited.
 * IP is read from x-real-ip (infrastructure-injected, non-forgeable on Vercel).
 * Falls back to the LAST x-forwarded-for entry (also infrastructure-appended).
 * Sweeps stale entries when the map exceeds SWEEP_THRESHOLD to prevent unbounded
 * memory growth on long-lived Vercel warm instances.
 */
function allowRequest(req: NextRequest): boolean {
  // x-real-ip is set by Vercel's infrastructure and cannot be spoofed by the client.
  // x-forwarded-for is appended to by infrastructure, so the last entry is the real IP.
  // Never use split(",")[0] — that reads the client-supplied portion of the header.
  const ip =
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ??
    "unknown";

  const now = Date.now();

  if (rateLimitMap.size > SWEEP_THRESHOLD) {
    for (const [key, ts] of rateLimitMap) {
      if (now - ts > SWEEP_TTL_MS) rateLimitMap.delete(key);
    }
  }

  const lastCall = rateLimitMap.get(ip) ?? 0;
  if (now - lastCall < RATE_LIMIT_MS) return false;

  rateLimitMap.set(ip, now);
  return true;
}

export async function GET(req: NextRequest) {
  if (!allowRequest(req)) {
    return NextResponse.json(
      { success: false, error: "Too many requests" },
      { status: 429 },
    );
  }

  const { searchParams } = new URL(req.url);
  const wallet = searchParams.get("wallet");
  const contract = searchParams.get("contract");

  if (!wallet || !contract) {
    return NextResponse.json(
      { success: false, error: "wallet and contract are required" },
      { status: 400 },
    );
  }
  if (!ADDRESS_RE.test(wallet) || !ADDRESS_RE.test(contract)) {
    return NextResponse.json(
      { success: false, error: "Invalid address format" },
      { status: 400 },
    );
  }

  try {
    // Validate the contract is a registered product — prevents scraping arbitrary addresses
    const productCheck = await sql`
      SELECT 1 FROM products WHERE LOWER(contract_address) = LOWER(${contract}) LIMIT 1
    `;
    if (productCheck.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: "Unknown contract" },
        { status: 404 },
      );
    }

    const result = await sql`
      SELECT m.token_id
      FROM mints m
      JOIN cd_keys  ck ON ck.id       = m.cdkey_id
      JOIN batches b  ON b.batch_id   = ck.batch_id
      JOIN products p ON p.product_id = b.product_id
      WHERE LOWER(m.minted_by)        = LOWER(${wallet})
        AND LOWER(p.contract_address) = LOWER(${contract})
        AND NOT EXISTS (
          SELECT 1 FROM refunds r WHERE r.cdkey_id = ck.id
        )
      ORDER BY m.token_id ASC
    `;

    return NextResponse.json({
      success: true,
      tokens: result.rows.map((r) => Number(r.token_id)),
    });
  } catch (error: any) {
    console.error("Tokens API error", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 },
    );
  }
}
