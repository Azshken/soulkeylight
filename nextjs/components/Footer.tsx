import Link from "next/link";

export const Footer = () => {
  return (
    <footer className="w-full border-t border-zinc-800/60 bg-[#0d0f14]">
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-4">
        {/* Left — brand + copyright  */}
        <span className="text-zinc-600 text-sm">
          © {new Date().getFullYear()}{" "}
          <span className="text-zinc-400 font-medium">SoulKey Store</span>
        </span>

        {/* Center — useful links */}
        <nav className="flex items-center gap-4 text-sm text-zinc-600">
          <a
            href="https://sepolia.etherscan.io/address/0x137a913554Ace7826c9437A3c6e3610DEc40d547"
            target="_blank"
            rel="noreferrer"
            className="hover:text-zinc-300 transition-colors"
          >
            Vault Contract
          </a>
          <span className="text-zinc-800">·</span>
          <a
            href="mailto:support@yourdomain.com"
            className="hover:text-zinc-300 transition-colors"
          >
            Support
          </a>
          <span className="text-zinc-800">·</span>
          <Link href="/terms" className="hover:text-zinc-300 transition-colors">
            Terms
          </Link>
          <span className="text-zinc-800">·</span>
          <Link
            href="/privacy"
            className="hover:text-zinc-300 transition-colors"
          >
            Privacy
          </Link>
        </nav>

        {/* Right — built on */}
        <div className="flex items-center gap-1.5 text-xs text-zinc-700">
          Built on
          <a
            href="https://ethereum.org"
            target="_blank"
            rel="noreferrer"
            className="text-zinc-500 hover:text-zinc-300 transition-colors font-medium"
          >
            Ethereum
          </a>
        </div>
      </div>
    </footer>
  );
};
