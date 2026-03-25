"use client";

import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { formatEther } from "viem";
import { useBalance } from "wagmi";
import { useEffect, useState } from "react";

export const Header = () => {
  return (
    <div className="sticky top-0 z-20 w-full bg-[#0d0f14]/80 backdrop-blur-md border-b border-zinc-800/60">
      <div className="max-w-6xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-emerald-400 font-black tracking-tight text-lg">
            SoulKey
          </span>
          <span className="text-zinc-600 text-sm font-medium hidden sm:block">
            Store
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-zinc-600">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Sepolia
          </div>
          <WalletButton />
        </div>
      </div>
    </div>
  );
};

const WalletButton = () => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted)
    return (
      <button className="px-4 py-2 rounded-xl text-sm font-semibold bg-emerald-500 text-black">
        Connect Wallet
      </button>
    );

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        mounted,
      }) => {
        const connected = mounted && account && chain;
        return (
          <div>
            {!connected ? (
              <button
                onClick={openConnectModal}
                className="px-4 py-2 rounded-xl text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-black transition-all duration-150"
              >
                Connect Wallet
              </button>
            ) : chain.unsupported ? (
              <button
                onClick={openChainModal}
                className="px-4 py-2 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-500 text-white transition-all duration-150"
              >
                Wrong Network
              </button>
            ) : (
              <WalletDisplay
                address={account.address}
                openAccountModal={openAccountModal}
              />
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
};

const WalletDisplay = ({
  address,
  openAccountModal,
}: {
  address: string;
  openAccountModal: () => void;
}) => {
  const { data: balance } = useBalance({ address: address as `0x${string}` });
  const short = `${address.slice(0, 4)}...${address.slice(-4)}`;
  const eth = balance ? parseFloat(formatEther(balance.value)).toFixed(4) : "—";

  return (
    <button
      onClick={openAccountModal}
      className="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-zinc-800 bg-zinc-900/60 hover:border-zinc-600 transition-all duration-150"
    >
      <span className="text-xs text-zinc-400 hidden sm:block">
        {eth} <span className="text-zinc-600">ETH</span>
      </span>
      <span className="text-zinc-700 hidden sm:block">|</span>
      <span className="text-sm font-mono font-semibold text-zinc-200">
        {short}
      </span>
      <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
    </button>
  );
};
