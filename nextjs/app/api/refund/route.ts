// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

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

    // Idempotent retry: a page refresh between the on-chain refund and the client
    // clearing its pending-tx record re-POSTs this route with the same txHash.
    // An existing refunds row means it was already recorded — return success.
    // (The mint lookup below filters out refunded tokens by design, so without
    // this guard a legitimate retry would 404 "No mint record found" forever.)
    const existingRefund = await sql`
      SELECT cdkey_id FROM refunds
      WHERE LOWER(refund_tx_hash) = LOWER(${refundTxHash})
      LIMIT 1
    `;
    if (existingRefund.rows[0]) {
      return NextResponse.json({
        success: true,
        cdkeyId: existingRefund.rows[0].cdkey_id,
        alreadyRecorded: true,
      });
    }

    const mintRow = await sql`
      SELECT m.cdkey_id
      FROM mints m
      JOIN cd_keys ck ON ck.id = m.cdkey_id
      JOIN batches b ON b.batch_id = ck.batch_id
      JOIN products p ON p.product_id = b.product_id
      WHERE m.token_id = ${tokenId.toString()}
        AND LOWER(p.contract_address) = LOWER(${contractAddress})
        AND NOT EXISTS (
          SELECT 1 FROM refunds rf
          WHERE rf.cdkey_id = ck.id
            AND rf.refunded_at >= m.minted_at
        )
      LIMIT 1
    `;

    if (!mintRow.rows[0]) {
      return NextResponse.json(
        { success: false, error: "No mint record found for this token" },
        { status: 404 },
      );
    }

    const cdkeyId = mintRow.rows[0].cdkey_id as number;

    // Claimed tokens are non-refundable on-chain: claiming moves the vault
    // reserve to ReleasedByClaim, so processRefund reverts. Mirror that here —
    // a confirmed redemption row (redemption_tx_hash set) means this key was
    // claimed, and the refunds table is append-only: never record one.
    const claimedRow = await sql`
      SELECT 1 AS claimed
      FROM redemptions
      WHERE cdkey_id = ${cdkeyId}
        AND redemption_tx_hash IS NOT NULL
      LIMIT 1
    `;
    if (claimedRow.rows[0]) {
      return NextResponse.json(
        {
          success: false,
          error: "Token already claimed; refunds are not recorded",
        },
        { status: 409 },
      );
    }

    // Verify the refund tx actually succeeded before the append-only insert
    // (same RPC pattern as /api/redeem/confirm; hardcoded sepolia client).
    // viem throws when the receipt is missing — normalise that to the 400.
    const rpcUrl = process.env.ALCHEMY_RPC_URL;
    if (!rpcUrl) {
      return NextResponse.json(
        { success: false, error: "Server misconfiguration: missing RPC" },
        { status: 500 },
      );
    }
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl),
    });
    const receipt = await publicClient
      .getTransactionReceipt({ hash: refundTxHash as `0x${string}` })
      .catch(() => null);
    if (!receipt || receipt.status !== "success") {
      return NextResponse.json(
        {
          success: false,
          error:
            "Refund transaction missing or reverted on-chain; nothing was recorded",
        },
        { status: 400 },
      );
    }

    await recordRefund({
      cdkeyId,
      tokenId: String(tokenId),
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
