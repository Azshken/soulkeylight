// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/admin/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSignMessage,
  useWriteContract,
} from "wagmi";
import { SOULKEY_ABI, VAULT_ABI } from "@/utils/abis";
import { toast } from "sonner";

const VAULT_ADDRESS = process.env.NEXT_PUBLIC_VAULT_ADDRESS as
  | `0x${string}`
  | undefined;

// ── Types ─────────────────────────────────────────────────────────────────────

type ContractStatus = {
  inDB: boolean;
  isActive: boolean | null;
  dbName: string | null;
  metadataCid: string | null;
  imageCid: string | null;
  currentBaseURI: string | null;
  expectedBaseURI: string;
  baseURICorrect: boolean;
};

type ImportResult = {
  count: number;
  batchId: number;
  totalAvailable: number;
  duplicates: number;
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const router = useRouter();
  const { address: connectedAddress, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const publicClient = usePublicClient();

  const { writeContractAsync: writeVaultContract } = useWriteContract();
  const { writeContractAsync: writeSoulKeyContract } = useWriteContract();

  // ── Game setup state ────────────────────────────────────────────────────────
  const [regContractAddress, setRegContractAddress] = useState("");
  const [metadataCid, setMetadataCid] = useState("");
  const [newBaseURI, setNewBaseURI] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [regStatus, setRegStatus] = useState("");
  const [contractStatus, setContractStatus] = useState<ContractStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  // ── Deregister game state ───────────────────────────────────────────────────
  const [deregContractAddress, setDeregContractAddress] = useState("");
  const [deregLoading, setDeregLoading] = useState(false);

  // ── CD Key import state ─────────────────────────────────────────────────────
  const [importContractAddress, setImportContractAddress] = useState("");
  const [importMode, setImportMode] = useState<"single" | "batch">("single");
  const [importKeys, setImportKeys] = useState("");
  const [importBatchNotes, setImportBatchNotes] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // ── Vault owner check ───────────────────────────────────────────────────────
  const { data: contractOwner, isLoading: ownerLoading } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "owner",
    query: { enabled: !!VAULT_ADDRESS },
  });

  const isOwner =
    isConnected &&
    contractOwner &&
    connectedAddress &&
    contractOwner.toLowerCase() === connectedAddress.toLowerCase();

  // Redirect non-owners
  useEffect(() => {
    if (isConnected && contractOwner && connectedAddress) {
      if (contractOwner.toLowerCase() !== connectedAddress.toLowerCase()) {
        toast.error("Access denied: not the contract owner");
        router.push("/");
      }
    }
  }, [contractOwner, connectedAddress, isConnected, router]);

  // ── Auto-fetch contract status ──────────────────────────────────────────────
  const refreshContractStatus = useCallback(async (addr: string) => {
    setStatusLoading(true);
    setContractStatus(null);
    setStatusError(null);
    try {
      const r = await fetch(`/api/admin/contract-status?address=${addr}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? `API error ${r.status}`);
      }
      const d: ContractStatus = await r.json();
      setContractStatus(d);
      setNewBaseURI(d.expectedBaseURI);
    } catch (err: any) {
      const msg = err.message ?? "Failed to fetch contract status";
      setStatusError(msg);
      toast.error(msg);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!regContractAddress || !/^0x[0-9a-fA-F]{40}$/.test(regContractAddress)) {
      setContractStatus(null);
      setStatusError(null);
      return;
    }
    refreshContractStatus(regContractAddress);
  }, [regContractAddress, refreshContractStatus]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  async function registerGame() {
    if (!connectedAddress || !regContractAddress || !metadataCid) {
      toast.error("Contract address and metadata CID are required");
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(regContractAddress)) {
      toast.error("Invalid contract address");
      return;
    }
    if (!publicClient) {
      toast.error("No RPC client available — please refresh the page");
      return;
    }

    setRegLoading(true);
    setRegStatus("Checking on-chain registration...");
    try {
      const vaultAddress = await publicClient.readContract({
        address: regContractAddress as `0x${string}`,
        abi: SOULKEY_ABI,
        functionName: "vault",
      });
      const isRegistered = await publicClient.readContract({
        address: vaultAddress as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "registeredGames",
        args: [regContractAddress as `0x${string}`],
      });

      if (!isRegistered) {
        setRegStatus("Registering contract with MasterKeyVault...");
        const txHash = await writeVaultContract({
          address: vaultAddress as `0x${string}`,
          abi: VAULT_ABI,
          functionName: "registerGame",
          args: [regContractAddress as `0x${string}`],
        });
        setRegStatus("Waiting for vault confirmation...");
        await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
      }

      setRegStatus("Fetching metadata from Pinata & saving to database...");
      const timestamp = Date.now();
      const message = `Register game ${regContractAddress} in SoulKey\nTimestamp: ${timestamp}`;
      const signature = await signMessageAsync({ message });

      const res = await fetch("/api/admin/register-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: connectedAddress,
          contractAddress: regContractAddress,
          metadataCid,
          signature,
          message,
          timestamp,
        }),
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      toast.success(`✅ "${data.product.name}" registered!`);
      setMetadataCid("");
      setRegStatus("");
      refreshContractStatus(regContractAddress);
    } catch (error: any) {
      if (error?.code === 4001 || error?.message?.includes("rejected")) {
        toast.error("Signature rejected");
      } else {
        toast.error(error.message || "Registration failed");
      }
      setRegStatus("");
    } finally {
      setRegLoading(false);
    }
  }

  async function setBaseURI() {
    if (!regContractAddress || !newBaseURI || !publicClient) return;
    setRegLoading(true);
    try {
      const txHash = await writeSoulKeyContract({
        address: regContractAddress as `0x${string}`,
        abi: SOULKEY_ABI,
        functionName: "setBaseURI",
        args: [newBaseURI],
      });
      setRegStatus("Waiting for Base URI confirmation...");
      await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
      toast.success("Base URI updated!");
      setRegStatus("");
      refreshContractStatus(regContractAddress);
    } catch (error: any) {
      if (error?.code === 4001 || error?.message?.includes("rejected")) {
        toast.error("Transaction rejected");
      } else {
        toast.error(error.message || "Failed to set Base URI");
      }
      setRegStatus("");
    } finally {
      setRegLoading(false);
    }
  }

  async function deregisterGame() {
    if (!connectedAddress || !deregContractAddress) {
      toast.error("Contract address required");
      return;
    }
    if (!publicClient) return;
    setDeregLoading(true);
    try {
      const vaultAddress = await publicClient.readContract({
        address: deregContractAddress as `0x${string}`,
        abi: SOULKEY_ABI,
        functionName: "vault",
      });
      const txHash = await writeVaultContract({
        address: vaultAddress as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "deregisterGame",
        args: [deregContractAddress as `0x${string}`],
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });

      const timestamp = Date.now();
      const message = `Deregister game ${deregContractAddress} ${timestamp}`;
      const signature = await signMessageAsync({ message });
      const res = await fetch("/api/admin/deregister-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: connectedAddress,
          contractAddress: deregContractAddress,
          signature,
          message,
          timestamp,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      toast.success(`${data.name} deregistered successfully`);
      setDeregContractAddress("");
    } catch (err: any) {
      if (err?.code === 4001 || err?.message?.includes("rejected"))
        toast.error("Signature rejected");
      else toast.error(err.message ?? "Deregistration failed");
    } finally {
      setDeregLoading(false);
    }
  }

  async function handleImportKeys() {
    if (!connectedAddress) {
      toast.error("Please connect your wallet");
      return;
    }
    if (!importContractAddress || !/^0x[0-9a-fA-F]{40}$/.test(importContractAddress)) {
      toast.error("Invalid contract address format");
      return;
    }
    if (!importKeys.trim()) {
      toast.error("Please enter at least one CD key");
      return;
    }

    setImportLoading(true);
    setImportError("");
    setImportResult(null);
    try {
      const keys = importKeys
        .split("\n")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);

      const timestamp = Date.now();
      const message = `Import ${keys.length} CD key(s) for ${importContractAddress}\nTimestamp: ${timestamp}`;
      const signature = await signMessageAsync({ message });

      const res = await fetch("/api/admin/import-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keys,
          walletAddress: connectedAddress,
          contractAddress: importContractAddress,
          batchNotes: importBatchNotes,
          signature,
          message,
          timestamp,
        }),
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      setImportResult(data);
      setImportKeys("");
      setImportBatchNotes("");
      toast.success(`✅ ${data.count} key(s) imported into batch #${data.batchId}!`);
    } catch (err: any) {
      if (err?.code === 4001 || err?.message?.includes("rejected")) {
        toast.error("Signature rejected — no keys imported");
      } else {
        const msg = err.message || "Failed to import keys";
        setImportError(msg);
        toast.error(msg);
      }
    } finally {
      setImportLoading(false);
    }
  }

  // ── Auth gates ────────────────────────────────────────────────────────────────

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center min-h-screen flex-col gap-4">
        <h1 className="text-3xl font-bold">🔐 Admin Dashboard</h1>
        <p className="text-base-content/70">Connect the contract owner wallet to continue</p>
        <ConnectButton />
      </div>
    );
  }

  if (isConnected && ownerLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <span className="loading loading-spinner loading-lg" />
        <p className="ml-4">Verifying ownership...</p>
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="flex items-center justify-center min-h-screen flex-col gap-4">
        <div className="alert alert-error max-w-md">
          <span>Access Denied</span>
        </div>
        <p className="font-mono text-sm">{connectedAddress}</p>
        <p>This wallet is not the contract owner.</p>
      </div>
    );
  }

