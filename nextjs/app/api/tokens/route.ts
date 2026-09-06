// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 2_000;
const SWEEP_THRESHOLD = 5_000;
const SWEEP_TTL_MS = 60_000;

function allowRequest(req: NextRequest): boolean {
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
          SELECT 1 FROM refunds rf
          WHERE rf.cdkey_id = ck.id
            AND rf.refunded_at >= m.minted_at
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
