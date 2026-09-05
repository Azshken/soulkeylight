// SPDX-License-Identifier: AGPL-3.0-only
// nextjs/utils/crypto.ts
import crypto from "crypto";
import { x25519 } from "@noble/curves/ed25519.js";

import {
  deriveAesKeyFromSharedSecret,
  hexToExactBytes,
  parseX25519Ciphertext,
  x25519SharedSecret,
} from "./x25519";

const ENCRYPTION_KEY = Buffer.from(
  process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex"),
  "hex",
);

export function generateCDKey(): string {
  const random = crypto.randomBytes(12).toString("base64url").toUpperCase();
  return random.match(/.{1,4}/g)?.join("-") || random;
}

export function hashCDKey(cdkey: string): string {
  return crypto.createHash("sha256").update(cdkey).digest("hex");
}

/** AES-256-CBC for Neon cd_keys.encrypted_key. Do not change wire format. */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
}

export function decrypt(encryptedData: string): string {
  const [ivHex, encrypted] = encryptedData.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * On-chain v1 ciphertext: ephPk(32) | nonce(12) | aesCt | tag(16)
 * Returns 0x-prefixed hex for claimCdKey(bytes).
 */
export function encryptWithX25519(plaintext: string, userX25519PublicKeyHex: string): string {
  const userPk = hexToExactBytes(userX25519PublicKeyHex, 32);
  const eph = x25519.keygen();
  const ephSk = eph.secretKey;
  const ephPk = eph.publicKey;
  const sharedSecret = x25519SharedSecret(ephSk, userPk);
  const aesKey = deriveAesKeyFromSharedSecret(sharedSecret);

  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(aesKey), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `0x${Buffer.concat([Buffer.from(ephPk), nonce, ct, tag]).toString("hex")}`;
}

export function decryptWithX25519(ciphertextHex: string, userX25519SecretKeyHex: string): string {
  const { ephPk, nonce, ct, tag } = parseX25519Ciphertext(ciphertextHex);
  const userSk = hexToExactBytes(userX25519SecretKeyHex, 32);
  const sharedSecret = x25519SharedSecret(userSk, ephPk);
  const aesKey = deriveAesKeyFromSharedSecret(sharedSecret);
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(aesKey), nonce);
  decipher.setAuthTag(Buffer.from(tag));
  return Buffer.concat([decipher.update(Buffer.from(ct)), decipher.final()]).toString("utf8");
}
