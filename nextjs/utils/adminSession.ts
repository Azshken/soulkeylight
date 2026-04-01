// SPDX-License-Identifier: AGPL-3.0-only
// nextjs/utils/adminSession.ts
import { getIronSession, IronSession, SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

// ── Session shape ────────────────────────────────────────────────────────────

export interface AdminSessionData {
  /** One-time nonce stored during the /api/admin/nonce step. */
  nonce?: string;
  /** Checksummed Ethereum address of the authenticated admin. */
  address?: string;
  /** True only after /api/admin/verify succeeds. */
  authenticated?: boolean;
}

// ── Session options ──────────────────────────────────────────────────────────

// SESSION_SECRET must be ≥ 32 characters. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Never use NEXT_PUBLIC_ prefix — this must stay server-only.
export const SESSION_OPTIONS: SessionOptions = {
  password: process.env.SESSION_SECRET as string,
  cookieName: "soulkey-admin-session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    // Session lives 8 hours. Re-login required after that.
    maxAge: 8 * 60 * 60,
  },
};

// ── Session helper ───────────────────────────────────────────────────────────

export async function getAdminSession(): Promise<IronSession<AdminSessionData>> {
  return getIronSession<AdminSessionData>(await cookies(), SESSION_OPTIONS);
}

// ── Auth guard ───────────────────────────────────────────────────────────────

/**
 * Call at the top of every protected admin route.
 * Returns { session, address } on success.
 * Returns { error: NextResponse } when the request is not authenticated.
 *
 * Usage:
 *   const auth = await requireAdminSession();
 *   if ("error" in auth) return auth.error;
 *   const { address } = auth;
 */
export async function requireAdminSession(): Promise<
  { address: string; session: IronSession<AdminSessionData> } | { error: NextResponse }
> {
  const session = await getAdminSession();

  if (!session.authenticated || !session.address) {
    return {
      error: NextResponse.json(
        { success: false, error: "Not authenticated. Please sign in." },
        { status: 401 }
      ),
    };
  }

  return { address: session.address, session };
}
