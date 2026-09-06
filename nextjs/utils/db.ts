// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/utils/db.ts
import { db, sql, type VercelPoolClient } from "@vercel/postgres";

export const RESERVATION_TTL_SQL = "15 minutes";

export interface CDKeyRow {
  id: number;
  encrypted_key: string;
  commitment_hash: string;
  batch_id: number;
  created_at: Date;
}

export interface CDKeyWithRedemption extends CDKeyRow {
  wallet_encrypted_cdkey: string | null;
  redemption_id: number | null;
}

export interface MintParams {
  contractAddress: string;
  commitmentHash: string;
  tokenId: bigint;
  mintedBy: string;
  mintTxHash: string;
  blockNumber: bigint;
  paymentToken: string;
  paymentAmount: string;
}

export async function getOrCreateProduct(
  contractAddress: string,
  name = "Unknown Game",
  genre = "",
): Promise<number> {
  const existing = await sql`
    SELECT product_id FROM products
    WHERE LOWER(contract_address) = LOWER(${contractAddress})
    LIMIT 1
  `;
  if (existing.rows.length > 0) return existing.rows[0].product_id as number;

  const inserted = await sql`
    INSERT INTO products (contract_address, name, genre, description)
    VALUES (${contractAddress}, ${name}, ${genre}, '')
    RETURNING product_id
  `;
  return inserted.rows[0].product_id as number;
}

export async function createBatch(
  productId: number,
  notes: string,
): Promise<number> {
  const result = await sql`
    INSERT INTO batches (product_id, notes, created_at)
    VALUES (${productId}, ${notes}, NOW())
    RETURNING batch_id
  `;
  return result.rows[0].batch_id as number;
}

export async function insertCDKeys(
  batchId: number,
  keys: { encrypted_key: string; commitment_hash: string }[],
): Promise<void> {
  for (const key of keys) {
    await sql`
      INSERT INTO cd_keys (batch_id, encrypted_key, commitment_hash, created_at)
      VALUES (${batchId}, ${key.encrypted_key}, ${key.commitment_hash}, NOW())
      ON CONFLICT (commitment_hash) DO NOTHING
    `;
  }
}

export async function reserveCDKeyForWallet(
  contractAddress: string,
  walletAddress: string,
): Promise<CDKeyRow | null> {
  const client: VercelPoolClient = await db.connect();
  try {
    await client.sql`BEGIN`;

    await client.sql`
      UPDATE cd_keys
      SET reserved_by = NULL, reserved_at = NULL
      WHERE reserved_by IS NOT NULL
        AND (reserved_at IS NULL OR reserved_at < NOW() - INTERVAL '15 minutes')
    `;

    const existing = await client.sql`
      SELECT ck.id, ck.encrypted_key, ck.commitment_hash, ck.batch_id, ck.created_at
      FROM cd_keys ck
      JOIN batches b ON b.batch_id = ck.batch_id
      JOIN products p ON p.product_id = b.product_id
      LEFT JOIN mints m ON m.cdkey_id = ck.id
      LEFT JOIN refunds rf ON rf.cdkey_id = ck.id
      LEFT JOIN redemptions r ON r.cdkey_id = ck.id
      WHERE LOWER(p.contract_address) = LOWER(${contractAddress})
        AND p.is_active = TRUE
        AND LOWER(ck.reserved_by) = LOWER(${walletAddress})
        AND ck.reserved_at >= NOW() - INTERVAL '15 minutes'
        AND r.redemption_tx_hash IS NULL
        AND (
          m.mint_id IS NULL
          OR (rf.refund_id IS NOT NULL AND rf.refunded_at >= COALESCE(m.minted_at, '-infinity'::timestamp))
        )
      LIMIT 1
    `;

    if (existing.rows[0]) {
      await client.sql`COMMIT`;
      return existing.rows[0] as CDKeyRow;
    }

    const result = await client.sql`
      SELECT ck.id, ck.encrypted_key, ck.commitment_hash, ck.batch_id, ck.created_at
      FROM cd_keys ck
      JOIN batches b ON b.batch_id = ck.batch_id
      JOIN products p ON p.product_id = b.product_id
      LEFT JOIN mints m ON m.cdkey_id = ck.id
      LEFT JOIN refunds rf ON rf.cdkey_id = ck.id
      LEFT JOIN redemptions r ON r.cdkey_id = ck.id
      WHERE LOWER(p.contract_address) = LOWER(${contractAddress})
        AND p.is_active = TRUE
        AND ck.reserved_by IS NULL
        AND r.redemption_tx_hash IS NULL
        AND (
          m.mint_id IS NULL
          OR (rf.refund_id IS NOT NULL AND rf.refunded_at >= COALESCE(m.minted_at, '-infinity'::timestamp))
        )
      ORDER BY ck.created_at ASC
      LIMIT 1
      FOR UPDATE OF ck SKIP LOCKED
    `;

    if (!result.rows[0]) {
      await client.sql`ROLLBACK`;
      return null;
    }

    const key = result.rows[0] as CDKeyRow;

    await client.sql`
      UPDATE cd_keys
      SET reserved_by = ${walletAddress}, reserved_at = NOW()
      WHERE id = ${key.id}
    `;

    await client.sql`COMMIT`;
    return key;
  } catch (error) {
    await client.sql`ROLLBACK`;
    throw error;
  } finally {
    client.release();
  }
}

