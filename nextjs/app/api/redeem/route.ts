// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/api/redeem/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, parseAbi } from "viem";

import { sepolia } from "viem/chains";
import { decrypt, encryptWithX25519, encryptWithXWing } from "@/utils/crypto";
import { createRedemptionRecord, getCDKeyByTokenId } from "@/utils/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body)
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );

    const { tokenId, userAddress, xwingPublicKey, x25519PublicKey, userPublicKey, contractAddress } = body;
    const legacyPk = x25519PublicKey ?? userPublicKey;
    const xwHex = typeof xwingPublicKey === "string" ? xwingPublicKey.replace(/^0x/, "") : "";
    const pkHex = typeof legacyPk === "string" ? legacyPk.replace(/^0x/, "") : "";
    if (!tokenId || !userAddress || (!xwHex && !pkHex)) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 },
      );
    }

    // New claims default to X-Wing (v2 on-chain ciphertext). A legacy 32-byte
    // X25519 key is still accepted so browser caches running the pre-X-Wing
    // frontend can finish a claim — those v1 blobs stay readable forever
    // (dual-read on reveal). X-Wing pk = 1216 bytes = 2432 hex chars.
    if (xwHex && !/^[0-9a-fA-F]{2432}$/.test(xwHex)) {
      return NextResponse.json(
        { success: false, error: "xwingPublicKey must be 1216 bytes (2432 hex chars)" },
        { status: 400 },
      );
    }
    if (!xwHex && !/^[0-9a-fA-F]{64}$/.test(pkHex)) {
      return NextResponse.json(
        { success: false, error: "x25519PublicKey must be 32 bytes (64 hex chars)" },
        { status: 400 },
      );
    }

    if (!contractAddress) {
      return NextResponse.json(
        {
          success: false,
          error: "Server misconfiguration: contract address not set",
        },
        { status: 400 },
      );
    }

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

    const owner = await publicClient.readContract({
      address: contractAddress,
      abi: parseAbi(["function ownerOf(uint256) view returns (address)"]),
      functionName: "ownerOf",
      args: [BigInt(tokenId)],
    });

    if (owner.toLowerCase() !== userAddress.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "Not NFT owner" },
        { status: 403 },
      );
    }

    const cdkeyRecord = await getCDKeyByTokenId(
      BigInt(tokenId),
      contractAddress,
    );
    if (!cdkeyRecord) {
      return NextResponse.json(
        { success: false, error: "CD key not found for this token" },
        { status: 404 },
      );
    }

    if (cdkeyRecord.wallet_encrypted_cdkey) {
      return NextResponse.json({
        success: true,
        encryptedCDKey: cdkeyRecord.wallet_encrypted_cdkey,
        commitmentHash: cdkeyRecord.commitment_hash,
        cdkeyId: cdkeyRecord.id.toString(),
        alreadyEncrypted: true,
      });
    }

    if (!cdkeyRecord.encrypted_key) {
      return NextResponse.json(
        { success: false, error: "CD key already redeemed — check on-chain" },
        { status: 409 },
      );
    }

    const plaintextCDKey = decrypt(cdkeyRecord.encrypted_key);
    // X-Wing is the write path for every new claim; the X25519 branch only
    // serves legacy cached clients that cannot send an X-Wing key.
    const encryptedForUser = xwHex
      ? encryptWithXWing(plaintextCDKey, xwHex)
      : encryptWithX25519(plaintextCDKey, pkHex);
    await createRedemptionRecord(cdkeyRecord.id, encryptedForUser);

    return NextResponse.json({
      success: true,
      encryptedCDKey: encryptedForUser,
      commitmentHash: cdkeyRecord.commitment_hash,
      cdkeyId: cdkeyRecord.id.toString(),
    });
  } catch (error: any) {
    console.error("Redeem API error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 },
    );
  }
}
