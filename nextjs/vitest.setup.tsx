import React from 'react';
import '@testing-library/jest-dom';
import { vi } from 'vitest';

// ── Next.js internals ──────────────────────────────────────────────────────────
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// alt is typed as string | undefined in ImgHTMLAttributes — omit the ?? fallback,
// pass it through as-is so TypeScript doesn't complain about unreachable branches.
vi.mock('next/image', () => ({
  default: ({ src, alt, ...rest }: React.ImgHTMLAttributes<HTMLImageElement> & { src: string }) =>
    React.createElement('img', { src, alt, ...rest }),
}));

// ── Sonner toasts — capture calls in tests ─────────────────────────────────────
vi.mock('sonner', () => ({
  toast: {
    error:   vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

// ── RainbowKit — not under test, stub the connect button ──────────────────────
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: () => React.createElement('button', null, 'Connect Wallet'),
}));