// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/api/admin/contract-status/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { createPublicClient, getAddress, http, parseAbi } from "viem";

import { sepolia } from "viem/chains";

export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("address");
    if (!raw)
      return NextResponse.json({ error: "Missing address" }, { status: 400 });
    const contractAddress = getAddress(raw); // checksum normalise + validates format

    // 1. Check DB
    const dbResult = await sql`
      SELECT name, metadata_cid, image_cid
      FROM products
      WHERE LOWER(contract_address) = LOWER(${contractAddress})
      LIMIT 1
    `;
    const dbRow = dbResult.rows[0] ?? null;

    // 2. Check on-chain baseURI
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(process.env.ALCHEMY_RPC_URL),
    });

    let currentBaseURI: string | null = null;
    try {
      // Public getter available on contracts deployed with the updated SoulKey.sol
      currentBaseURI = (await publicClient.readContract({
        address: contractAddress,
        abi: parseAbi(["function baseURI() view returns (string)"]),
        functionName: "baseURI",
      })) as string;
    } catch {
      // Fallback for contracts deployed before baseURI() was added:
      // read the BaseURIUpdated event log to find the last value that was set.
      try {
        const logs = await publicClient.getLogs({
          address: contractAddress,
          event: parseAbi(["event BaseURIUpdated(string newBaseURI)"])[0],
          fromBlock: 0n,
        });
        if (logs.length > 0) {
          const last = logs[logs.length - 1];
          currentBaseURI = (last as any).args.newBaseURI as string;
        }
      } catch {
        // RPC does not support getLogs or contract was never set — leave null
      }
    }

    const expectedBaseURI = `${process.env.NEXT_PUBLIC_APP_URL}/api/nft/${contractAddress}/`;

    return NextResponse.json({
      inDB: !!dbRow,
      dbName: dbRow?.name ?? null,
      metadataCid: dbRow?.metadata_cid ?? null,
      imageCid: dbRow?.image_cid ?? null,
      currentBaseURI,
      expectedBaseURI,
      baseURICorrect: currentBaseURI === expectedBaseURI,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
