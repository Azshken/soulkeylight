// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/admin/page.tsx
"use client";

import { useEffect, useState } from "react";
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

// ── Types ────────────────────────────────────────────────────────────────────

type ContractStatus = {
  inDB: boolean;
  dbName: string | null;
  metadataCid: string | null;
  imageCid: string | null;
  currentBaseURI: string | null;
  expectedBaseURI: string;
  baseURICorrect: boolean;
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const router = useRouter();
  const { address: connectedAddress, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const publicClient = usePublicClient();

  // Two separate write hooks — wagmi doesn't allow reusing one across two
  // concurrent contract interactions safely.
  const { writeContractAsync: writeVaultContract } = useWriteContract();
  const { writeContractAsync: writeSoulKeyContract } = useWriteContract();

  // ── Key generation state ────────────────────────────────────────────────────
  const [keys, setKeys] = useState<{ commitmentHash: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [quantity, setQuantity] = useState(10);
  const [batchNotes, setBatchNotes] = useState("");
  const [totalAvailable, setTotalAvailable] = useState(0);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [genContractAddress, setGenContractAddress] = useState("");

  // ── Game setup state ────────────────────────────────────────────────────────
  const [regContractAddress, setRegContractAddress] = useState("");
  const [metadataCid, setMetadataCid] = useState("");
  const [newBaseURI, setNewBaseURI] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [regStatus, setRegStatus] = useState("");
  const [contractStatus, setContractStatus] = useState<ContractStatus | null>(
    null,
  );
  const [statusLoading, setStatusLoading] = useState(false);

  // ── Deregister game state ───────────────────────────────────────────────────
  const [deregContractAddress, setDeregContractAddress] = useState("");
  const [deregLoading, setDeregLoading] = useState(false);

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

  // Redirect non-owners away from this page
  useEffect(() => {
    if (isConnected && contractOwner && connectedAddress) {
      if (contractOwner.toLowerCase() !== connectedAddress.toLowerCase()) {
        toast.error("Access denied: not the contract owner");
        router.push("/");
      }
    }
  }, [contractOwner, connectedAddress, isConnected, router]);

  // ── Auto-fetch contract status when address changes ─────────────────────────
  // Fires on every valid address input — shows DB + baseURI state immediately
  // so the admin sees exactly what needs to be done without any extra clicks.
  const refreshContractStatus = (address: string) => {
    setStatusLoading(true);
    fetch(`/api/admin/contract-status?address=${address}`)
      .then((r) => r.json())
      .then((d: ContractStatus) => {
        setContractStatus(d);
        // Auto-fill baseURI input with the correct expected value
        setNewBaseURI(d.expectedBaseURI);
      })
      .catch(() => setContractStatus(null))
      .finally(() => setStatusLoading(false));
  };

  useEffect(() => {
    if (
      !regContractAddress ||
      !/^0x[0-9a-fA-F]{40}$/.test(regContractAddress)
    ) {
      setContractStatus(null);
      return;
    }
    refreshContractStatus(regContractAddress);
  }, [regContractAddress]);

  // ── Handlers ────────────────────────────────────────────────────────────────

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
      // Read vault address from the SoulKey contract
      const vaultAddress = await publicClient.readContract({
        address: regContractAddress as `0x${string}`,
        abi: SOULKEY_ABI,
        functionName: "vault",
      });

      // Check if already registered in vault
      const isRegistered = await publicClient.readContract({
        address: vaultAddress as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "registeredGames",
        args: [regContractAddress as `0x${string}`],
      });

      // Call vault.registerGame() if not yet registered.
      // NOTE: requires msg.sender to be the MasterKeyVault owner —
      // the same wallet as the SoulKey owner in the current setup.
      if (!isRegistered) {
        setRegStatus("Registering contract with MasterKeyVault...");
        const txHash = await writeVaultContract({
          address: vaultAddress as `0x${string}`,
          abi: VAULT_ABI,
          functionName: "registerGame",
          args: [regContractAddress as `0x${string}`],
        });
        setRegStatus("Waiting for vault confirmation...");
        await publicClient.waitForTransactionReceipt({
          hash: txHash as `0x${string}`,
        });
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

      // Refresh status panel so both ✅ alerts reflect the new DB state
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

  async function deregisterGame() {
    if (!connectedAddress || !deregContractAddress) {
      toast.error("Contract address required");
      return;
    }
    if (!publicClient) return;
    setDeregLoading(true);
    try {
      // 1. Call vault.deregisterGame on-chain
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
      await publicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
      });

      // 2. Sync DB
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
      await publicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
      });
      toast.success("Base URI updated!");
      setRegStatus("");
      // Refresh so the ✅ Base URI alert appears
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

  async function generateKeys() {
    if (!connectedAddress) {
      toast.error("Please connect your wallet");
      return;
    }
    if (
      !genContractAddress ||
      !/^0x[0-9a-fA-F]{40}$/.test(genContractAddress)
    ) {
      toast.error("Invalid contract address format");
      return;
    }

    setLoading(true);
    try {
      const timestamp = Date.now();
      const message = `Generate ${quantity} CD keys for SoulKey\nTimestamp: ${timestamp}`;
      const signature = await signMessageAsync({ message });

      const response = await fetch("/api/admin/generate-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantity,
          walletAddress: connectedAddress,
          contractAddress: genContractAddress,
          batchNotes,
          signature,
          message,
          timestamp,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Server error ${response.status}: ${text.slice(0, 200)}`,
        );
      }

      const data = await response.json();
      if (data.success) {
        setKeys(data.keys || []);
        setTotalAvailable(data.totalAvailable);
        setBatchId(data.batchId);
        toast.success(
          `✅ Generated ${data.count} keys in batch #${data.batchId}!`,
        );
      } else {
        toast.error(data.error || "Failed to generate keys");
      }
    } catch (error: any) {
      if (error?.code === 4001 || error?.message?.includes("rejected")) {
        toast.error("Signature rejected — no keys generated");
      } else {
        console.error(error);
        toast.error(error.message || "Failed to generate keys");
      }
    } finally {
      setLoading(false);
    }
  }

  function downloadHashes() {
    const content = keys
      .map((k, i) => `${i + 1},${k.commitmentHash}`)
      .join("\n");
    const blob = new Blob([`Index,Commitment Hash\n${content}`], {
      type: "text/csv",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `commitment-hashes-batch${batchId ?? "unknown"}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Auth gates ───────────────────────────────────────────────────────────────

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center min-h-screen flex-col gap-4">
        <h1 className="text-3xl font-bold">🔐 Admin Dashboard</h1>
        <p className="text-base-content/70">
          Connect the contract owner wallet to continue
        </p>
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

        {contractStatus && (
          <div className="space-y-4">
            {/* DB registration status */}
            <div
              className={`alert ${contractStatus.inDB && contractStatus.metadataCid ? "alert-success" : "alert-warning"}`}
            >
              {contractStatus.inDB && contractStatus.metadataCid
                ? `✅ DB registered — "${contractStatus.dbName}" · CID: ${contractStatus.metadataCid?.slice(0, 14)}...`
                : contractStatus.inDB && !contractStatus.metadataCid
                  ? `⚠️ DB entry exists for "${contractStatus.dbName}" but metadata CID is missing — re-register below`
                  : "⚠️ Not in DB — enter the Pinata metadata CID to register"}
            </div>

            {/* DB registration form — only shown when not yet registered */}
            {(!contractStatus.inDB || !contractStatus.metadataCid) && (
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

            <div className="card bg-base-200 shadow p-6 mb-6 border border-error">
              <h2 className="text-xl font-bold mb-1 text-error">
                Deregister Game
              </h2>
              <p className="text-sm text-base-content/70 mb-4">
                Removes the game from the vault (no new mints possible) and
                hides it from the storefront. Existing token holders keep access
                in their library.
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

            {/* setBaseURI form — only shown when not correct */}
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

            {/* In-progress status message for vault registration step */}
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

      {/* ── Generate Keys ──────────────────────────────────────────────────── */}
      <div className="card bg-base-200 shadow w-full p-6 mb-6">
        <h2 className="text-xl font-bold mb-4">Generate New Batch</h2>
        <p className="text-sm text-base-content/70 mb-4">
          ⚠️ The game must be registered (DB + Base URI) before generating keys.
        </p>

        <div className="form-control mb-3">
          <label className="label">
            <span className="label-text">SoulKey Contract Address</span>
          </label>
          <input
            className="input input-bordered w-full font-mono"
            placeholder="0x..."
            value={genContractAddress}
            onChange={(e) => setGenContractAddress(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="form-control mb-3">
          <label className="label">
            <span className="label-text">Quantity</span>
            <span className="label-text-alt">Max: 1000</span>
          </label>
          <input
            type="number"
            className="input input-bordered w-full"
            min={1}
            max={1000}
            value={quantity}
            onChange={(e) => setQuantity(parseInt(e.target.value) || 1)}
            disabled={loading}
          />
        </div>

        <div className="form-control mb-4">
          <label className="label">
            <span className="label-text">Batch Notes</span>
            <span className="label-text-alt">Optional</span>
          </label>
          <input
            className="input input-bordered w-full"
            placeholder="e.g. Launch batch, Region: EU"
            value={batchNotes}
            onChange={(e) => setBatchNotes(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="stats shadow mb-4 w-full">
          <div className="stat">
            <div className="stat-title">Total Unminted Keys</div>
            <div className="stat-value text-primary">{totalAvailable}</div>
            <div className="stat-desc">Available for minting</div>
          </div>
          {batchId && (
            <div className="stat">
              <div className="stat-title">Last Batch ID</div>
              <div className="stat-value">#{batchId}</div>
              <div className="stat-desc">{keys.length} keys generated</div>
            </div>
          )}
        </div>

        <button
          className="btn btn-primary w-full"
          onClick={generateKeys}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="loading loading-spinner loading-xs" />{" "}
              Generating...
            </>
          ) : (
            `🔑 Generate ${quantity} Keys`
          )}
        </button>

        {keys.length > 0 && (
          <div className="mt-6">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-bold">
                Batch #{batchId} — {keys.length} keys
              </h3>
              <button
                className="btn btn-sm btn-outline"
                onClick={downloadHashes}
              >
                💾 Download CSV
              </button>
            </div>
            <div className="overflow-x-auto max-h-64">
              <table className="table table-xs w-full">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Commitment Hash</th>
                    <th>Copy</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td className="font-mono text-xs truncate max-w-xs">
                        {key.commitmentHash}
                      </td>
                      <td>
                        <button
                          className="btn btn-xs btn-ghost"
                          onClick={() => {
                            navigator.clipboard.writeText(key.commitmentHash);
                            toast.info(`Copied #${i + 1}!`);
                          }}
                        >
                          📋
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
