// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/api/redeem/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, parseAbi } from "viem";

import { sepolia } from "viem/chains";
import { decrypt, encryptWithPublicKey } from "@/utils/crypto";
import { createRedemptionRecord, getCDKeyByTokenId } from "@/utils/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body)
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );

    const { tokenId, userAddress, userPublicKey, contractAddress } = body;
    if (!tokenId || !userAddress || !userPublicKey) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
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

    // 1. Verify NFT ownership on-chain
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

    // 2. Fetch cd_key + existing redemption record from new schema
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

    // 3. If already re-encrypted for user (redemption record exists), return it
    if (cdkeyRecord.wallet_encrypted_cdkey) {
      return NextResponse.json({
        success: true,
        encryptedCDKey: cdkeyRecord.wallet_encrypted_cdkey,
        commitmentHash: cdkeyRecord.commitment_hash,
        cdkeyId: cdkeyRecord.id.toString(),
        alreadyEncrypted: true,
      });
    }

    // encrypted_key may already be nulled if previously processed — guard here
    if (!cdkeyRecord.encrypted_key) {
      return NextResponse.json(
        { success: false, error: "CD key already redeemed — check on-chain" },
        { status: 409 },
      );
    }

    // 4. Decrypt server-side key (only ever happens once)
    const plaintextCDKey = decrypt(cdkeyRecord.encrypted_key);

    // 5. Re-encrypt with user's MetaMask public key
    const encryptedForUser = encryptWithPublicKey(
      plaintextCDKey,
      userPublicKey,
    );

    // 6. Store in redemptions table (partial — confirmed after on-chain tx)
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
