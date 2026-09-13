// app/api/nft/[contractAddress]/[tokenId]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { getAddress } from "viem";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ contractAddress: string; tokenId: string }> },
) {
  try {
    const { contractAddress: rawAddress, tokenId: rawTokenId } = await params; // checksum normalise
    const contractAddress = getAddress(rawAddress);
    const tokenId = BigInt(rawTokenId);

    const result = await sql`
      SELECT name, genre, description, image_cid, image_claimed_cid
      FROM products
      WHERE LOWER(contract_address) = LOWER(${contractAddress})
      LIMIT 1
    `;
    if (!result.rows[0]) {
      return NextResponse.json(
        { error: "Contract not found" },
        { status: 404 },
      );
    }
    const { name, genre, description, image_cid, image_claimed_cid } =
      result.rows[0];

    // After fetching product from DB, also check for frozen metadata.
    // mints.token_id is scoped PER CONTRACT (no global unique — each game
    // starts at 1), so this lookup must join through products and filter on
    // the contract address; keying on token_id alone collides across games.
    const redemptionResult = await sql`
      SELECT r.frozen_metadata_cid
      FROM mints m
      JOIN cd_keys ck ON ck.id = m.cdkey_id
      JOIN batches b ON b.batch_id = ck.batch_id
      JOIN products p ON p.product_id = b.product_id
      JOIN redemptions r ON r.cdkey_id = ck.id
      WHERE m.token_id = ${tokenId.toString()}
      AND LOWER(p.contract_address) = LOWER(${contractAddress})
      AND r.frozen_metadata_cid IS NOT NULL
      LIMIT 1
    `;

    const frozenCid = redemptionResult.rows[0]?.frozen_metadata_cid ?? null;

    if (frozenCid) {
      // Permanent redirect to IPFS — this response never changes
      return NextResponse.redirect(
        `https://ipfs.io/ipfs/${frozenCid}`,
        { status: 301 }, // 301 = permanent, marketplaces cache this
      );
    }
    // No frozen CID — token is unclaimed, serve dynamic JSON

    // DB status check — replaces the RPC call
    // Faster, doesn't fail on RPC hiccups, more reliant on the DB
    const claimResult = await sql`
      SELECT r.redeemed_at
      FROM mints m
      JOIN cd_keys ck ON ck.id = m.cdkey_id
      JOIN batches b ON b.batch_id = ck.batch_id
      JOIN products p ON p.product_id = b.product_id
      LEFT JOIN redemptions r ON r.cdkey_id = ck.id
      WHERE m.token_id = ${tokenId.toString()}
      AND LOWER(p.contract_address) = LOWER(${contractAddress})
      LIMIT 1
    `;
    const isClaimed = !!claimResult.rows[0]?.redeemed_at;

    // Same fallback as the confirm route's Pinata payload: claimed cover art
    // when present, else the storefront image.
    const imageCid = isClaimed ? image_claimed_cid || image_cid : image_cid;

    const metadata = {
      name: `${name} CD Key #${tokenId}`,
      description:
        description ||
        `A game key for ${name}. Claim it on-chain to receive your CD key.`,
      image: imageCid ? `ipfs://${imageCid}` : "",
      external_url: process.env.NEXT_PUBLIC_APP_URL ?? "",
      attributes: [
        { trait_type: "Game", value: name },
        { trait_type: "Genre", value: genre },
        { trait_type: "Status", value: isClaimed ? "Claimed" : "Unclaimed" },
        { trait_type: "Soulbound", value: isClaimed ? "Yes" : "No" },
      ],
    };

    return NextResponse.json(metadata, {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
