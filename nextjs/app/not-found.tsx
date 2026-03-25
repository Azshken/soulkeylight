// app/not-found.tsx
export const dynamic = "force-dynamic"; // ← prevents static prerender

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#0d0f14] text-zinc-400">
      <h1 className="text-6xl font-black text-emerald-400 mb-4">404</h1>
      <p className="text-zinc-500 mb-8">Page not found</p>
      <Link
        href="/"
        className="px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-semibold transition-all"
      >
        Go Home
      </Link>
    </div>
  );
}
