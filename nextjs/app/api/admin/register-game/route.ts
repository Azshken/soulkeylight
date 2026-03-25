// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/api/admin/register-game/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { createPublicClient, http, parseAbi, verifyMessage } from "viem";

import { sepolia } from "viem/chains";

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
      walletAddress,
      contractAddress,
      metadataCid,
      signature,
      message,
      timestamp,
    } = body;

    if (
      !walletAddress ||
      !contractAddress ||
      !metadataCid ||
      !signature ||
      !message ||
      !timestamp
    ) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 },
      );
    }

    for (const addr of [walletAddress, contractAddress]) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
        return NextResponse.json(
          { success: false, error: `Invalid address: ${addr}` },
          { status: 400 },
        );
      }
    }

    // 1. Reject stale signatures
    const messageAge = Date.now() - Number(timestamp);
    if (messageAge > MAX_MESSAGE_AGE_MS || messageAge < 0) {
      return NextResponse.json(
        { success: false, error: "Signature expired" },
        { status: 401 },
      );
    }

    // 2. Verify signature
    const isValidSig = await verifyMessage({
      address: walletAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    if (!isValidSig) {
      return NextResponse.json(
        { success: false, error: "Invalid signature" },
        { status: 401 },
      );
    }

    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(process.env.ALCHEMY_RPC_URL),
    });

    // 3. Verify caller is the SoulKey contract owner on-chain
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

    // 4. Verify game is registered in the vault — prevents phantom DB entries
    const vaultAddress = await publicClient.readContract({
      address: contractAddress as `0x${string}`,
      abi: parseAbi(["function vault() view returns (address)"]),
      functionName: "vault",
    });
    const isRegistered = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: parseAbi(["function registeredGames(address) view returns (bool)"]),
      functionName: "registeredGames",
      args: [contractAddress as `0x${string}`],
    });
    if (!isRegistered) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Contract is not registered in MasterKeyVault. Call registerGame() first.",
        },
        { status: 400 },
      );
    }

    // 5. Fetch game metadata from Pinata — Cloudflare as fallback gateway
    const gateways = [
      `https://gateway.pinata.cloud/ipfs/${metadataCid}`,
      `https://ipfs.io/ipfs/${metadataCid}`,
      `https://w3s.link/ipfs/${metadataCid}`,
      `https://dweb.link/ipfs/${metadataCid}`,
    ];

    let meta: any = null;
    for (const url of gateways) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (r.ok) {
          meta = await r.json();
          break;
        }
      } catch {
        continue;
      }
    }
    if (!meta)
      throw new Error("Could not fetch metadata from IPFS — check your CID");

    // Strip "ipfs://" prefix from image field if present
    const attrs =
      (meta.attributes as { trait_type: string; value: string }[]) ?? [];
    const findAttr = (name: string) =>
      attrs.find((a) => a.trait_type === name)?.value ?? "";

    const imageCid =
      (meta.image as string | undefined)?.replace("ipfs://", "") ?? null;
    const gameName = meta.name ?? "Unknown Game";
    const description = meta.description ?? "";
    const genre = findAttr("Genre");
    // const publisher = findAttr("Publisher");

    // 6. Upsert product row — safe to call repeatedly (updates metadata on re-registration)
    await sql`
      INSERT INTO products (contract_address, name, genre, description, image_cid, metadata_cid)
      VALUES (
        ${contractAddress.toLowerCase()},
        ${gameName},
        ${genre},
        ${description},
        ${imageCid},
        ${metadataCid}
      )
      ON CONFLICT (contract_address) DO UPDATE
      SET name         = EXCLUDED.name,
          genre        = EXCLUDED.genre,
          description  = EXCLUDED.description,
          image_cid    = EXCLUDED.image_cid,
          metadata_cid = EXCLUDED.metadata_cid
    `;

    return NextResponse.json({
      success: true,
      product: { contract_address: contractAddress, name: gameName },
    });
  } catch (error: any) {
    console.error("Register Game API error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 },
    );
  }
}
