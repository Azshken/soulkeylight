// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/api/redeem/confirm/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

import { confirmRedemption, recordReserveRelease } from "@/utils/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body)
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );

    const {
      cdkeyId,
      userAddress,
      txHash,
      blockNumber,
      contractAddress,
      tokenId,
    } = body;

    if (
      !cdkeyId ||
      !userAddress ||
      !txHash ||
      !blockNumber ||
      !contractAddress ||
      !tokenId
    ) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 },
      );
    }

    // 1. Finalise redemption record: sets redeemed_by, redeemed_at, tx data
    //    and nulls out encrypted_key on the cd_keys row (server copy no longer needed)
    await confirmRedemption({
      cdkeyId: Number(cdkeyId),
      redeemedBy: userAddress,
      redemptionTxHash: txHash,
      blockNumber: BigInt(blockNumber),
    });

    // 2. Fetch product data from DB — needed to build the frozen metadata snapshot
    const productResult = await sql`
      SELECT p.name, p.genre, p.description, p.image_claimed_cid
      FROM products p
      WHERE LOWER(p.contract_address) = LOWER(${contractAddress})
      LIMIT 1
    `;

    if (productResult.rows[0]) {
      const product = productResult.rows[0];
      const gameName = product.name ?? "Unknown Game";
      const genre = product.genre ?? "";
      const imageCid = product.image_claimed_cid ?? null;

      // Only attempt Pinata upload if we have the image CID and JWT configured
      if (imageCid && process.env.PINATA_JWT) {
        const frozenMetadata = {
          name: `${gameName} CD Key #${tokenId}`,
          description:
            product.description || `A claimed game key for ${gameName}.`,
          image: `ipfs://${imageCid}`,
          external_url: process.env.NEXT_PUBLIC_APP_URL ?? "",
          attributes: [
            { trait_type: "Game", value: gameName },
            { trait_type: "Genre", value: genre },
            { trait_type: "Status", value: "Soulbound" },
          ],
        };

        try {
          const pinataRes = await fetch(
            "https://api.pinata.cloud/pinning/pinJSONToIPFS",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.PINATA_JWT}`,
              },
              body: JSON.stringify({
                pinataContent: frozenMetadata,
                pinataMetadata: {
                  name: `soulkey-${contractAddress}-token-${tokenId}`,
                },
              }),
              signal: AbortSignal.timeout(10000),
            },
          );

          if (pinataRes.ok) {
            const pinataData = await pinataRes.json();
            const frozenCid: string = pinataData.IpfsHash;

            // Store frozen CID — tokenURI route redirects to this permanently after claim
            await sql`
              UPDATE redemptions
              SET frozen_metadata_cid = ${frozenCid}
              WHERE cdkey_id = ${Number(cdkeyId)}
            `;
          } else {
            // Pinata upload failed — log but don't block the claim confirmation.
            // The tokenURI route falls back to dynamic JSON if frozen_metadata_cid is null.
            console.error("Pinata upload failed:", await pinataRes.text());
          }
        } catch (pinataErr) {
          // Network timeout or Pinata outage — same fallback as above
          console.error("Pinata upload error (non-fatal):", pinataErr);
        }
      }
    }

    // 3. Record reserve release (claim path)
    await recordReserveRelease({
      cdkeyId: Number(cdkeyId),
      releaseReason: "claim",
      txHash,
      blockNumber: BigInt(blockNumber),
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Redeem Confirm API error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 },
    );
  }
}
