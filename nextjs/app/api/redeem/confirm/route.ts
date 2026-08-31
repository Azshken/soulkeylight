// SPDX-License-Identifier: AGPL-3.0-only
// nextjs/app/api/redeem/confirm/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { createPublicClient, http, getAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { SOULKEY_ABI } from '@/utils/abis';
import { confirmRedemption, recordReserveRelease } from '@/utils/db';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });

    const { cdkeyId, userAddress, txHash, blockNumber, contractAddress, tokenId } = body;
    if (!cdkeyId || !userAddress || !txHash || !blockNumber || !contractAddress || !tokenId)
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });

    const rpcUrl = process.env.ALCHEMY_RPC_URL;
    if (!rpcUrl) return NextResponse.json({ success: false, error: 'Server misconfiguration: missing RPC' }, { status: 500 });

    const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });

    if (!receipt || receipt.status !== 'success') {
      return NextResponse.json(
        { success: false, error: 'Transaction not confirmed or reverted on-chain. Key is safe — please retry.' },
        { status: 400 }
      );
    }

    const claimTimestamp = await publicClient.readContract({
      address: getAddress(contractAddress),
      abi: SOULKEY_ABI,
      functionName: 'getClaimTimestamp',
      args: [BigInt(tokenId)],
    }) as bigint;

    if (claimTimestamp === 0n) {
      return NextResponse.json(
        { success: false, error: 'Token not yet claimed on-chain. Key is safe — please retry.' },
        { status: 400 }
      );
    }

    await confirmRedemption({
      cdkeyId: Number(cdkeyId),
      redeemedBy: userAddress,
      redemptionTxHash: txHash,
      blockNumber: BigInt(blockNumber),
    });

    const productResult = await sql`
      SELECT p.name, p.genre, p.description, p.image_claimed_cid
      FROM products p
      WHERE LOWER(p.contract_address) = LOWER(${contractAddress})
      LIMIT 1
    `;

    if (productResult.rows[0]) {
      const { name, genre, description, image_claimed_cid: imageCid } = productResult.rows[0];

      if (imageCid && process.env.PINATA_JWT) {
        const frozenMetadata = {
          name: `${name} CD Key #${tokenId}`,
          description: `${description} A claimed game key for ${name}.`,
          image: `https://purple-historical-sawfish-33.mypinata.cloud/ipfs/${imageCid}`,
          external_url: process.env.NEXT_PUBLIC_APP_URL ?? '',
          attributes: [
            { trait_type: 'Game',     value: name  },
            { trait_type: 'Genre',    value: genre },
            { trait_type: 'Status',   value: 'Soulbound' },
          ],
        };
        try {
          const pinataRes = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${process.env.PINATA_JWT}`,
            },
            body: JSON.stringify({
              pinataContent: frozenMetadata,
              pinataMetadata: { name: `soulkey-${contractAddress}-token-${tokenId}` },
            }),
            signal: AbortSignal.timeout(10_000),
          });

          if (pinataRes.ok) {
            const { IpfsHash: frozenCid } = await pinataRes.json();
            await sql`
              UPDATE redemptions SET frozen_metadata_cid = ${frozenCid} WHERE cdkey_id = ${Number(cdkeyId)}
            `;
          } else {
            console.error('Pinata upload failed', await pinataRes.text());
          }
        } catch (pinataErr) {
          console.error('Pinata upload error (non-fatal):', pinataErr);
        }
      }
    }

    await recordReserveRelease({
      cdkeyId: Number(cdkeyId),
      releaseReason: 'claim',
      txHash,
      blockNumber: BigInt(blockNumber),
    });

    // AES copy in cd_keys.encrypted_key is RETAINED for the v2 hybrid migration.

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Redeem Confirm API error:', error);
    return NextResponse.json({ success: false, error: error.message ?? 'Internal server error' }, { status: 500 });
  }
}
