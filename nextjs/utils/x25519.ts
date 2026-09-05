// SPDX-License-Identifier: AGPL-3.0-only
// Browser + Node safe X25519 helpers. Do not import Node `crypto` here.
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, toHex } from "viem";

export const HKDF_SALT = new TextEncoder().encode("soulkey-hybrid-v1");

export function encryptionSignMessage(walletAddress: string): string {
  return `SoulKey encryption key v1\nAddress: ${walletAddress}`;
}

export function hexToExactBytes(hex: string, expectedLength?: number): Uint8Array {
  const clean = hex.startsWith("0x") ? hex : `0x${hex}`;
  const bytes = hexToBytes(clean as `0x${string}`);
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** HKDF IKM must be the full 65-byte ECDSA signature. Never slice to 32. */
export function deriveX25519SecretFromSignature(signatureHex: string): Uint8Array {
  const sigBytes = hexToExactBytes(signatureHex);
  if (sigBytes.length !== 65) {
    throw new Error(`Unexpected signature length ${sigBytes.length}, expected 65`);
  }
  return hkdf(sha256, sigBytes, HKDF_SALT, undefined, 32);
}

export function x25519PublicFromSecret(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey);
}

export function x25519SharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secretKey, publicKey);
}

export function deriveAesKeyFromSharedSecret(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, HKDF_SALT, undefined, 32);
}

export function parseX25519Ciphertext(ciphertextHex: string): {
  ephPk: Uint8Array;
  nonce: Uint8Array;
  ct: Uint8Array;
  tag: Uint8Array;
} {
  const raw = hexToExactBytes(ciphertextHex);
  if (raw.length < 32 + 12 + 16) {
    throw new Error("Ciphertext too short");
  }
  return {
    ephPk: raw.subarray(0, 32),
    nonce: raw.subarray(32, 44),
    ct: raw.subarray(44, raw.length - 16),
    tag: raw.subarray(raw.length - 16),
  };
}

export async function decryptX25519WebCrypto(
  ciphertextHex: string,
  userSecretKey: Uint8Array,
): Promise<string> {
  const { ephPk, nonce, ct, tag } = parseX25519Ciphertext(ciphertextHex);
  const shared = x25519SharedSecret(userSecretKey, ephPk);
  const aesKey = deriveAesKeyFromSharedSecret(shared);
  const cryptoKey = await crypto.subtle.importKey("raw", aesKey, { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct, 0);
  combined.set(tag, ct.length);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 },
    cryptoKey,
    combined,
  );
  return new TextDecoder().decode(plaintext);
}

export function toUnprefixedHex(bytes: Uint8Array): string {
  return toHex(bytes).slice(2);
}
