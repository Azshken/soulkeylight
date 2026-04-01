// nextjs/tests/admin/nonce.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("iron-session", () => ({ getIronSession: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn().mockResolvedValue({}) }));
vi.mock("viem/siwe", () => ({
  generateSiweNonce: vi.fn().mockReturnValue("TestNonce1234567"),
  parseSiweMessage: vi.fn(),
}));

import { getIronSession } from "iron-session";
import { generateSiweNonce } from "viem/siwe";
import { GET } from "@/app/api/admin/nonce/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides: Record<string, unknown> = {}) {
  const s: Record<string, unknown> = { save: vi.fn().mockResolvedValue(undefined), ...overrides };
  return s;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/admin/nonce", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the generated nonce in the response body", async () => {
    const session = makeSession();
    vi.mocked(getIronSession).mockResolvedValue(session as any);

    const res = await GET();
    const body = await res.json();

    expect(body.nonce).toBe("TestNonce1234567");
  });

  it("stores the nonce in the session", async () => {
    const session = makeSession();
    vi.mocked(getIronSession).mockResolvedValue(session as any);

    await GET();

    expect(session.nonce).toBe("TestNonce1234567");
    expect(session.save).toHaveBeenCalledOnce();
  });

  it("clears authenticated state before saving the new nonce", async () => {
    // Simulate a session that was previously authenticated
    const session = makeSession({ authenticated: true, address: "0xSomeAddress" });
    vi.mocked(getIronSession).mockResolvedValue(session as any);

    await GET();

    expect(session.authenticated).toBe(false);
    expect(session.address).toBeUndefined();
  });

  it("calls generateSiweNonce to produce a spec-compliant alphanumeric nonce", async () => {
    const session = makeSession();
    vi.mocked(getIronSession).mockResolvedValue(session as any);

    await GET();

    expect(generateSiweNonce).toHaveBeenCalledOnce();
  });

  it("returns HTTP 200", async () => {
    vi.mocked(getIronSession).mockResolvedValue(makeSession() as any);

    const res = await GET();

    expect(res.status).toBe(200);
  });
});
