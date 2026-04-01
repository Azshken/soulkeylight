// nextjs/tests/admin/adminSession.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("iron-session", () => ({ getIronSession: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn().mockResolvedValue({}) }));

// Import after mocks are registered
import { getIronSession } from "iron-session";
import { requireAdminSession } from "@/utils/adminSession";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("requireAdminSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when session has no address and authenticated is false", async () => {
    vi.mocked(getIronSession).mockResolvedValue(makeSession({ authenticated: false }) as any);

    const result = await requireAdminSession();

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeInstanceOf(NextResponse);
      const body = await result.error.json();
      expect(body.success).toBe(false);
      expect(result.error.status).toBe(401);
    }
  });

  it("returns 401 when session has address but authenticated is false", async () => {
    vi.mocked(getIronSession).mockResolvedValue(
      makeSession({ address: "0xOwner", authenticated: false }) as any
    );

    const result = await requireAdminSession();

    expect("error" in result).toBe(true);
    if ("error" in result) {
      const body = await result.error.json();
      expect(body.error).toMatch(/not authenticated/i);
    }
  });

  it("returns 401 when authenticated is true but address is missing", async () => {
    vi.mocked(getIronSession).mockResolvedValue(
      makeSession({ authenticated: true, address: undefined }) as any
    );

    const result = await requireAdminSession();

    expect("error" in result).toBe(true);
  });

  it("returns address and session when authenticated is true and address is set", async () => {
    const session = makeSession({ authenticated: true, address: "0xOwner" });
    vi.mocked(getIronSession).mockResolvedValue(session as any);

    const result = await requireAdminSession();

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.address).toBe("0xOwner");
      expect(result.session).toBe(session);
    }
  });
});
