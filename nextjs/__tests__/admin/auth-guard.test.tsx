// nextjs/tests/admin/auth-guard.test.ts
//
// Verifies that every protected admin route rejects unauthenticated requests
// with a 401 before performing any business logic. These are the regression
// tests for the session auth guard replacing the old timestamp+verifyMessage
// pattern. If requireAdminSession is ever removed from a route, these fail.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("iron-session", () => ({ getIronSession: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn().mockResolvedValue({}) }));

// Prevent any real DB / RPC / Pinata calls from running
vi.mock("@vercel/postgres", () => ({ sql: vi.fn() }));
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: vi.fn(), http: vi.fn() };
});
vi.mock("@/utils/db", () => ({
  getOrCreateProduct: vi.fn(),
  createBatch: vi.fn(),
  insertCDKeys: vi.fn(),
  filterExistingHashes: vi.fn().mockResolvedValue(new Set()),
  getAvailableKeyCount: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/utils/crypto", () => ({
  encrypt: vi.fn().mockReturnValue("encrypted"),
  hashCDKey: vi.fn().mockReturnValue("hash"),
}));

import { getIronSession } from "iron-session";
import { createPublicClient } from "viem";
import { POST as registerGame } from "@/app/api/admin/register-game/route";
import { POST as deregisterGame } from "@/app/api/admin/deregister-game/route";
import { POST as importKeys } from "@/app/api/admin/import-keys/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function unauthenticatedSession() {
  return { save: vi.fn().mockResolvedValue(undefined), authenticated: false };
}

function makePost(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CONTRACT = "0x0000000000000000000000000000000000001111";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Admin route auth guard — unauthenticated requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIronSession).mockResolvedValue(unauthenticatedSession() as any);
  });

  it("register-game returns 401 with no active session", async () => {
    const req = makePost("http://localhost/api/admin/register-game", {
      contractAddress: CONTRACT,
      metadataCid: "QmSomeCid",
    });
    const res = await registerGame(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not authenticated/i);
  });

  it("deregister-game returns 401 with no active session", async () => {
    const req = makePost("http://localhost/api/admin/deregister-game", {
      contractAddress: CONTRACT,
    });
    const res = await deregisterGame(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.success).toBe(false);
  });

  it("import-keys returns 401 with no active session", async () => {
    const req = makePost("http://localhost/api/admin/import-keys", {
      keys: ["AAAA-BBBB-CCCC-DDDD"],
      contractAddress: CONTRACT,
    });
    const res = await importKeys(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.success).toBe(false);
  });

  it("none of the protected routes call any DB or RPC logic when unauthenticated", async () => {
    const { sql } = await import("@vercel/postgres");

    const routes = [
      makePost("http://localhost/api/admin/register-game", { contractAddress: CONTRACT, metadataCid: "Qm" }),
      makePost("http://localhost/api/admin/deregister-game", { contractAddress: CONTRACT }),
      makePost("http://localhost/api/admin/import-keys", { keys: ["K"], contractAddress: CONTRACT }),
    ];
    const handlers = [registerGame, deregisterGame, importKeys];

    for (let i = 0; i < routes.length; i++) {
      await handlers[i](routes[i]);
    }

    expect(sql).not.toHaveBeenCalled();
    expect(vi.mocked(createPublicClient)).not.toHaveBeenCalled();
  });
});

// ── Ownership guard (authenticated but wrong contract owner) ──────────────────

describe("Admin route ownership guard — authenticated but wrong owner", () => {
  const REAL_OWNER    = "0x0000000000000000000000000000000000002222";
  const SESSION_ADDRESS = "0x0000000000000000000000000000000000003333";

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getIronSession).mockResolvedValue({
      save: vi.fn().mockResolvedValue(undefined),
      authenticated: true,
      address: SESSION_ADDRESS,
    } as any);

    // On-chain owner returns a different address than the session address
    vi.mocked(createPublicClient).mockReturnValue({
      readContract: vi.fn().mockResolvedValue(REAL_OWNER),
      verifyMessage: vi.fn().mockResolvedValue(true),
    } as any);
  });

  it("register-game returns 403 when session address is not the game contract owner", async () => {
    const req = makePost("http://localhost/api/admin/register-game", {
      contractAddress: CONTRACT,
      metadataCid: "QmSomeCid",
    });
    const res = await registerGame(req);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/not the contract owner/i);
  });

  it("import-keys returns 403 when session address is not the game contract owner", async () => {
    const req = makePost("http://localhost/api/admin/import-keys", {
      keys: ["KEY-1234"],
      contractAddress: CONTRACT,
    });
    const res = await importKeys(req);
    const body = await res.json();

    expect(res.status).toBe(403);
  });

  it("deregister-game returns 403 when session address is not the game contract owner", async () => {
    const req = makePost("http://localhost/api/admin/deregister-game", {
      contractAddress: CONTRACT,
    });
    const res = await deregisterGame(req);
    const body = await res.json();

    expect(res.status).toBe(403);
  });
});
