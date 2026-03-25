// packages/nextjs/app/api/mint/link-token/route.ts
import { NextRequest, NextResponse } from "next/server";

import { reserveAndMint } from "@/utils/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body)
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );

    const {
      tokenId,
      walletAddress,
      txHash,
      blockNumber,
      paymentToken,
      paymentAmount,
      contractAddress,
      commitmentHash,
    } = body;

    if (
      !tokenId ||
      !walletAddress ||
      !txHash ||
      !blockNumber ||
      !paymentToken ||
      !paymentAmount ||
      !contractAddress ||
      !commitmentHash
    ) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 },
      );
    }

    const tokenIdNum = Number(tokenId);
    if (
      !Number.isFinite(tokenIdNum) ||
      !Number.isInteger(tokenIdNum) ||
      tokenIdNum < 0
    ) {
      return NextResponse.json(
        { success: false, error: "Invalid tokenId" },
        { status: 400 },
      );
    }

    // Atomic: locks the row, inserts mint record, commits — no race condition
    await reserveAndMint({
      contractAddress,
      commitmentHash,
      tokenId: BigInt(tokenId),
      mintedBy: walletAddress,
      mintTxHash: txHash,
      blockNumber: BigInt(blockNumber),
      paymentToken,
      paymentAmount,
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    // "No CD keys available" from the transaction will surface here
    console.error("Link Token API error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 },
    );
  }
}
