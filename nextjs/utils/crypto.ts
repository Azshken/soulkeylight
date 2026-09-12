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

/** Wire prefix for AES-256-GCM rows. Rows without it are legacy AES-256-CBC. */
const GCM_PREFIX = "v2gcm:";
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * AES-256-GCM for Neon cd_keys.encrypted_key (all new writes).
 * Wire format: "v2gcm:" + ivHex(12B) + ":" + ctHex + ":" + tagHex(16B).
 * The auth tag turns any DB tamper (even one flipped nibble) into a thrown
 * error instead of silent garbage plaintext. ENCRYPTION_KEY stays the same
 * 32-byte env hex used by the legacy CBC rows — no rotation, no rewrite job.
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${GCM_PREFIX}${iv.toString("hex")}:${ct.toString("hex")}:${tag.toString("hex")}`;
}

/** Legacy AES-256-CBC rows: ivHex(16B) + ":" + ctHex. Decrypt-only — never re-written. */
function decryptLegacyCbc(encryptedData: string): string {
  const [ivHex, encrypted] = encryptedData.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function decryptGcm(encryptedData: string): string {
  const [prefix, ivHex, ctHex, tagHex] = encryptedData.split(":");
  if (prefix !== "v2gcm" || ivHex === undefined || ctHex === undefined || tagHex === undefined) {
    throw new Error("Malformed v2gcm ciphertext");
  }
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
    throw new Error("Malformed v2gcm ciphertext: bad IV or tag length");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(), // throws on any tamper — GCM auth failure
  ]);
  return pt.toString("utf8");
}

/** Decrypts both wire formats: "v2gcm:" GCM rows and legacy ivHex:ctHex CBC rows. */
export function decrypt(encryptedData: string): string {
  return encryptedData.startsWith(GCM_PREFIX)
    ? decryptGcm(encryptedData)
    : decryptLegacyCbc(encryptedData);
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
