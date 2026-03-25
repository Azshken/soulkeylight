// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/utils/crypto.ts
import crypto from "crypto";

import { encrypt as ethEncrypt } from "@metamask/eth-sig-util";

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

export function encryptWithPublicKey(data: string, publicKey: string): string {
  // Using MetaMask's encryption standard for Ethereum public keys

  // Encrypt using x25519-xsalsa20-poly1305 (MetaMask's encryption standard)
  const encrypted = ethEncrypt({
    publicKey: publicKey, // MetaMask encryption public key (not the wallet address)
    data: data,
    version: "x25519-xsalsa20-poly1305",
  });

  // Convert to hex string for easy transmission
  return Buffer.from(JSON.stringify(encrypted), "utf8").toString("hex");
}

// Decrypt function (user decrypts with MetaMask on client-side)
export function prepareForMetaMaskDecrypt(encryptedHex: string): string {
  // This just formats the encrypted data for MetaMask's eth_decrypt
  // Actual decryption happens client-side via MetaMask
  return encryptedHex;
}
