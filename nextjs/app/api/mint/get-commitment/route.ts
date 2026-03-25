// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/api/mint/get-commitment/route.ts
import { NextRequest, NextResponse } from "next/server";

import { reserveCDKeyForWallet } from "@/utils/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body)
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );

    const { walletAddress, contractAddress } = body;

    if (!walletAddress || !contractAddress) {
      return NextResponse.json(
        {
          success: false,
          error: "walletAddress and contractAddress are required",
        },
        { status: 400 },
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      return NextResponse.json(
        { success: false, error: "Invalid wallet address format" },
        { status: 400 },
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
      return NextResponse.json(
        { success: false, error: "Invalid contract address format" },
        { status: 400 },
      );
    }

    // Atomically reserve a key for this wallet — or return the existing reservation
    // if this wallet already called get-commitment without minting yet.
    const cdkey = await reserveCDKeyForWallet(contractAddress, walletAddress);
    if (!cdkey) {
      return NextResponse.json(
        { success: false, error: "No CD keys available for this product" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      commitmentHash: cdkey.commitment_hash,
    });
  } catch (error: any) {
    console.error("Get Commitment API error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 },
    );
  }
}
