// SPDX-License-Identifier: AGPL-3.0-only
// nextjs/app/api/admin/nonce/route.ts
import { NextResponse } from "next/server";
import { generateSiweNonce } from "viem/siwe";
import { getAdminSession } from "@/utils/adminSession";

/**
 * GET /api/admin/nonce
 *
 * Generates a spec-compliant alphanumeric SIWE nonce (EIP-4361 requires
 * alphanumeric, ≥8 chars — crypto.randomUUID() fails this due to hyphens).
 * Stores it in the session and returns it to the client for embedding in
 * the SIWE message before signing.
 */
export async function GET(): Promise<NextResponse> {
  const session = await getAdminSession();

  session.nonce = generateSiweNonce();
  // Clear any stale authenticated state — a fresh login is starting.
  session.authenticated = false;
  session.address = undefined;
  await session.save();

  return NextResponse.json({ nonce: session.nonce });
}
