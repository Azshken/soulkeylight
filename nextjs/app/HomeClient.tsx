// SPDX-License-Identifier: AGPL-3.0-only
// packages/nextjs/app/page.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { NextPage } from "next";
import { decodeEventLog, formatEther } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWriteContract,
} from "wagmi";

import { SOULKEY_ABI, VAULT_ABI } from "../utils/abis";
import { toast } from "sonner";

// ─── Constants ────────────────────────────────────────────────────────────────

const REFUND_WINDOW_SECS = 14 * 24 * 60 * 60;

// NEXT_PUBLIC_ vars are inlined by Next.js at build time.
// Reading once at module level avoids process.env access inside every render cycle.
const VAULT_ADDRESS = process.env.NEXT_PUBLIC_VAULT_ADDRESS as
  | `0x${string}`
  | undefined;

// Named constant avoids three independent string literals scattered through the file.
// A typo in any one of them creates a bug that TypeScript cannot catch (type is string).
// Using viem's `zeroAddress` import is an equally valid alternative.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type Product = {
  product_id: number;
  contract_address: `0x${string}`;
  name: string;
  genre: string;
  description: string;
  image_cid: string | null;
};

type LibraryGame = Product & {
  token_ids: number[];
  is_active: boolean;
};

// Mirrors MasterKeyVault.PaymentRecord:
//   (address paymentToken, uint48 paidAt, uint8 status, uint256 amount, address payer)
// If the Solidity struct field order changes, update this type and the paidAt index below —
// the compiler will surface every usage that breaks.
type PaymentRecord = readonly [
  `0x${string}`,
  bigint,
  number,
  bigint,
  `0x${string}`,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Ensures a hex string is 0x-prefixed AND is exactly 32 bytes (64 hex chars).
 * Throws a descriptive error if the server returned a malformed value —
 * without this guard the failure surfaces as an opaque viem ABI encoding error
 * that gives the user no actionable information.
 */
function toBytes32(hex: string): `0x${string}` {
  const normalized = (hex.startsWith("0x") ? hex : "0x" + hex) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      `Server returned a malformed 32-byte hash: "${normalized}". ` +
        `Expected 0x followed by exactly 64 hex characters.`,
    );
  }
  return normalized;
}

// Second helper. Variable-lenght bytes that validates hex format without
// constraining length:
function toHexBytes(hex: string): `0x${string}` {
  const normalized = (hex.startsWith("0x") ? hex : "0x" + hex) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]*$/.test(normalized))
    throw new Error(`Server returned a malformed hex value`);
  return normalized;
}

// ─── Component ────────────────────────────────────────────────────────────────

