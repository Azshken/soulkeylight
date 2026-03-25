import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { verifyMessage } from "viem";

const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body)
      return NextResponse.json(
        { success: false, error: "Invalid JSON" },
        { status: 400 },
      );

    const { walletAddress, contractAddress, signature, message, timestamp } =
      body;
    if (
      !walletAddress ||
      !contractAddress ||
      !signature ||
      !message ||
      !timestamp
    )
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 },
      );

    const messageAge = Date.now() - Number(timestamp);
    if (messageAge > MAX_MESSAGE_AGE_MS || messageAge < 0)
      return NextResponse.json(
        { success: false, error: "Signature expired" },
        { status: 401 },
      );

    const isValid = await verifyMessage({
      address: walletAddress,
      message,
      signature,
    });
    if (!isValid)
      return NextResponse.json(
        { success: false, error: "Invalid signature" },
        { status: 401 },
      );

    const result = await sql`
      UPDATE products SET is_active = false
      WHERE LOWER(contract_address) = LOWER(${contractAddress})
      RETURNING name
    `;
    if (!result.rows[0])
      return NextResponse.json(
        { success: false, error: "Contract not found in DB" },
        { status: 404 },
      );

    return NextResponse.json({ success: true, name: result.rows[0].name });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
