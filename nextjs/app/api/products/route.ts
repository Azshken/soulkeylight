// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/api/products/route.ts
//
// Vault verification happens at registration time (register-game route), so we trust the DB here.
// Cache-Control lets Vercel edge serve this for 60s before revalidating — products change rarely
// so there is no need to hit the DB on every page load.
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export async function GET() {
  try {
    const result = await sql`
      SELECT product_id, contract_address, name, genre, description, image_cid
      FROM products
      WHERE is_active = true
      ORDER BY product_id ASC
    `;
    return NextResponse.json(
      { success: true, products: result.rows },
      {
        headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
      },
    );
  } catch (error: any) {
    console.error("Products API error", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 },
    );
  }
}