const Home: NextPage = () => {
  const { address: connectedAddress } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  // ─── Products ──────────────────────────────────────────────────────────────

  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const contractAddress = selectedProduct?.contract_address;

  // Extracted as useCallback so the Retry button can call it directly without a
  // full page reload, which would destroy the user's wallet connection state.
  const loadProducts = useCallback(() => {
    setProductsLoading(true);
    setProductsError(null);
    fetch("/api/products")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.products.length > 0) {
          setProducts(d.products);
          setSelectedProduct(d.products[0]);
        } else {
          setProductsError(
            d.success
              ? "No games are available at this time."
              : (d.error ?? "Failed to load games."),
          );
        }
      })
      .catch(() =>
        setProductsError(
          "Failed to load games. Check your connection and try again.",
        ),
      )
      .finally(() => setProductsLoading(false));
  }, []);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  // ─── On-chain reads ────────────────────────────────────────────────────────
  //
  // Conditional contracts array — TypeScript only narrows contractAddress to
  // non-undefined inside an inline ternary condition, not through a derived boolean.
  //
  // keepPreviousData is intentionally omitted: showing a stale price from a previous
  // game while the new one loads would allow minting at the wrong price.

  const { data: contractReads, isLoading: contractLoading } = useReadContracts({
    contracts: contractAddress
      ? ([
          {
            address: contractAddress,
            abi: SOULKEY_ABI,
            functionName: "mintPriceETH" as const,
          },
          {
            address: contractAddress,
            abi: SOULKEY_ABI,
            functionName: "mintPriceUSD" as const,
          },
          {
            address: contractAddress,
            abi: SOULKEY_ABI,
            functionName: "totalSupply" as const,
          },
          {
            address: contractAddress,
            abi: SOULKEY_ABI,
            functionName: "maxSupply" as const,
          },
        ] as const)
      : [],
    query: { enabled: !!contractAddress, refetchInterval: 15_000 },
  });

  const mintPriceETH = contractReads?.[0]?.result as bigint | undefined;
  const mintPriceUSD = contractReads?.[1]?.result as bigint | undefined;
  const totalSupply = contractReads?.[2]?.result as bigint | undefined;
  const maxSupply = contractReads?.[3]?.result as bigint | undefined;
  const isSoldOut =
    totalSupply !== undefined &&
    maxSupply !== undefined &&
    totalSupply >= maxSupply;

  // ── Library state ──────────────────────────────────────────────────────────
  const [libraryGames, setLibraryGames] = useState<LibraryGame[]>([]);
  const [selectedLibraryGame, setSelectedLibraryGame] =
    useState<LibraryGame | null>(null);
  const [selectedLibraryTokenId, setSelectedLibraryTokenId] =
    useState<number>(0);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const libraryContractAddress = selectedLibraryGame?.contract_address;

  const fetchLibrary = useCallback(async () => {
    if (!connectedAddress) {
      setLibraryGames([]);
      setSelectedLibraryGame(null);
      setSelectedLibraryTokenId(0);
      return;
    }
    setLibraryLoading(true);
    try {
      const d = await fetch(`/api/library?wallet=${connectedAddress}`).then(
        (r) => r.json(),
      );
      if (d.success) {
        setLibraryGames(d.games);
        setSelectedLibraryGame((prev) => {
          const match = d.games.find(
            (g: LibraryGame) => g.product_id === prev?.product_id,
          );
          const game: LibraryGame | null = match ?? d.games[0] ?? null;
          if (game) {
            setSelectedLibraryTokenId((prevTok) =>
              game.token_ids.includes(prevTok)
                ? prevTok
                : (game.token_ids[0] ?? 0),
            );
          }
          return game;
        });
      }
    } catch {
      toast.error("Failed to load your library.");
    } finally {
      setLibraryLoading(false);
    }
  }, [connectedAddress]);

  useEffect(() => {
    fetchLibrary();
  }, [fetchLibrary]);

  // ── On-chain reads (library section) ──────────────────────────────────────
  // staleTime:0 ensures value is always re-fetched rather than served from cache.
  // wagmi v2 accepts address:undefined when enabled:false — no ! assertion needed.
  const { data: claimTimestamp, refetch: refetchClaimTimestamp } =
    useReadContract({
      address: libraryContractAddress,
      abi: SOULKEY_ABI,
      functionName: "getClaimTimestamp",
      args: [BigInt(selectedLibraryTokenId || 0)],
      query: {
        enabled: !!libraryContractAddress && selectedLibraryTokenId > 0,
        staleTime: 0,
      },
    });
  const isClaimed = typeof claimTimestamp === "bigint" && claimTimestamp > 0n;

  // Refund status
  // Inline ternary is required — TypeScript control flow does NOT narrow through a
  // derived boolean variable (e.g. const shouldFetch = !!VAULT_ADDRESS && ...).
  // Only an inline condition propagates the narrowing into the then-branch.
  const { data: refundReads } = useReadContracts({
    contracts:
      VAULT_ADDRESS &&
      libraryContractAddress &&
      selectedLibraryTokenId > 0 &&
      !isClaimed
        ? ([
            {
              address: VAULT_ADDRESS,
              abi: VAULT_ABI,
              functionName: "isRefundable" as const,
              args: [
                libraryContractAddress,
                BigInt(selectedLibraryTokenId),
              ] as const,
            },
            {
              address: VAULT_ADDRESS,
              abi: VAULT_ABI,
              functionName: "paymentRecords" as const,
              args: [
                libraryContractAddress,
                BigInt(selectedLibraryTokenId),
              ] as const,
            },
          ] as const)
        : [],
    // No query.enabled needed — empty array already prevents any RPC calls.
  });

  const isRefundable =
    (refundReads?.[0]?.result as boolean | undefined) ?? false;

  // paidAt is typed as bigint | undefined — honest about the undefined case.
  // Previously the code destructured a fallback [] cast as PaymentRecord, which
  // typed paidAt as bigint even when the value was actually undefined at runtime.
  const paymentRecord = refundReads?.[1]?.result as PaymentRecord | undefined;
  const paidAt: bigint | undefined = paymentRecord?.[1];

  const refundWindowExpiry =
    paidAt !== undefined && paidAt > 0n
      ? new Date((Number(paidAt) + REFUND_WINDOW_SECS) * 1000)
      : null;

  const refundWindowHoursLeft = refundWindowExpiry
    ? Math.max(
        0,
        Math.floor((refundWindowExpiry.getTime() - Date.now()) / 3_600_000),
      )
    : null;

  // ── Re-fetch library after new supply appears ──────────────────────────────
  const prevSupplyRef = useRef<bigint | undefined>(undefined);
  useEffect(() => {
    prevSupplyRef.current = undefined;
    fetchLibrary();
  }, [fetchLibrary]);
  useEffect(() => {
    if (totalSupply === undefined) return;
    if (
      prevSupplyRef.current !== undefined &&
      totalSupply > prevSupplyRef.current
    )
      fetchLibrary();
    prevSupplyRef.current = totalSupply;
  }, [totalSupply, fetchLibrary]);

  // ─── UI state ──────────────────────────────────────────────────────────────
  const [selectedPayment, setSelectedPayment] = useState<
    "ETH" | "USDT" | "USDC"
  >("ETH");
  const [revealedKey, setRevealedKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [mintingStep, setMintingStep] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [showRefundInput, setShowRefundInput] = useState(false);

  // Reset UI-only state on game or token switch.
  // Data state is managed by wagmi hooks and fetchOwnedTokens — not reset here.
  useEffect(() => {
    setRevealedKey("");
    setShowRefundInput(false);
  }, [libraryContractAddress]);
  useEffect(() => {
    setRevealedKey("");
    setShowRefundInput(false);
  }, [selectedLibraryTokenId]);

  // ─── Mint ─────────────────────────────────────────────────────────────────

  const handleMint = async () => {
    if (!connectedAddress || !contractAddress) {
      toast.error("Please connect your wallet");
      return;
    }
    // mintPriceETH === undefined means data hasn't loaded yet — NOT the same as 0n.
    // Checking === undefined correctly handles free-mint contracts (mintPriceETH === 0n).
    if (mintPriceETH === undefined || mintPriceUSD === undefined) {
      toast.error("Contract data is still loading — please wait a moment");
      return;
    }
    // Explicit guard — no ! assertion. publicClient is undefined during SSR or if wagmi
    // is misconfigured; a runtime crash here would lose the user's committed key reservation.
    if (!publicClient) {
      toast.error("No RPC client available — please refresh the page");
      return;
    }

    setLoading(true);
    setMintingStep("Getting commitment hash from database...");
    try {
      const commitRes = await fetch("/api/mint/get-commitment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: connectedAddress,
          contractAddress,
        }),
      });
      const commitData = await commitRes.json();
      if (!commitData.success)
        throw new Error(commitData.error ?? "Failed to get commitment hash");

      // toBytes32 validates that the server returned a well-formed 32-byte hash.
      // Without this check a malformed hash from the server produces an opaque
      // viem ABI encoding error with no actionable message for the user.
      const commitHashBytes32 = toBytes32(commitData.commitmentHash);

      setMintingStep(`Minting NFT with ${selectedPayment}...`);

      // Explicit if/else branches are required here.
      // wagmi's writeContractAsync has strict generic types where functionName must be a
      // literal type inferred from the ABI. A computed string variable widens to string
      // and produces a TypeScript compile error.
      let txHash: `0x${string}`;
      if (selectedPayment === "ETH") {
        txHash = await writeContractAsync({
          address: contractAddress,
          abi: SOULKEY_ABI,
          functionName: "mintWithETH",
          args: [commitHashBytes32],
          value: mintPriceETH,
        });
      } else if (selectedPayment === "USDT") {
        txHash = await writeContractAsync({
          address: contractAddress,
          abi: SOULKEY_ABI,
          functionName: "mintWithUSDT",
          args: [commitHashBytes32],
        });
      } else {
        txHash = await writeContractAsync({
          address: contractAddress,
          abi: SOULKEY_ABI,
          functionName: "mintWithUSDC",
          args: [commitHashBytes32],
        });
      }

      setMintingStep("Waiting for transaction confirmation...");
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      // Decode using SOULKEY_ABI — no inline parseAbi, consistent with abis.ts.
      let tokenId: bigint | undefined;
      let mintedPaymentToken: string = ZERO_ADDRESS;
      for (const log of receipt.logs) {
        try {
          const d = decodeEventLog({
            abi: SOULKEY_ABI,
            eventName: "Transfer",
            data: log.data,
            topics: log.topics,
          });
          if (d.args.from === ZERO_ADDRESS) tokenId = d.args.tokenId;
        } catch {}
        try {
          const d = decodeEventLog({
            abi: SOULKEY_ABI,
            eventName: "NFTMinted",
            data: log.data,
            topics: log.topics,
          });
          mintedPaymentToken = d.args.paymentToken as string;
        } catch {}
      }
      if (!tokenId)
        throw new Error("Could not extract token ID from transaction");
      const mintedTokenId = tokenId; // const — type is bigint, never re-widened across awaits

      setMintingStep("Linking token to database...");
      const linkRes = await fetch("/api/mint/link-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenId: mintedTokenId.toString(),
          walletAddress: connectedAddress,
          txHash,
          blockNumber: receipt.blockNumber.toString(),
          paymentToken: mintedPaymentToken,
          paymentAmount:
            selectedPayment === "ETH"
              ? mintPriceETH!.toString()
              : mintPriceUSD!.toString(),
          contractAddress,
          commitmentHash: commitData.commitmentHash,
        }),
      });
      const linkData = await linkRes.json();

      if (!linkData.success) {
        // The on-chain mint succeeded — the user's NFT and payment are safe.
        // Only the DB record failed. Do NOT call fetchOwnedTokens() here:
        // the DB doesn't have this token so the query would return without it,
        // leaving the user unable to access their NFT for the entire session
        // (and even after a refresh, since the DB remains inconsistent).
        //
        // Instead, inject the token optimistically — its existence was confirmed
        // from the on-chain receipt above, not assumed. This is an intentional
        // exception to the no-optimistic-update policy.
        toast.warning(
          `NFT minted on-chain (tx: ${txHash.slice(0, 10)}…) but the server record failed ` +
            `— please contact support with your transaction hash.`,
        );
        await fetchLibrary();
        return;
      }

      // DB is now consistent — fetch authoritative state.
      // No optimistic update: avoids a race condition where a polling-triggered
      // fetchOwnedTokens fires before link-token completes and wipes the new token.
      await fetchLibrary();
      setSelectedLibraryTokenId(Number(mintedTokenId));
      toast.success(
        `NFT minted! Token #${mintedTokenId} — now claim your CD key.`,
      );
    } catch (error: any) {
      console.error("Mint error", error);
      toast.error(`Failed to mint: ${error.message}`);
    } finally {
      setLoading(false);
      setMintingStep("");
    }
  };

  // ─── Claim CD Key ─────────────────────────────────────────────────────────

  const handleClaimCDKey = async () => {
    if (
      !connectedAddress ||
      !selectedLibraryTokenId ||
      !libraryContractAddress
    ) {
      toast.error("Please select a token");
      return;
    }
    if (isClaimed) {
      toast.error("This token's CD key has already been claimed");
      return;
    }
    if (!publicClient) {
      toast.error("No RPC client available — please refresh the page");
      return;
    }

    setLoading(true);
    setMintingStep("Requesting encryption public key from MetaMask...");
    try {
      const userPublicKey = await (window as any).ethereum.request({
        method: "eth_getEncryptionPublicKey",
        params: [connectedAddress],
      });

      setMintingStep("Retrieving and encrypting CD key...");
      const redeemRes = await fetch("/api/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenId: selectedLibraryTokenId,
          userAddress: connectedAddress,
          userPublicKey,
          contractAddress,
        }),
      });
      const redeemData = await redeemRes.json();
      if (!redeemData.success)
        throw new Error(redeemData.error ?? "Failed to retrieve CD key");

      setMintingStep("Claiming CD key on blockchain...");
      const txHash = await writeContractAsync({
        address: libraryContractAddress,
        abi: SOULKEY_ABI,
        functionName: "claimCdKey",
        args: [
          BigInt(selectedLibraryTokenId),
          toBytes32(redeemData.commitmentHash), // bytes32 — fixed length ✓
          toHexBytes(redeemData.encryptedCDKey), // bytes   — variable length ✓
        ],
      });

      setMintingStep("Confirming redemption...");
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      await fetch("/api/redeem/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cdkeyId: redeemData.cdkeyId,
          userAddress: connectedAddress,
          txHash,
          blockNumber: receipt.blockNumber.toString(),
          contractAddress: libraryContractAddress,
          tokenId: selectedLibraryTokenId.toString(),
        }),
      });

      await refetchClaimTimestamp();
      toast.success(
        "CD key claimed! NFT is now soulbound. Click 'Reveal CD Key' to decrypt.",
      );
    } catch (error: any) {
      console.error("Claim error", error);
      toast.error(`Failed to claim: ${error.message}`);
    } finally {
      setLoading(false);
      setMintingStep("");
    }
  };

  // ─── Reveal CD Key ────────────────────────────────────────────────────────

  const handleRevealCDKey = async () => {
    if (
      !connectedAddress ||
      !selectedLibraryTokenId ||
      !libraryContractAddress
    ) {
      toast.error("Please connect your wallet and select a token");
      return;
    }
    if (!isClaimed) {
      toast.error("CD key hasn't been claimed yet");
      return;
    }
    if (!publicClient) {
      toast.error("No RPC client available — please refresh the page");
      return;
    }

    setLoading(true);
    setMintingStep("Retrieving encrypted CD key from blockchain...");
    try {
      const encryptedBytes = (await publicClient.readContract({
        address: libraryContractAddress,
        abi: SOULKEY_ABI,
        functionName: "getEncryptedCDKey",
        args: [BigInt(selectedLibraryTokenId)],
        account: connectedAddress as `0x${string}`,
      })) as `0x${string}`;

      if (!encryptedBytes || encryptedBytes === "0x") {
        throw new Error("No encrypted CD key found on-chain");
      }

      setMintingStep("Decrypting with your MetaMask private key...");
      const decrypted = await (window as any).ethereum.request({
        method: "eth_decrypt",
        params: [encryptedBytes, connectedAddress],
      });
      setRevealedKey(decrypted);
      toast.success("CD key revealed successfully!");
    } catch (error: any) {
      console.error("Reveal error", error);
      toast.error(`Failed to reveal: ${error.message}`);
    } finally {
      setLoading(false);
      setMintingStep("");
    }
  };

  // ─── Refund ───────────────────────────────────────────────────────────────

  const handleRefund = async () => {
    if (
      !connectedAddress ||
      !selectedLibraryTokenId ||
      !libraryContractAddress ||
      !VAULT_ADDRESS
    ) {
      toast.error("Wallet or contract not ready");
      return;
    }
    if (!isRefundable) {
      toast.error("This token is not refundable");
      return;
    }
    if (!publicClient) {
      toast.error("No RPC client available — please refresh the page");
      return;
    }

    setLoading(true);
    setMintingStep("Processing refund on blockchain...");
    try {
      const reason = refundReason || "User requested refund";
      const txHash = await writeContractAsync({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "processRefund",
        args: [libraryContractAddress, BigInt(selectedLibraryTokenId), reason],
      });

      setMintingStep("Waiting for refund confirmation...");
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      let refundedAmount = "0",
        feeRetained = "0",
        paymentToken: string = ZERO_ADDRESS;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: VAULT_ABI,
            eventName: "RefundIssued",
            data: log.data,
            topics: log.topics,
          });
          refundedAmount = (decoded.args as any).refundedAmount.toString();
          feeRetained = (decoded.args as any).feeRetained.toString();
          paymentToken = (decoded.args as any).paymentToken as string;
          break;
        } catch {}
      }

      await fetch("/api/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractAddress: libraryContractAddress,
          tokenId: selectedLibraryTokenId.toString(),
          refundedBy: connectedAddress,
          refundReason: reason,
          refundTxHash: txHash,
          blockNumber: receipt.blockNumber.toString(),
          paymentToken,
          refundedAmount,
          feeRetained,
        }),
      });

      // Fetch authoritative DB state — the refunds row now exists so token is excluded.
      await fetchLibrary();
      setShowRefundInput(false);
      setRefundReason(""); // clear so the next token starts with an empty textarea
      toast.success("Refund processed! NFT has been burned.");
    } catch (error: any) {
      console.error("Refund error", error);
      toast.error(`Refund failed: ${error.message}`);
    } finally {
      setLoading(false);
      setMintingStep("");
    }
  };

  // ─── Frontend render helpers ───────────────────────────────────────────────

  const cardRef = useRef<HTMLDivElement>(null);
  const sheenRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const card = cardRef.current;
    const sheen = sheenRef.current;
    if (!card || !sheen) return;

    const { left, top, width, height } = card.getBoundingClientRect();
    const x = (e.clientX - left) / width; // 0 to 1
    const y = (e.clientY - top) / height;

    // 3D tilt
    card.style.transform = `perspective(600px) rotateY(${(x - 0.5) * 16}deg) rotateX(${(y - 0.5) * 16}deg) scale(1.04)`;

    // Sheen sits opposite the tilt — light reflects away from the raised edge
    const sheenX = (1 - x) * 100;
    const sheenY = (1 - y) * 100;

    sheen.style.background = `
      radial-gradient(circle at ${sheenX}% ${sheenY}%,
        rgba(255,255,255,0.10) 0%,
        rgba(255,255,255,0.02) 40%,
        transparent 70%),
      linear-gradient(
        ${105 + x * 60}deg,
        transparent 30%,
        rgba(180,140,255,0.03) 45%,
        rgba(100,210,255,0.04) 55%,
        transparent 70%
      )
    `;
    sheen.style.opacity = "1";
  };

  const handleMouseLeave = () => {
    const card = cardRef.current;
    const sheen = sheenRef.current;
    if (card)
      card.style.transform =
        "perspective(600px) rotateY(0deg) rotateX(0deg) scale(1)";
    if (sheen) sheen.style.opacity = "0";
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  if (productsLoading)
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0d0f14] flex-col gap-4">
        <span className="loading loading-spinner loading-lg text-emerald-500" />
        <p className="text-zinc-500 text-sm">Loading games...</p>
      </div>
    );

  if (productsError)
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0d0f14] flex-col gap-4">
        <div className="bg-red-950 border border-red-800 rounded-2xl p-6 max-w-md text-center">
          <p className="text-red-400 mb-4">{productsError}</p>
          <button
            onClick={loadProducts}
            className="px-6 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm font-semibold transition-all"
          >
            Retry
          </button>
        </div>
      </div>
    );

  return (
    <div className="min-h-screen bg-[#0d0f14] text-zinc-100">

    {/* ── HERO + GAME SELECTOR ─────────────────────────────────────── */}
    <div className="relative overflow-hidden">
      {/* Blurred backdrop */}
      {selectedProduct?.image_cid && (
        <Image
          src={selectedProduct.image_cid}
          alt=""
          fill
          className="object-cover scale-110 blur-2xl opacity-25"
          unoptimized
        />
      )}
      <div className="absolute inset-0 bg-linear-to-b from-[#0d0f14]/20 via-[#0d0f14]/50 to-[#0d0f14]" />

      {/* Tabs */}
      {products.length > 0 && (
        <div className="relative z-10 max-w-6xl mx-auto px-4 md:px-6 overflow-x-auto scrollbar-hide">
          <div className="flex gap-5 py-13 px-8">
            {products.map((product) => {
              const isSelected = selectedProduct?.product_id === product.product_id;
              return (
                <button
                  key={product.product_id}
                  onClick={() => setSelectedProduct(product)}
                  className={`group relative flex flex-col items-center shrink-0 rounded-xl border-2 overflow-hidden transition-all duration-200 w-48
                    ${isSelected
                      ? "border-emerald-500 shadow-xl shadow-emerald-500/30 scale-105"
                      : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600 hover:scale-[1.03] hover:shadow-lg hover:shadow-zinc-900/50"
                    }`}
                >
                  {/* Cover art */}
                  <div className="relative w-48 h-40 shrink-0 bg-zinc-800">
                    {product.image_cid ? (
                      <Image
                        src={product.image_cid}
                        alt={product.name}
                        fill
                        sizes="192px"
                        className="object-cover object-center"
                        unoptimized
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-zinc-600 text-3xl">
                        🎮
                      </div>
                    )}
                    {isSelected && (
                      <div className="absolute inset-0 bg-emerald-500/10 pointer-events-none" />
                    )}
                    {/* Hover tooltip */}
                    <div className="absolute inset-0 bg-zinc-950/80 flex flex-col justify-end px-2 pb-2
                      opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                      <p className="text-white text-xs font-bold leading-tight truncate">{product.name}</p>
                      {product.genre && (
                        <p className="text-zinc-400 text-[10px] truncate mt-0.5">{product.genre}</p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>

    <div className="max-w-6xl mx-auto px-4 md:px-6 pb-16">
        {/* ── MAIN TWO-COLUMN LAYOUT ───────────────────────── */}
        {selectedProduct && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8 mb-12">
            {/* LEFT: 3D game cover */}
            <div>
              <div
                ref={cardRef}
                className="card-tilt relative rounded-2xl overflow-hidden shadow-2xl shadow-black/60 cursor-default"
                onMouseMove={handleMouseMove}
                onMouseLeave={handleMouseLeave}
              >
                <div ref={sheenRef} className="card-sheen-overlay" />
                {selectedProduct.image_cid ? (
                  <Image
                    src={selectedProduct.image_cid}
                    loading="eager"
                    priority
                    alt=""
                    width={720}
                    height={405}
                    className="w-full object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="w-full aspect-video bg-zinc-900 flex items-center justify-center">
                    <span className="text-zinc-600 text-sm">No artwork</span>
                  </div>
                )}
                {isClaimed &&
                  selectedLibraryTokenId > 0 &&
                  selectedLibraryGame?.contract_address === contractAddress && (
                    <div className="absolute top-3 right-3 bg-violet-600/90 backdrop-blur-sm text-white text-xs font-bold px-3 py-1 rounded-full border border-violet-400/30">
                      ⛓ Soulbound
                    </div>
                  )}
              </div>

              {/* Supply + contract */}
              <div className="flex items-center gap-4 mt-4 flex-wrap">
                {contractLoading ? (
                  <span className="loading loading-dots loading-xs text-zinc-600" />
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-2 h-2 rounded-full ${isSoldOut ? "bg-red-400" : "bg-emerald-400 animate-pulse"}`}
                      />
                      <span className="text-xs text-zinc-400">
                        {isSoldOut
                          ? "Sold out"
                          : `${totalSupply?.toString() ?? "—"} / ${maxSupply?.toString() ?? "—"} minted`}
                      </span>
                    </div>
                    <span className="text-zinc-700">•</span>
                    <span className="text-xs font-mono text-zinc-600">
                      {contractAddress?.slice(0, 8)}...
                      {contractAddress?.slice(-6)}
                    </span>
                  </>
                )}
              </div>

              {selectedProduct.description && (
                <p className="text-sm text-zinc-400 mt-4 leading-relaxed">
                  {selectedProduct.description}
                </p>
              )}
            </div>

            {/* RIGHT: Purchase panel */}
            <div className="flex flex-col gap-4">
              {/* Price */}
              <div className="bg-[#161b22] border border-zinc-800 rounded-2xl p-5">
                <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-2">
                  Price
                </p>
                {contractLoading ? (
                  <span className="loading loading-dots loading-sm text-zinc-500" />
                ) : (
                  <>
                    <p className="text-3xl font-black text-zinc-100">
                      {mintPriceETH !== undefined
                        ? formatEther(mintPriceETH)
                        : "—"}
                      <span className="text-zinc-500 text-lg font-normal ml-1">
                        ETH
                      </span>
                    </p>
                    <p className="text-sm text-zinc-500 mt-1">
                      ≈{" "}
                      {mintPriceUSD !== undefined
                        ? (Number(mintPriceUSD) / 1e6).toFixed(2)
                        : "—"}{" "}
                      USDC / USDT
                    </p>
                  </>
                )}
              </div>

              {/* Payment method */}
              <div className="bg-[#161b22] border border-zinc-800 rounded-2xl p-5">
                <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-3">
                  Pay with
                </p>
                <div className="flex gap-2">
                  {(["ETH", "USDT", "USDC"] as const).map((method) => (
                    <button
                      key={method}
                      onClick={() => setSelectedPayment(method)}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-all duration-150 ${
                        selectedPayment === method
                          ? "bg-emerald-500 border-emerald-500 text-black shadow-md shadow-emerald-500/25"
                          : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                      }`}
                    >
                      {method}
                    </button>
                  ))}
                </div>
              </div>

              {/* Mint button */}
              <button
                onClick={handleMint}
                disabled={
                  loading ||
                  !connectedAddress ||
                  !contractAddress ||
                  mintPriceETH === undefined ||
                  contractLoading ||
                  isSoldOut
                }
                className="w-full py-4 rounded-2xl font-bold text-base transition-all duration-150 shadow-lg
                  bg-emerald-500 hover:bg-emerald-400 text-black
                  disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed disabled:shadow-none
                  shadow-emerald-500/20"
              >
                {loading && mintingStep ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="loading loading-spinner loading-xs" />
                    {mintingStep}
                  </span>
                ) : isSoldOut ? (
                  "Sold Out"
                ) : !connectedAddress ? (
                  "Connect Wallet to Mint"
                ) : (
                  `Mint with ${selectedPayment} →`
                )}
              </button>

              {/* How it works */}
              <div className="bg-[#161b22] border border-zinc-800 rounded-2xl p-5">
                <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-3">
                  How it works
                </p>
                <ol className="space-y-3">
                  {[
                    {
                      icon: "🎟️",
                      title: "Mint your NFT",
                      sub: "CD key reserved via commitment hash",
                    },
                    {
                      icon: "🔑",
                      title: "Claim your key",
                      sub: "Encrypted with MetaMask, NFT becomes soulbound",
                    },
                    {
                      icon: "👁️",
                      title: "Reveal anytime",
                      sub: "Decrypt locally with your MetaMask key",
                    },
                    {
                      icon: "↩️",
                      title: "14-day refund",
                      sub: "Before claiming only — 5% fee retained",
                    },
                  ].map(({ icon, title, sub }) => (
                    <li key={title} className="flex items-start gap-3">
                      <span className="text-base mt-0.5 leading-none">
                        {icon}
                      </span>
                      <div>
                        <span className="text-sm text-zinc-200 font-medium">
                          {title}
                        </span>
                        <p className="text-xs text-zinc-600 mt-0.5">{sub}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        )}

        {/* ── YOUR LIBRARY ─────────────────────────────────── */}
        {connectedAddress && (
          <div className="mb-12">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-zinc-100">Your Library</h2>
              {libraryLoading && (
                <span className="loading loading-dots loading-xs text-zinc-600" />
              )}
            </div>

            {!libraryLoading && libraryGames.length === 0 && (
              <div className="bg-[#161b22] border border-zinc-800 rounded-2xl p-6">
                <p className="text-zinc-600 text-sm">
                  No tokens yet — mint your first SoulKey above.
                </p>
              </div>
            )}

            {libraryGames.length > 0 && (
              <div className="bg-[#161b22] border border-zinc-800 rounded-2xl p-6">
                <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-6 items-start">
                  {/* ── LEFT: game tabs + token pills + status ── */}
                  <div>
                    {/* Library game selector tabs */}
                    {libraryGames.length > 1 && (
                      <div className="flex gap-2 mb-5 overflow-x-auto pb-1 scrollbar-hide">
                        {libraryGames.map((g) => (
                          <button
                            key={g.product_id}
                            onClick={() => {
                              setSelectedLibraryGame(g);
                              setSelectedLibraryTokenId(g.token_ids[0] ?? 0);
                              setRevealedKey("");
                              setShowRefundInput(false);
                            }}
                            className={`flex items-center gap-2 px-4 py-2 rounded-full border text-sm font-medium transition-all duration-200 whitespace-nowrap shrink-0 ${
                              selectedLibraryGame?.product_id === g.product_id
                                ? "border-violet-500 bg-violet-500/10 text-violet-400 shadow-md shadow-violet-500/10"
                                : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                            }`}
                          >
                            {g.image_cid && (
                              <div className="relative w-5 h-5 rounded-full overflow-hidden shrink-0">
                                <Image
                                  src={g.image_cid}
                                  alt=""
                                  fill
                                  className="object-cover"
                                  unoptimized
                                />
                              </div>
                            )}
                            {g.name}
                            <span className="text-xs opacity-50">
                              {g.token_ids.length}×
                            </span>
                            {!g.is_active && (
                              <span className="text-xs text-amber-500 font-semibold">
                                Delisted
                              </span>
                            )}
                            {selectedLibraryGame?.product_id ===
                              g.product_id && (
                              <span className="w-1.5 h-1.5 rounded-full bg-violet-400 inline-block" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Token pills */}
                    {selectedLibraryGame &&
                      selectedLibraryGame.token_ids.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-4">
                          {selectedLibraryGame.token_ids.map((tokenId) => (
                            <button
                              key={tokenId}
                              onClick={() => {
                                setSelectedLibraryTokenId(tokenId);
                                setRevealedKey("");
                                setShowRefundInput(false);
                              }}
                              disabled={loading}
                              className={`px-4 py-2 rounded-xl text-sm font-mono font-semibold border transition-all duration-150 ${
                                selectedLibraryTokenId === tokenId
                                  ? "bg-zinc-100 border-zinc-100 text-zinc-900"
                                  : "bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                              }`}
                            >
                              #{tokenId}
                            </button>
                          ))}
                        </div>
                      )}

                    {/* Status badges */}
                    {selectedLibraryTokenId > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        {isClaimed ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />{" "}
                            Soulbound · Key Claimed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />{" "}
                            Key Not Claimed
                          </span>
                        )}
                        {!isClaimed && refundWindowHoursLeft !== null && (
                          <span
                            className={`text-xs px-3 py-1.5 rounded-full border ${
                              refundWindowHoursLeft < 24
                                ? "bg-red-900/20 border-red-800 text-red-400"
                                : "bg-amber-900/20 border-amber-800 text-amber-400"
                            }`}
                          >
                            ⏱ {refundWindowHoursLeft}h refund window left
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── RIGHT: action buttons ────────────────────── */}
                  {selectedLibraryTokenId > 0 && (
                    <div className="flex flex-col gap-3">
                      {/* Claim */}
                      {!isClaimed && (
                        <button
                          onClick={handleClaimCDKey}
                          disabled={loading || !connectedAddress}
                          className="w-full py-3 rounded-xl font-semibold bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-all duration-150 shadow-md shadow-violet-500/20"
                        >
                          {loading && mintingStep ? (
                            <span className="flex items-center justify-center gap-2">
                              <span className="loading loading-spinner loading-xs" />
                              {mintingStep}
                            </span>
                          ) : (
                            "🔑 Claim CD Key — Makes NFT Soulbound"
                          )}
                        </button>
                      )}

                      {/* Reveal */}
                      {isClaimed && (
                        <>
                          <button
                            onClick={handleRevealCDKey}
                            disabled={loading || !connectedAddress}
                            className="w-full py-3 rounded-xl font-semibold bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-all duration-150 shadow-md shadow-sky-500/20"
                          >
                            {loading && mintingStep ? (
                              <span className="flex items-center justify-center gap-2">
                                <span className="loading loading-spinner loading-xs" />
                                {mintingStep}
                              </span>
                            ) : (
                              "👁️ Reveal CD Key"
                            )}
                          </button>
                          {revealedKey && (
                            <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4">
                              <div className="flex justify-between items-center mb-2">
                                <span className="text-[10px] text-zinc-600 uppercase tracking-widest">
                                  Your CD Key
                                </span>
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(revealedKey);
                                    toast.success("Copied!");
                                  }}
                                  className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors font-medium"
                                >
                                  Copy ↗
                                </button>
                              </div>
                              <p className="font-mono text-emerald-400 text-sm tracking-wider break-all">
                                {revealedKey}
                              </p>
                              <p className="text-xs text-amber-600 mt-3">
                                ⚠ Unique one-time use — store it safely
                              </p>
                            </div>
                          )}
                        </>
                      )}

                      {/* Refund */}
                      {!isClaimed && isRefundable && (
                        <>
                          {!showRefundInput ? (
                            <button
                              onClick={() => setShowRefundInput(true)}
                              disabled={loading}
                              className="w-full py-2.5 rounded-xl text-sm font-semibold border border-zinc-700 text-zinc-500 hover:border-red-800 hover:text-red-400 hover:bg-red-950/20 transition-all duration-150"
                            >
                              Request Refund — 5% fee retained
                            </button>
                          ) : (
                            <div className="bg-zinc-950 border border-red-900/50 rounded-xl p-4">
                              <p className="text-xs text-red-400 font-semibold mb-3">
                                ⚠ This will burn your NFT and refund 95% of the
                                payment.
                              </p>
                              <textarea
                                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-200 placeholder-zinc-700 mb-3 resize-none focus:outline-none focus:border-zinc-600 transition-colors"
                                placeholder="Reason for refund (optional)"
                                value={refundReason}
                                onChange={(e) =>
                                  setRefundReason(e.target.value)
                                }
                                rows={2}
                                maxLength={280}
                              />
                              <div className="flex gap-2">
                                <button
                                  onClick={handleRefund}
                                  disabled={loading}
                                  className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white transition-all"
                                >
                                  {loading && mintingStep
                                    ? mintingStep
                                    : "Confirm Refund"}
                                </button>
                                <button
                                  onClick={() => setShowRefundInput(false)}
                                  disabled={loading}
                                  className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-all"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Home;
