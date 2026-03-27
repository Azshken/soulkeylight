// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/api/admin/import-keys/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, parseAbi, verifyMessage } from "viem";
import { sepolia } from "viem/chains";
import { encrypt, hashCDKey } from "@/utils/crypto";
import {
  createBatch,
  filterExistingHashes,
  getAvailableKeyCount,
  getOrCreateProduct,
  insertCDKeys,
} from "@/utils/db";

const MAX_KEYS = 1000;
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
      keys: rawKeys,        // string[] of plaintext CD keys
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
      !timestamp ||
      !rawKeys
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

    // 2. Verify wallet signature
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

    // 3. Verify on-chain ownership
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(process.env.ALCHEMY_RPC_URL),
    });

    const contractOwner = await publicClient.readContract({
      address: contractAddress as `0x${string}`,
      abi: parseAbi(["function owner() view returns (address)"]),
      functionName: "owner",
    });

    if (contractOwner.toLowerCase() !== walletAddress.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: not the contract owner" },
        { status: 403 },
      );
    }

    // 4. Validate keys array
    if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
      return NextResponse.json(
        { success: false, error: "No keys provided" },
        { status: 400 },
      );
    }
    if (rawKeys.length > MAX_KEYS) {
      return NextResponse.json(
        { success: false, error: `Maximum ${MAX_KEYS} keys per batch` },
        { status: 400 },
      );
    }

    // Trim whitespace and filter empties
    const plainKeys: string[] = rawKeys
      .map((k: unknown) => String(k).trim())
      .filter((k) => k.length > 0);

    if (plainKeys.length === 0) {
      return NextResponse.json(
        { success: false, error: "All provided keys were empty" },
        { status: 400 },
      );
    }

    // 5. Check vault registration
    const vaultAddress = await publicClient.readContract({
      address: contractAddress as `0x${string}`,
      abi: parseAbi(["function vault() view returns (address)"]),
      functionName: "vault",
    });
    const isRegistered = await publicClient.readContract({
      address: vaultAddress,
      abi: parseAbi(["function registeredGames(address) view returns (bool)"]),
      functionName: "registeredGames",
      args: [contractAddress as `0x${string}`],
    });
    if (!isRegistered)
      return NextResponse.json(
        { success: false, error: "Contract not registered in vault" },
        { status: 400 },
      );

    // 6. Encrypt + hash each plaintext key
    const keyRows = plainKeys.map((cdkey) => ({
      encrypted_key: encrypt(cdkey),
      commitment_hash: hashCDKey(cdkey),
    }));

    // 7. Pre-filter duplicates — before touching batches or sequences
    // Deduplicate within the submitted batch itself (keeps first occurrence)
    const seen = new Set<string>();
    const dedupedKeyRows = keyRows.filter((k) => {
      if (seen.has(k.commitment_hash)) return false;
      seen.add(k.commitment_hash);
      return true;
    });
    const intraBatchDuplicates = keyRows.length - dedupedKeyRows.length;

    // Then filter against the DB
    const allHashes = dedupedKeyRows.map((k) => k.commitment_hash);
    const existingHashes = await filterExistingHashes(allHashes);
    const newKeyRows = dedupedKeyRows.filter((k) => !existingHashes.has(k.commitment_hash));
    const dbDuplicates = dedupedKeyRows.length - newKeyRows.length;
    const duplicates = intraBatchDuplicates + dbDuplicates;

    // 8. Bail out early if everything was a duplicate — no batch created, no sequence incremented
    if (newKeyRows.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: `All ${duplicates} key(s) already exist in the database — nothing imported`,
          duplicates,
          count: 0,
        },
        { status: 409 },
      );
    }

    // 9. Only now create the product + batch
    const productId = await getOrCreateProduct(contractAddress);
    const batchId = await createBatch(productId, batchNotes);
    await insertCDKeys(batchId, newKeyRows);

    const totalAvailable = await getAvailableKeyCount(contractAddress);

    return NextResponse.json({
      success: true,
      count: newKeyRows.length,
      duplicates,
      batchId,
      totalAvailable,
    });
  } catch (error: any) {
    console.error("Import Keys API error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 },
    );
  }
}