export async function getAvailableKeyCount(
  contractAddress: string,
): Promise<number> {
  const result = await sql`
    SELECT COUNT(*) AS cnt
    FROM cd_keys ck
    JOIN batches b ON b.batch_id = ck.batch_id
    JOIN products p ON p.product_id = b.product_id
    LEFT JOIN mints m ON m.cdkey_id = ck.id
    LEFT JOIN refunds rf ON rf.cdkey_id = ck.id
    LEFT JOIN redemptions r ON r.cdkey_id = ck.id
    WHERE LOWER(p.contract_address) = LOWER(${contractAddress})
      AND p.is_active = TRUE
      AND (
        ck.reserved_by IS NULL
        OR ck.reserved_at IS NULL
        OR ck.reserved_at < NOW() - INTERVAL '15 minutes'
      )
      AND r.redemption_tx_hash IS NULL
      AND (
        m.mint_id IS NULL
        OR (rf.refund_id IS NOT NULL AND rf.refunded_at >= COALESCE(m.minted_at, '-infinity'::timestamp))
      )
  `;
  return Number(result.rows[0].cnt);
}

export async function reserveAndMint(params: MintParams): Promise<CDKeyRow> {
  const client: VercelPoolClient = await db.connect();
  try {
    await client.sql`BEGIN`;

    const alreadyLinked = await client.sql`
      SELECT ck.id, ck.encrypted_key, ck.commitment_hash, ck.batch_id, ck.created_at
      FROM mints m
      JOIN cd_keys ck ON ck.id = m.cdkey_id
      WHERE LOWER(m.mint_tx_hash) = LOWER(${params.mintTxHash})
      LIMIT 1
    `;
    if (alreadyLinked.rows[0]) {
      await client.sql`COMMIT`;
      return alreadyLinked.rows[0] as CDKeyRow;
    }

    const normalizedHash = params.commitmentHash.replace(/^0x/i, "").toLowerCase();
    const prefixedHash = `0x${normalizedHash}`;

    const keyResult = await client.sql`
      SELECT ck.id, ck.encrypted_key, ck.commitment_hash, ck.batch_id, ck.created_at
      FROM cd_keys ck
      JOIN batches b ON b.batch_id = ck.batch_id
      JOIN products p ON p.product_id = b.product_id
      LEFT JOIN mints m ON m.cdkey_id = ck.id
      LEFT JOIN refunds rf ON rf.cdkey_id = ck.id
      LEFT JOIN redemptions r ON r.cdkey_id = ck.id
      WHERE LOWER(ck.commitment_hash) IN (${normalizedHash}, ${prefixedHash})
        AND LOWER(p.contract_address) = LOWER(${params.contractAddress})
        AND r.redemption_tx_hash IS NULL
        AND (
          m.mint_id IS NULL
          OR (rf.refund_id IS NOT NULL AND rf.refunded_at >= COALESCE(m.minted_at, '-infinity'::timestamp))
        )
      FOR UPDATE OF ck SKIP LOCKED
    `;

    if (!keyResult.rows[0]) {
      await client.sql`ROLLBACK`;
      throw new Error(
        "CD key no longer available — may already be minted or claimed. " +
          "If the chain tx succeeded, this token was not written to the DB.",
      );
    }

    const key = keyResult.rows[0] as CDKeyRow;

    await client.sql`
      INSERT INTO mints (
        cdkey_id, token_id, minted_by, minted_at,
        mint_tx_hash, block_number, payment_token, payment_amount
      ) VALUES (
        ${key.id},
        ${params.tokenId.toString()},
        ${params.mintedBy},
        NOW(),
        ${params.mintTxHash},
        ${params.blockNumber.toString()},
        ${params.paymentToken},
        ${params.paymentAmount}
      )
      ON CONFLICT (cdkey_id) DO UPDATE SET
        token_id       = EXCLUDED.token_id,
        minted_by      = EXCLUDED.minted_by,
        minted_at      = NOW(),
        mint_tx_hash   = EXCLUDED.mint_tx_hash,
        block_number   = EXCLUDED.block_number,
        payment_token  = EXCLUDED.payment_token,
        payment_amount = EXCLUDED.payment_amount
    `;

    // Remint is a live token again. Prior refund is history on-chain only.
    await client.sql`DELETE FROM refunds WHERE cdkey_id = ${key.id}`;

    await client.sql`
      DELETE FROM redemptions
      WHERE cdkey_id = ${key.id}
        AND redemption_tx_hash IS NULL
    `;

    await client.sql`
      UPDATE cd_keys
      SET reserved_by = NULL, reserved_at = NULL
      WHERE id = ${key.id}
    `;

    await client.sql`COMMIT`;
    return key;
  } catch (error) {
    await client.sql`ROLLBACK`;
    throw error;
  } finally {
    client.release();
  }
}

