// SPDX-License-Identifier: AGPL-3.0-only
// nextjs/app/api/admin/register-game/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { requireAdminSession } from "@/utils/adminSession";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth: session check (replaces timestamp + verifyMessage) ─────────────
  const auth = await requireAdminSession();
  if ("error" in auth) return auth.error;
  const { address: walletAddress } = auth;

  try {
    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const { contractAddress, metadataCid } = body;

    if (!contractAddress || !metadataCid) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
      return NextResponse.json(
        { success: false, error: `Invalid address: ${contractAddress}` },
        { status: 400 }
      );
    }

    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(process.env.ALCHEMY_RPC_URL),
    });

    // ── On-chain: verify session address owns this specific game contract ──
    // walletAddress comes from the verified session — not from the request body.
    const contractOwner = await publicClient.readContract({
      address: contractAddress as `0x${string}`,
      abi: parseAbi(["function owner() view returns (address)"]),
      functionName: "owner",
    });

    if (contractOwner.toLowerCase() !== walletAddress.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: not the contract owner" },
        { status: 403 }
      );
    }

    // ── Verify game is registered in the vault ────────────────────
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
          error: "Contract is not registered in MasterKeyVault. Call registerGame first.",
        },
        { status: 400 }
      );
    }

    // ── Fetch game metadata from Pinata ───────────────────────
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

    if (!meta) throw new Error("Could not fetch metadata from IPFS — check your CID");

    const attrs = (meta.attributes as { trait_type: string; value: string }[]) ?? [];
    const findAttr = (name: string) => attrs.find((a) => a.trait_type === name)?.value ?? "";
    const imageCid = (meta.image as string | undefined)?.replace("https://purple-historical-sawfish-33.mypinata.cloud/ipfs/", "") ?? null;
    const gameName = meta.name ?? "Unknown Game";
    const description = meta.description ?? "";
    const genre = findAttr("Genre");

    // ── Upsert product row ────────────────────────────
    await sql`
      INSERT INTO products (contract_address, name, genre, description, image_cid, metadata_cid)
      VALUES (${contractAddress.toLowerCase()}, ${gameName}, ${genre}, ${description}, ${imageCid}, ${metadataCid})
      ON CONFLICT (contract_address) DO UPDATE SET
        name         = EXCLUDED.name,
        genre        = EXCLUDED.genre,
        description  = EXCLUDED.description,
        image_cid    = EXCLUDED.image_cid,
        metadata_cid = EXCLUDED.metadata_cid,
        is_active    = true
    `;

    return NextResponse.json({
      success: true,
      product: { contract_address: contractAddress, name: gameName },
    });
  } catch (error: any) {
    console.error("Register Game API error:", error);
    return NextResponse.json(
      { success: false, error: error.message ?? "Internal server error" },
      { status: 500 }
    );
  }
}
