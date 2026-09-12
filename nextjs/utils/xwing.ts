// SPDX-License-Identifier: AGPL-3.0-only
// X-Wing (ML-KEM-768 + X25519) claim-ciphertext helpers — browser + Node safe.
// Do not import Node `crypto` here; AES-GCM goes through WebCrypto.
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  decryptX25519WebCrypto,
  hexToExactBytes,
  toArrayBuffer,
} from "./x25519";

// ─── On-chain v2 claim ciphertext format ────────────────────────────────────
// version(0x02) || xwing_ct(1120) || nonce(12) || tag(16) || aes_ct
// v1 blobs (ephPk(32) || nonce(12) || aes_ct || tag(16)) carry NO version
// prefix and no writer ever emits an explicit 0x01, so length disambiguates:
// a v2 blob is always >= 1150 bytes while v1 stays ~70 bytes — even a v1
// ephemeral public key that randomly starts with 0x02 parses as v1.
export const XWING_VERSION_BYTE = 0x02;
export const XWING_CT_BYTES = 1120; // ml_kem768_x25519.lengths.cipherText
export const XWING_PK_BYTES = 1216; // ml_kem768_x25519.lengths.publicKey
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MIN_V2_BYTES = 1 + XWING_CT_BYTES + NONCE_BYTES + TAG_BYTES + 1;

/** HKDF salt for the X-Wing seed — deliberately NOT "soulkey-hybrid-v1". */
export const XWING_HKDF_SALT = new TextEncoder().encode("soulkey-xwing-v2");

/**
 * HKDF IKM must be the full 65-byte personal_sign signature — never slice to
 * 32. The output is the 32-byte X-Wing seed; ml_kem768_x25519 expands it
 * internally (ML-KEM-768 d/z + X25519 scalar). Do NOT expand to 96 bytes
 * yourself — that was the superseded April plan, not what the KEM consumes.
 */
export function deriveXWingSeedFromSignature(signatureHex: string): Uint8Array {
  const sigBytes = hexToExactBytes(signatureHex);
  if (sigBytes.length !== 65) {
    throw new Error(`Unexpected signature length ${sigBytes.length}, expected 65`);
  }
  return hkdf(sha256, sigBytes, XWING_HKDF_SALT, undefined, 32);
}

/** Deterministic keypair from the 32-byte seed (secretKey == seed; KEM re-expands). */
export function xwingKeypairFromSeed(seed: Uint8Array): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  return ml_kem768_x25519.keygen(seed);
}

/** Server side: encapsulate to a user's 1216-byte X-Wing public key. */
export function xwingEncapsulate(publicKey: Uint8Array): {
  cipherText: Uint8Array;
  sharedSecret: Uint8Array;
} {
  return ml_kem768_x25519.encapsulate(publicKey);
}

/** Client side: recover the 32-byte shared secret from ct + sk. */
export function xwingDecapsulate(
  cipherText: Uint8Array,
  secretKey: Uint8Array,
): Uint8Array {
  return ml_kem768_x25519.decapsulate(cipherText, secretKey);
}

/** 2 when the blob is a v2 X-Wing ciphertext, 1 for the existing unprefixed v1. */
export function claimCiphertextVersion(raw: Uint8Array): 1 | 2 {
  if (raw.length >= MIN_V2_BYTES && raw[0] === XWING_VERSION_BYTE) return 2;
  return 1;
}

export function parseXWingCiphertext(ciphertextHex: string): {
  xwingCt: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
  ct: Uint8Array;
} {
  const raw = hexToExactBytes(ciphertextHex);
  if (raw.length < MIN_V2_BYTES || raw[0] !== XWING_VERSION_BYTE) {
    throw new Error("Not a v2 X-Wing ciphertext");
  }
  const o = 1 + XWING_CT_BYTES;
  return {
    xwingCt: raw.subarray(1, o),
    nonce: raw.subarray(o, o + NONCE_BYTES),
    tag: raw.subarray(o + NONCE_BYTES, o + NONCE_BYTES + TAG_BYTES),
    ct: raw.subarray(o + NONCE_BYTES + TAG_BYTES),
  };
}

/**
 * Client-side reveal decrypt via WebCrypto. The 32-byte X-Wing shared secret
 * IS the AES-256-GCM key — X-Wing already KDFs both component secrets through
 * its SHA3-256 combiner, so no extra HKDF step here.
 */
export async function decryptXWingWebCrypto(
  ciphertextHex: string,
  seed: Uint8Array,
): Promise<string> {
  const { xwingCt, nonce, tag, ct } = parseXWingCiphertext(ciphertextHex);
  const { secretKey } = xwingKeypairFromSeed(seed);
  const shared = xwingDecapsulate(xwingCt, secretKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(shared),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct, 0);
  combined.set(tag, ct.length);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), tagLength: 128 },
    cryptoKey,
    toArrayBuffer(combined),
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Dual-read reveal entry point: v2 X-Wing blobs (0x02-prefixed) and the v1
 * X25519 blobs already claimed on Sepolia (unprefixed). Both derive from the
 * same single personal_sign — only the HKDF salt differs.
 */
export async function decryptClaimCiphertextWebCrypto(
  ciphertextHex: string,
  keys: { x25519SecretKey: Uint8Array; xwingSeed: Uint8Array },
): Promise<string> {
  const raw = hexToExactBytes(ciphertextHex);
  if (claimCiphertextVersion(raw) === 2) {
    return decryptXWingWebCrypto(ciphertextHex, keys.xwingSeed);
  }
  return decryptX25519WebCrypto(ciphertextHex, keys.x25519SecretKey);
}
