// SPDX-License-Identifier: AGPL-3.0-only
// nextjs/app/api/admin/deregister-game/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { requireAdminSession } from "@/utils/adminSession";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const auth = await requireAdminSession();
  if ("error" in auth) return auth.error;
  const { address: walletAddress } = auth;

  try {
    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const { contractAddress } = body;

    if (!contractAddress || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
      return NextResponse.json(
        { success: false, error: "Missing or invalid contract address" },
        { status: 400 }
      );
    }

    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(process.env.ALCHEMY_RPC_URL),
    });

    // ── On-chain ownership check ──────────────────────────────────────────
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

    // ── Mark inactive in DB ───────────────────────────────────────────────
    const result = await sql`
      UPDATE products
      SET is_active = false
      WHERE LOWER(contract_address) = LOWER(${contractAddress})
      RETURNING name
    `;

    if (result.rowCount === 0) {
      return NextResponse.json(
        { success: false, error: "Game not found in database" },
        { status: 404 }
      );
    }

    const gameName = result.rows[0].name as string;

    return NextResponse.json({ success: true, name: gameName });
  } catch (error: any) {
    console.error("Deregister Game API error:", error);
    return NextResponse.json(
      { success: false, error: error.message ?? "Internal server error" },
      { status: 500 }
    );
  }
}
