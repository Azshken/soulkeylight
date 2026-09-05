// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/api/refund/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

import { recordRefund } from "@/utils/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body)
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );

    const {
      contractAddress,
      tokenId,
      refundedBy,
      refundReason,
      refundTxHash,
      blockNumber,
      paymentToken,
      refundedAmount,
      feeRetained,
    } = body;

    if (
      !contractAddress ||
      !tokenId ||
      !refundedBy ||
      !refundTxHash ||
      !blockNumber ||
      !paymentToken ||
      !refundedAmount ||
      !feeRetained
    ) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Resolve cdkey_id from the *current* mint of this token (not a burned prior mint)
    const mintRow = await sql`
      SELECT m.cdkey_id
      FROM mints m
      JOIN cd_keys ck ON ck.id = m.cdkey_id
      JOIN batches b ON b.batch_id = ck.batch_id
      JOIN products p ON p.product_id = b.product_id
      LEFT JOIN refunds rf ON rf.cdkey_id = ck.id
      WHERE m.token_id = ${tokenId.toString()}
        AND LOWER(p.contract_address) = LOWER(${contractAddress})
        AND (rf.refund_id IS NULL OR m.minted_at > rf.refunded_at)
      LIMIT 1
    `;

    if (!mintRow.rows[0]) {
      return NextResponse.json(
        { success: false, error: "No mint record found for this token" },
        { status: 404 },
      );
    }

    const cdkeyId = mintRow.rows[0].cdkey_id as number;

    await recordRefund({
      cdkeyId,
      refundedBy,
      refundReason: refundReason || "",
      refundTxHash,
      blockNumber: BigInt(blockNumber),
      paymentToken,
      refundedAmount,
      feeRetained,
    });

    return NextResponse.json({ success: true, cdkeyId });
  } catch (error: any) {
    console.error("Refund API error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 },
    );
  }
}
