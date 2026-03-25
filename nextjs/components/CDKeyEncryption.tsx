// SPDX-License-Identifier: AGPL-3.0-only
//packages/nextjst/app/components/CDKeyEncryption.tsx
"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

export function CDKeyEncryption() {
  const [encryptionKey, setEncryptionKey] = useState<string>("");
  const [encryptedData, setEncryptedData] = useState<string>("");
  const [isMetaMaskAvailable, setIsMetaMaskAvailable] = useState(false);

  useEffect(() => {
    // Check if MetaMask is available
    if (
      typeof window !== "undefined" &&
      typeof window.ethereum !== "undefined"
    ) {
      setIsMetaMaskAvailable(true);
    }
  }, []);

  async function getEncryptionPublicKey() {
    if (!window.ethereum) {
      toast.error("MetaMask not detected");
      return;
    }

    try {
      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      });

      // Get user's encryption public key (NOT their wallet address)
      const encryptionPublicKey = await window.ethereum.request({
        method: "eth_getEncryptionPublicKey",
        params: [accounts[0]],
      });

      setEncryptionKey(encryptionPublicKey);
      toast.success("Encryption key retrieved!");
      return encryptionPublicKey;
    } catch (error) {
      console.error(error);
      toast.error("Failed to get encryption key");
    }
  }

  async function decryptWithMetaMask(encryptedDataHex: string) {
    if (!window.ethereum) {
      toast.error("MetaMask not detected");
      return;
    }

    try {
      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      });

      // MetaMask decrypts using the user's private key
      const decryptedMessage = await window.ethereum.request({
        method: "eth_decrypt",
        params: [encryptedDataHex, accounts[0]],
      });

      toast.success("CD Key decrypted!");
      return decryptedMessage;
    } catch (error) {
      console.error(error);
      toast.error("Failed to decrypt");
    }
  }

  async function handleMintWithEncryption() {
    try {
      // Step 1: Get encryption key
      const pubKey = await getEncryptionPublicKey();
      if (!pubKey) return;

      // Step 2: Request encrypted CD key from your API
      const response = await fetch("/api/mint/get-cd-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ encryptionPublicKey: pubKey }),
      });

      const { encryptedCDKey } = await response.json();
      setEncryptedData(encryptedCDKey);

      // Step 3: Decrypt with MetaMask
      const cdKey = await decryptWithMetaMask(encryptedCDKey);

      toast.success(`Your CD Key: ${cdKey}`);
    } catch (error) {
      console.error(error);
      toast.error("Minting failed");
    }
  }

  if (!isMetaMaskAvailable) {
    return (
      <div className="alert alert-warning">
        Please install MetaMask to continue
      </div>
    );
  }

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">
          Mint NFT with CD Key (NFT will be SoulBound!)
        </h2>

        <button className="btn btn-primary" onClick={handleMintWithEncryption}>
          Get Encrypted CD Key & Mint
        </button>

        {encryptionKey && (
          <div className="text-xs break-all">
            <strong>Encryption Key:</strong> {encryptionKey}
          </div>
        )}

        {encryptedData && (
          <div className="text-xs break-all">
            <strong>Encrypted Data:</strong> {encryptedData.slice(0, 50)}...
          </div>
        )}
      </div>
    </div>
  );
}