export async function getCDKeyByTokenId(
  tokenId: bigint,
  contractAddress: string,
) {
  const result = await sql`
    SELECT
      ck.id,
      ck.encrypted_key,
      ck.commitment_hash,
      ck.batch_id,
      ck.created_at,
      r.wallet_encrypted_cdkey,
      r.redemption_id
    FROM mints m
    JOIN cd_keys ck ON ck.id = m.cdkey_id
    JOIN batches b ON b.batch_id = ck.batch_id
    JOIN products p ON p.product_id = b.product_id
    LEFT JOIN redemptions r ON r.cdkey_id = ck.id
    LEFT JOIN refunds rf ON rf.cdkey_id = ck.id
    WHERE m.token_id = ${tokenId.toString()}
      AND LOWER(p.contract_address) = LOWER(${contractAddress})
      AND (rf.refund_id IS NULL OR m.minted_at > rf.refunded_at)
    LIMIT 1
  `;
  return (result.rows[0] as CDKeyWithRedemption) ?? null;
}

export async function filterExistingHashes(
  hashes: string[],
): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();

  const placeholders = hashes.map((h) => `'${h.replace(/'/g, "''")}'`).join(", ");
  const result = await sql.query(
    `SELECT commitment_hash FROM cd_keys WHERE commitment_hash IN (${placeholders})`,
  );
  return new Set(result.rows.map((r) => r.commitment_hash as string));
}

export async function createRedemptionRecord(
  cdkeyId: number,
  walletEncryptedCdkey: string,
): Promise<number> {
  const result = await sql`
    INSERT INTO redemptions (cdkey_id, wallet_encrypted_cdkey)
    VALUES (${cdkeyId}, ${walletEncryptedCdkey})
    ON CONFLICT (cdkey_id) DO UPDATE
      SET wallet_encrypted_cdkey = EXCLUDED.wallet_encrypted_cdkey
    RETURNING redemption_id
  `;
  return result.rows[0].redemption_id as number;
}

export async function confirmRedemption(params: {
  cdkeyId: number;
  redeemedBy: string;
  redemptionTxHash: string;
  blockNumber: bigint;
}): Promise<void> {
  const result = await sql`
    UPDATE redemptions
    SET redeemed_by         = ${params.redeemedBy},
        redeemed_at         = NOW(),
        redemption_tx_hash  = ${params.redemptionTxHash},
        block_number        = ${params.blockNumber.toString()}
    WHERE cdkey_id = ${params.cdkeyId}
  `;

  if (result.rowCount === 0) {
    throw new Error(
      `confirmRedemption: no partial redemption record found for cdkeyId ${params.cdkeyId}. ` +
      `POST /api/redeem must complete successfully before confirm is called.`
    );
  }
}

export async function recordReserveRelease(params: {
  cdkeyId: number;
  releaseReason: "claim" | "expiry";
  txHash: string;
  blockNumber: bigint;
}): Promise<void> {
  await sql`
    INSERT INTO reserve_releases (cdkey_id, release_reason, released_at, tx_hash, block_number)
    VALUES (${params.cdkeyId}, ${params.releaseReason}, NOW(), ${params.txHash}, ${params.blockNumber.toString()})
    ON CONFLICT (tx_hash) DO NOTHING
  `;
}

export async function recordRefund(params: {
  cdkeyId: number;
  refundedBy: string;
  refundReason: string;
  refundTxHash: string;
  blockNumber: bigint;
  paymentToken: string;
  refundedAmount: string;
  feeRetained: string;
}): Promise<void> {
  // One row per key. Delete+insert so SERIAL refund_id advances (re-refund after remint).
  await sql`DELETE FROM refunds WHERE cdkey_id = ${params.cdkeyId}`;
  await sql`
    INSERT INTO refunds (
      cdkey_id, refunded_by, refunded_at, refund_reason,
      refund_tx_hash, block_number, payment_token, refunded_amount, fee_retained
    ) VALUES (
      ${params.cdkeyId},
      ${params.refundedBy},
      NOW(),
      ${params.refundReason},
      ${params.refundTxHash},
      ${params.blockNumber.toString()},
      ${params.paymentToken},
      ${params.refundedAmount},
      ${params.feeRetained}
    )
  `;
}
