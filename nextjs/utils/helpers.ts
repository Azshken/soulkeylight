// SPDX-License-Identifier: AGPL-3.0-only
// nextjs/utils/helpers.ts

/**
 * Ensures a hex string is 0x-prefixed AND is exactly 32 bytes (64 hex chars).
 * Throws a descriptive error if the server returned a malformed value —
 * without this guard the failure surfaces as an opaque viem ABI encoding error
 * that gives the user no actionable information.
 */
export function toBytes32(hex: string): `0x${string}` {
  const normalized = (hex.startsWith('0x') ? hex : '0x' + hex) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      `Server returned a malformed 32-byte hash: "${normalized}". ` +
        `Expected 0x followed by exactly 64 hex characters.`,
    );
  }
  return normalized;
}

/**
 * Validates variable-length hex bytes without constraining length.
 */
export function toHexBytes(hex: string): `0x${string}` {
  const normalized = (hex.startsWith('0x') ? hex : '0x' + hex) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]*$/.test(normalized))
    throw new Error(`Server returned a malformed hex value`);
  return normalized;
}