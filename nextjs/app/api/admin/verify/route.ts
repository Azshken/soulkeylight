// SPDX-License-Identifier: AGPL-3.0-only
// nextjs/app/api/admin/verify/route.ts
import { NextRequest, NextResponse } from "next/server";
import { parseSiweMessage } from "viem/siwe";
import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { getAdminSession } from "@/utils/adminSession";

/**
 * POST /api/admin/verify
 * Body: { message: string (EIP-4361 formatted), signature: "0x..." }
 *
 * Three-layer verification — all using viem, zero siwe package dependency:
 *   1. parseSiweMessage: structural parse of the EIP-4361 string.
 *   2. Manual field checks: domain, nonce (one-time use), expiry.
 *   3. publicClient.verifyMessage: cryptographic signature recovery.
 *   4. On-chain: recovered address must own MasterKeyVault.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession();

  // Always consume the nonce regardless of outcome — prevents replay attempts.
  const storedNonce = session.nonce;
  session.nonce = undefined;
  session.authenticated = false;
  session.address = undefined;

  try {
    const body = await req.json().catch(() => null);
    if (!body?.message || !body?.signature) {
      await session.save();
      return NextResponse.json(
        { success: false, error: "Missing message or signature" },
        { status: 400 }
      );
    }

    const { message, signature } = body as { message: string; signature: `0x${string}` };

    // ── 1. Parse the EIP-4361 string into fields ──────────────────────────
    let fields: ReturnType<typeof parseSiweMessage>;
    try {
      fields = parseSiweMessage(message);
    } catch {
      await session.save();
      return NextResponse.json(
        { success: false, error: "Malformed SIWE message" },
        { status: 400 }
      );
    }

    if (!fields.address) {
      await session.save();
      return NextResponse.json(
        { success: false, error: "SIWE message missing address" },
        { status: 400 }
      );
    }

    // ── 2a. Domain check ──────────────────────────────────────────────────
    // Blocks a phishing site from replaying a signature issued for your domain.
    const expectedDomain = req.headers.get("host") ?? "";
    if (fields.domain !== expectedDomain) {
      await session.save();
      return NextResponse.json(
        { success: false, error: `Domain mismatch: expected ${expectedDomain}` },
        { status: 401 }
      );
    }

    // ── 2b. Nonce check ───────────────────────────────────────────────────
    if (!storedNonce || fields.nonce !== storedNonce) {
      await session.save();
      return NextResponse.json(
        { success: false, error: "Invalid or expired nonce" },
        { status: 401 }
      );
    }

    // ── 2c. Expiry check ──────────────────────────────────────────────────
    if (fields.expirationTime && new Date(fields.expirationTime) < new Date()) {
      await session.save();
      return NextResponse.json(
        { success: false, error: "SIWE message has expired" },
        { status: 401 }
      );
    }

    // ── 3. Cryptographic signature verification ───────────────────────────
    // publicClient.verifyMessage recovers the signer address and compares it
    // against fields.address — the address stated in the message itself.
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(process.env.ALCHEMY_RPC_URL),
    });

    const isValidSig = await publicClient.verifyMessage({
      address: fields.address as `0x${string}`,
      message,
      signature,
    });

    if (!isValidSig) {
      await session.save();
      return NextResponse.json(
        { success: false, error: "Invalid signature" },
        { status: 401 }
      );
    }

    // ── 4. On-chain ownership check ───────────────────────────────────────
    const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS as `0x${string}` | undefined;
    if (!vaultAddress) {
      await session.save();
      return NextResponse.json(
        { success: false, error: "Vault address not configured" },
        { status: 500 }
      );
    }

    const vaultOwner = await publicClient.readContract({
      address: vaultAddress,
      abi: parseAbi(["function owner() view returns (address)"]),
      functionName: "owner",
    });

    if (vaultOwner.toLowerCase() !== fields.address.toLowerCase()) {
      await session.save();
      return NextResponse.json(
        { success: false, error: "Address is not the vault owner" },
        { status: 403 }
      );
    }

    // ── Success ───────────────────────────────────────────────────────────
    session.address = fields.address;
    session.authenticated = true;
    await session.save();

    return NextResponse.json({ success: true, address: fields.address });
  } catch (error: any) {
    await session.save();
    console.error("SIWE verify error:", error);
    return NextResponse.json(
      { success: false, error: error.message ?? "Internal server error" },
      { status: 500 }
    );
  }
}
