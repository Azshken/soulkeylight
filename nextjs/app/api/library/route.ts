import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: NextRequest) {
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!wallet || !ADDRESS_RE.test(wallet))
    return NextResponse.json(
      { success: false, error: "Invalid wallet" },
      { status: 400 },
    );

  try {
    const result = await sql`
      SELECT
        p.product_id, p.contract_address, p.name, p.genre, p.image_cid, p.image_claimed_cid, p.is_active,
        array_agg(m.token_id ORDER BY m.token_id ASC) AS token_ids
      FROM mints m
      JOIN cd_keys ck ON ck.id = m.cdkey_id
      JOIN batches b ON b.batch_id = ck.batch_id
      JOIN products p ON p.product_id = b.product_id
      WHERE LOWER(m.minted_by) = LOWER(${wallet})
      AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.cdkey_id = ck.id)
      GROUP BY p.product_id
      ORDER BY p.name ASC
    `;

    return NextResponse.json({
      success: true,
      games: result.rows.map((r) => ({
        ...r,
        token_ids: r.token_ids.map(Number),
      })),
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
