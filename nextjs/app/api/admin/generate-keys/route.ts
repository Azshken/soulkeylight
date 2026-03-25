// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/api/admin/generate-keys/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, parseAbi, verifyMessage } from "viem";

import { sepolia } from "viem/chains";
import { encrypt, generateCDKey, hashCDKey } from "@/utils/crypto";
import {
  createBatch,
  getAvailableKeyCount,
  getOrCreateProduct,
  insertCDKeys,
} from "@/utils/db";

const MAX_QUANTITY = 1000;
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body)
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );

    const {
      quantity: rawQuantity,
      walletAddress,
      contractAddress,
      batchNotes = "",
      signature,
      message,
      timestamp,
    } = body;

    if (
      !walletAddress ||
      !contractAddress ||
      !signature ||
      !message ||
      !timestamp
    ) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 },
      );
    }

    // 1. Reject stale signatures
    const messageAge = Date.now() - Number(timestamp);
    if (messageAge > MAX_MESSAGE_AGE_MS || messageAge < 0) {
      return NextResponse.json(
        { success: false, error: "Signature expired, please try again" },
        { status: 401 },
      );
    }

    // 2. Verify signature
    const isValidSignature = await verifyMessage({
      address: walletAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    if (!isValidSignature) {
      return NextResponse.json(
        { success: false, error: "Invalid signature" },
        { status: 401 },
      );
    }

    // 3. Verify on-chain ownership — SoulKey.owner() must match walletAddress
    const targetChain = sepolia;
    const publicClient = createPublicClient({
      chain: targetChain,
      transport: http(process.env.ALCHEMY_RPC_URL),
    });

    const contractOwner = await publicClient.readContract({
      address: contractAddress as `0x${string}`,
      abi: parseAbi(["function owner() view returns (address)"]),
      functionName: "owner",
    });

    if (contractOwner.toLowerCase() !== walletAddress.toLowerCase()) {
      console.warn(
        `Unauthorized generate-keys attempt from ${walletAddress}, owner is ${contractOwner}`,
      );
      return NextResponse.json(
        { success: false, error: "Unauthorized: not the contract owner" },
        { status: 403 },
      );
    }

    // 4. Validate quantity
    const quantity = Number(rawQuantity ?? 10);
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY
    ) {
      return NextResponse.json(
        {
          success: false,
          error: `Quantity must be an integer between 1 and ${MAX_QUANTITY}`,
        },
        { status: 400 },
      );
    }

    const vaultAddress = await publicClient.readContract({
      address: contractAddress,
      abi: parseAbi(["function vault() view returns (address)"]),
      functionName: "vault",
    });
    const isRegistered = await publicClient.readContract({
      address: vaultAddress,
      abi: parseAbi(["function registeredGames(address) view returns (bool)"]),
      functionName: "registeredGames",
      args: [contractAddress],
    });
    if (!isRegistered)
      return NextResponse.json(
        { success: false, error: "Contract not registered in vault" },
        { status: 400 },
      );

    // 5. Resolve product — create if first time this contract is seen
    const productId = await getOrCreateProduct(contractAddress);

    // 6. Create batch record first — keys belong to a batch
    const batchId = await createBatch(productId, batchNotes);

    // 7. Generate keys and collect for bulk insert
    const keys: { commitmentHash: string }[] = [];
    const keyRows: { encrypted_key: string; commitment_hash: string }[] = [];

    for (let i = 0; i < quantity; i++) {
      const cdkey = generateCDKey();
      const commitmentHash = hashCDKey(cdkey);
      const encryptedKey = encrypt(cdkey);
      keyRows.push({
        encrypted_key: encryptedKey,
        commitment_hash: commitmentHash,
      });
      keys.push({ commitmentHash });
    }

    await insertCDKeys(batchId, keyRows);

    // 8. Count total unminted keys for this contract
    const totalAvailable = await getAvailableKeyCount(contractAddress);

    return NextResponse.json({
      success: true,
      count: keys.length,
      keys,
      batchId,
      totalAvailable,
    });
  } catch (error: any) {
    console.error("Generate Keys API error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 },
    );
  }
}