// ── Main render ──────────────────────────────────────────────────────────────

  const importKeyCount = importKeys.split("\n").filter((k) => k.trim()).length;

  return (
    <div className="flex items-center flex-col grow pt-10 px-5 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold mb-2">🔐 Admin Dashboard</h1>
      <p className="text-base-content/70 mb-8">
        Manage SoulKey game contracts and CD key batches
      </p>

      <div className="alert alert-success mb-6 w-full">
        <span>✅ Owner: {connectedAddress}</span>
        {VAULT_ADDRESS && (
          <span className="font-mono text-xs">📄 Vault: {VAULT_ADDRESS}</span>
        )}
      </div>

      {/* ── Game Setup ─────────────────────────────────────────────────────── */}
      <div className="card bg-base-200 shadow w-full p-6 mb-6">
        <h2 className="text-xl font-bold mb-4">Game Setup</h2>
        <p className="text-sm text-base-content/70 mb-4">
          Enter a SoulKey contract address to check its registration status and
          configure it.
        </p>

        <div className="form-control mb-4">
          <label className="label">
            <span className="label-text">SoulKey Contract Address</span>
          </label>
          <input
            className="input input-bordered w-full font-mono"
            placeholder="0x..."
            value={regContractAddress}
            onChange={(e) => setRegContractAddress(e.target.value)}
            disabled={regLoading}
          />
        </div>

        {statusLoading && (
          <div className="flex items-center gap-2 mb-4">
            <span className="loading loading-dots loading-sm" />
            <span className="text-sm">Checking contract status...</span>
          </div>
        )}

        {statusError && !statusLoading && (
          <div className="alert alert-error mb-4">
            <span>⚠️ {statusError}</span>
          </div>
        )}

        {contractStatus && (
          <div className="space-y-4">
            {/* DB registration status */}
            <div
              className={`alert ${
                contractStatus.inDB && contractStatus.metadataCid && contractStatus.isActive
                  ? "alert-success"
                  : contractStatus.inDB && contractStatus.isActive === false
                  ? "alert-error"
                  : "alert-warning"
              } mb-2`}
            >
              {contractStatus.inDB && contractStatus.metadataCid && contractStatus.isActive
                ? `✅ DB registered — ${contractStatus.dbName} · CID ${contractStatus.metadataCid?.slice(0, 14)}...`
                : contractStatus.inDB && contractStatus.isActive === false
                ? `⛔ Deregistered — ${contractStatus.dbName} is inactive. Re-register below.`
                : contractStatus.inDB && !contractStatus.metadataCid
                ? `⚠️ DB entry exists for ${contractStatus.dbName} but metadata CID is missing — re-register below`
                : `Not in DB — enter the Pinata metadata CID to register`}
            </div>

            {/* Register form — shown when not fully set up */}
            {(!contractStatus.inDB || !contractStatus.metadataCid || contractStatus.isActive === false) && (
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Pinata Metadata CID</span>
                  <span className="label-text-alt">
                    Game name, image & description are fetched automatically
                  </span>
                </label>
                <input
                  className="input input-bordered w-full font-mono mb-2"
                  placeholder="QmbPeD... or bafybei..."
                  value={metadataCid}
                  onChange={(e) => setMetadataCid(e.target.value)}
                  disabled={regLoading}
                />
                <button
                  className="btn btn-primary w-full"
                  disabled={!metadataCid || regLoading}
                  onClick={registerGame}
                >
                  {regLoading && regStatus.includes("Fetching") ? (
                    <>
                      <span className="loading loading-spinner loading-xs" />{" "}
                      {regStatus}
                    </>
                  ) : (
                    "Register Game (fetches name & image from Pinata automatically)"
                  )}
                </button>
              </div>
            )}

            {/* Deregister — shown only when active */}
            {contractStatus?.isActive === true && (
              <div className="card bg-base-200 shadow p-6 mb-6 border border-error">
                <h2 className="text-xl font-bold mb-1 text-error">
                  Deregister Game
                </h2>
                <p className="text-sm text-base-content/70 mb-4">
                  Removes the game from the vault (no new mints possible) and
                  hides it from the storefront. Existing token holders keep
                  access in their library.
                </p>
                <input
                  className="input input-bordered input-error w-full mb-3 font-mono"
                  placeholder="SoulKey contract address 0x..."
                  value={deregContractAddress}
                  onChange={(e) => setDeregContractAddress(e.target.value)}
                  disabled={deregLoading}
                />
                <button
                  className="btn btn-error w-full"
                  onClick={deregisterGame}
                  disabled={deregLoading || !deregContractAddress}
                >
                  {deregLoading ? (
                    <span className="loading loading-spinner" />
                  ) : null}
                  Deregister Game
                </button>
              </div>
            )}

            {/* Base URI status */}
            <div
              className={`alert ${contractStatus.baseURICorrect ? "alert-success" : "alert-warning"}`}
            >
              {contractStatus.baseURICorrect
                ? "✅ Base URI set correctly"
                : contractStatus.currentBaseURI
                ? `⚠️ Base URI is set but wrong: ${contractStatus.currentBaseURI.slice(0, 50)}...`
                : "⚠️ Base URI not set — required for NFT metadata on marketplaces"}
            </div>

            {/* setBaseURI form — shown when not correct */}
            {!contractStatus.baseURICorrect && (
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Base URI</span>
                  <span className="label-text-alt text-success">
                    Auto-filled with correct value
                  </span>
                </label>
                <input
                  className="input input-bordered w-full font-mono text-xs mb-2"
                  value={newBaseURI}
                  onChange={(e) => setNewBaseURI(e.target.value)}
                  disabled={regLoading}
                />
                <button
                  className="btn btn-outline w-full"
                  disabled={!newBaseURI || regLoading}
                  onClick={setBaseURI}
                >
                  {regLoading && regStatus.includes("Base URI") ? (
                    <>
                      <span className="loading loading-spinner loading-xs" />{" "}
                      {regStatus}
                    </>
                  ) : (
                    "Set Base URI on Contract"
                  )}
                </button>
              </div>
            )}

            {/* In-progress vault registration status */}
            {regStatus &&
              !regStatus.includes("Fetching") &&
              !regStatus.includes("Base URI") && (
                <div className="alert alert-info">
                  <span className="loading loading-spinner loading-xs" />
                  <span>{regStatus}</span>
                </div>
              )}
          </div>
        )}
      </div>

      {/* ── Import CD Keys ─────────────────────────────────────────────────── */}
      <div className="card bg-base-200 shadow w-full p-6 mb-6">
        <h2 className="text-xl font-bold mb-4">Import CD Keys</h2>
        <p className="text-sm text-base-content/70 mb-4">
          ⚠️ The game must be registered (DB + Base URI) before importing keys.
        </p>

        <div className="form-control mb-3">
          <label className="label">
            <span className="label-text">SoulKey Contract Address</span>
          </label>
          <input
            className="input input-bordered w-full font-mono"
            placeholder="0x..."
            value={importContractAddress}
            onChange={(e) => {
              setImportContractAddress(e.target.value);
              setImportResult(null);
              setImportError("");
            }}
            disabled={importLoading}
          />
        </div>

        {/* Single / Batch toggle */}
        <div className="form-control mb-3">
          <label className="label">
            <span className="label-text">Import Mode</span>
          </label>
          <div className="tabs tabs-boxed w-fit">
            <button
              className={`tab ${importMode === "single" ? "tab-active" : ""}`}
              onClick={() => { setImportMode("single"); setImportKeys(""); }}
            >
              Single Key
            </button>
            <button
              className={`tab ${importMode === "batch" ? "tab-active" : ""}`}
              onClick={() => { setImportMode("batch"); setImportKeys(""); }}
            >
              Batch Import
            </button>
          </div>
        </div>

        {importMode === "single" ? (
          <div className="form-control mb-3">
            <label className="label">
              <span className="label-text">CD Key</span>
            </label>
            <input
              className="input input-bordered w-full font-mono"
              placeholder="e.g. XXXX-XXXX-XXXX-XXXX"
              value={importKeys}
              onChange={(e) => setImportKeys(e.target.value)}
              disabled={importLoading}
            />
          </div>
        ) : (
          <div className="form-control mb-3">
            <label className="label">
              <span className="label-text">CD Keys</span>
              <span className="label-text-alt">One key per line · Max: 1000</span>
            </label>
            <textarea
              className="textarea textarea-bordered w-full font-mono h-44 text-sm"
              placeholder={"XXXX-XXXX-XXXX-XXXX\nYYYY-YYYY-YYYY-YYYY\n…"}
              value={importKeys}
              onChange={(e) => setImportKeys(e.target.value)}
              disabled={importLoading}
            />
          </div>
        )}

        <div className="form-control mb-4">
          <label className="label">
            <span className="label-text">Batch Notes</span>
            <span className="label-text-alt">Optional</span>
          </label>
          <input
            className="input input-bordered w-full"
            placeholder="e.g. Launch batch, Region: EU"
            value={importBatchNotes}
            onChange={(e) => setImportBatchNotes(e.target.value)}
            disabled={importLoading}
          />
        </div>

        {/* Stats — mirrors the old generate section's stats block */}
        <div className="stats shadow mb-4 w-full">
          <div className="stat">
            <div className="stat-title">Keys to Import</div>
            <div className="stat-value text-primary">
              {importKeys.trim() ? importKeyCount : "—"}
            </div>
            <div className="stat-desc">
              {importMode === "batch" ? "Detected from input" : "Single key mode"}
            </div>
          </div>
          {importResult && (
            <div className="stat">
              <div className="stat-title">Last Batch</div>
              <div className="stat-value">#{importResult.batchId}</div>
              <div className="stat-desc">
                {importResult.count} imported · {importResult.totalAvailable} total available
              </div>
            </div>
          )}
        </div>

        <button
          className="btn btn-primary w-full"
          onClick={handleImportKeys}
          disabled={importLoading || !importKeys.trim() || !importContractAddress}
        >
          {importLoading ? (
            <>
              <span className="loading loading-spinner loading-xs" /> Importing...
            </>
          ) : (
            `🔑 Import ${importMode === "batch" && importKeyCount > 1 ? `${importKeyCount} Keys` : "Key"}`
          )}
        </button>

        {importError && (
          <div className="alert alert-error mt-4">
            <span>⚠️ {importError}</span>
          </div>
        )}

          {importResult && (
            <div className="alert alert-success mt-4">
              <span>
                ✅ {importResult.count} key(s) imported into batch #{importResult.batchId}
                {importResult.duplicates > 0 && (
                  <span className="text-warning">
                    {" "}· ⚠️ {importResult.duplicates} duplicate(s) skipped
                  </span>
                )}
              </span>
            </div>
          )}
      </div>
    </div>
  );
}