// SPDX-License-Identifier: AGPL-3.0-only
// nextjs/app/api/admin/logout/route.ts
import { NextResponse } from "next/server";
import { getAdminSession } from "@/utils/adminSession";

/**
 * POST /api/admin/logout
 *
 * Destroys the admin session. Called by AdminClient when the wallet
 * disconnects or the address changes, preventing a stale session from
 * being used by a different wallet that connects afterward.
 */
export async function POST(): Promise<NextResponse> {
  const session = await getAdminSession();
  session.destroy();
  return NextResponse.json({ success: true });
}
