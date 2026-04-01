// nextjs/tests/admin/verify.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("iron-session", () => ({ getIronSession: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn().mockResolvedValue({}) }));
vi.mock("viem/siwe", () => ({
  parseSiweMessage: vi.fn(),
  generateSiweNonce: vi.fn().mockReturnValue("TestNonce1234567"),
}));
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(),
    http: vi.fn(),
  };
});

process.env.NEXT_PUBLIC_VAULT_ADDRESS = "0xVaultAddress000000000000000000000000000";
process.env.ALCHEMY_RPC_URL = "https://mock-rpc.example.com";

import { getIronSession } from "iron-session";
import { parseSiweMessage } from "viem/siwe";
import { createPublicClient } from "viem";
import { POST } from "@/app/api/admin/verify/route";

// ── Constants ─────────────────────────────────────────────────────────────────

const OWNER_ADDRESS = "0xOwnerAddress00000000000000000000000000001";
const VAULT_ADDRESS = "0xVaultAddress000000000000000000000000000";
const VALID_NONCE = "TestNonce1234567";
const VALID_DOMAIN = "localhost:3000";
const VALID_SIGNATURE = "0xsignature";

const VALID_FIELDS = {
  address: OWNER_ADDRESS,
  domain: VALID_DOMAIN,
  nonce: VALID_NONCE,
  expirationTime: undefined,
  uri: "http://localhost:3000/admin",
  version: "1",
  chainId: 11155111,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides: Record<string, unknown> = {}) {
  return { save: vi.fn().mockResolvedValue(undefined), ...overrides };
}

function makeRequest(body: unknown, host = VALID_DOMAIN): NextRequest {
  return new NextRequest(`http://${host}/api/admin/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", host },
    body: JSON.stringify(body),
  });
}

function mockPublicClient({
  verifyMessage = true,
  vaultOwner = OWNER_ADDRESS,
}: {
  verifyMessage?: boolean;
  vaultOwner?: string;
} = {}) {
  vi.mocked(createPublicClient).mockReturnValue({
    verifyMessage: vi.fn().mockResolvedValue(verifyMessage),
    readContract: vi.fn().mockResolvedValue(vaultOwner),
  } as any);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/admin/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: valid session with stored nonce, valid parse, valid client
    vi.mocked(getIronSession).mockResolvedValue(makeSession({ nonce: VALID_NONCE }) as any);
    vi.mocked(parseSiweMessage).mockReturnValue(VALID_FIELDS as any);
    mockPublicClient();
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it("returns 400 when body is missing entirely", async () => {
    const req = new NextRequest("http://localhost:3000/api/admin/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: VALID_DOMAIN },
      body: "not json",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when message field is missing", async () => {
    const res = await POST(makeRequest({ signature: VALID_SIGNATURE }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when signature field is missing", async () => {
    const res = await POST(makeRequest({ message: "some message" }));
    expect(res.status).toBe(400);
  });

  // ── SIWE parse failure ──────────────────────────────────────────────────────

  it("returns 400 when parseSiweMessage throws (malformed EIP-4361 string)", async () => {
    vi.mocked(parseSiweMessage).mockImplementation(() => {
      throw new Error("invalid message");
    });

    const res = await POST(makeRequest({ message: "garbage", signature: VALID_SIGNATURE }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/malformed/i);
  });

  it("returns 400 when parsed message has no address field", async () => {
    vi.mocked(parseSiweMessage).mockReturnValue({ ...VALID_FIELDS, address: undefined } as any);

    const res = await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));
    expect(res.status).toBe(400);
  });

  // ── Domain check ────────────────────────────────────────────────────────────

  it("returns 401 when domain in message does not match request host", async () => {
    // The parsed message claims domain = "evil.com", but the request comes from localhost:3000
    vi.mocked(parseSiweMessage).mockReturnValue({
      ...VALID_FIELDS,
      domain: "evil.com",
    } as any);

    const res = await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toMatch(/domain mismatch/i);
  });

  // ── Nonce checks ────────────────────────────────────────────────────────────

  it("returns 401 when no nonce is stored in the session", async () => {
    // Session was never initialized or nonce was consumed already
    vi.mocked(getIronSession).mockResolvedValue(makeSession({ nonce: undefined }) as any);

    const res = await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toMatch(/nonce/i);
  });

  it("returns 401 when nonce in message does not match session nonce", async () => {
    vi.mocked(getIronSession).mockResolvedValue(makeSession({ nonce: "DifferentNonce99" }) as any);
    // parseSiweMessage returns the original VALID_NONCE, which won't match

    const res = await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toMatch(/nonce/i);
  });

  it("always clears the session nonce, even when verification fails", async () => {
    const session = makeSession({ nonce: VALID_NONCE });
    vi.mocked(getIronSession).mockResolvedValue(session as any);
    // Force a domain failure so the route returns early
    vi.mocked(parseSiweMessage).mockReturnValue({ ...VALID_FIELDS, domain: "evil.com" } as any);

    await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));

    expect(session.nonce).toBeUndefined();
    expect(session.save).toHaveBeenCalled();
  });

  // ── Expiry check ────────────────────────────────────────────────────────────

  it("returns 401 when the SIWE message has expired", async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    vi.mocked(parseSiweMessage).mockReturnValue({
      ...VALID_FIELDS,
      expirationTime: pastDate,
    } as any);

    const res = await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toMatch(/expired/i);
  });

  it("accepts a message with a future expiration time", async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour from now
    vi.mocked(parseSiweMessage).mockReturnValue({
      ...VALID_FIELDS,
      expirationTime: futureDate,
    } as any);

    const res = await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));
    expect(res.status).toBe(200);
  });

  // ── Signature verification ──────────────────────────────────────────────────

  it("returns 401 when viem verifyMessage returns false", async () => {
    mockPublicClient({ verifyMessage: false });

    const res = await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toMatch(/invalid signature/i);
  });

  it("calls verifyMessage with the correct address from the parsed message", async () => {
    const mockVerify = vi.fn().mockResolvedValue(true);
    vi.mocked(createPublicClient).mockReturnValue({
      verifyMessage: mockVerify,
      readContract: vi.fn().mockResolvedValue(OWNER_ADDRESS),
    } as any);

    await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));

    expect(mockVerify).toHaveBeenCalledWith(
      expect.objectContaining({ address: OWNER_ADDRESS, signature: VALID_SIGNATURE })
    );
  });

  // ── Ownership check ─────────────────────────────────────────────────────────

  it("returns 403 when the signing address is not the vault owner", async () => {
    mockPublicClient({ vaultOwner: "0xDifferentOwner000000000000000000000000001" });

    const res = await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/vault owner/i);
  });

  it("does the vault owner check against the env-configured vault address", async () => {
    const mockReadContract = vi.fn().mockResolvedValue(OWNER_ADDRESS);
    vi.mocked(createPublicClient).mockReturnValue({
      verifyMessage: vi.fn().mockResolvedValue(true),
      readContract: mockReadContract,
    } as any);

    await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));

    expect(mockReadContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: VAULT_ADDRESS })
    );
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns 200 with the authenticated address on success", async () => {
    const res = await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.address).toBe(OWNER_ADDRESS);
  });

  it("saves authenticated=true and the address to the session on success", async () => {
    const session = makeSession({ nonce: VALID_NONCE });
    vi.mocked(getIronSession).mockResolvedValue(session as any);

    await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));

    expect(session.authenticated).toBe(true);
    expect(session.address).toBe(OWNER_ADDRESS);
    expect(session.save).toHaveBeenCalled();
  });

  it("nonce is cleared from session after successful verification", async () => {
    const session = makeSession({ nonce: VALID_NONCE });
    vi.mocked(getIronSession).mockResolvedValue(session as any);

    await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));

    expect(session.nonce).toBeUndefined();
  });

  // ── Vault address not configured ────────────────────────────────────────────

  it("returns 500 when NEXT_PUBLIC_VAULT_ADDRESS is not set", async () => {
    const original = process.env.NEXT_PUBLIC_VAULT_ADDRESS;
    delete process.env.NEXT_PUBLIC_VAULT_ADDRESS;

    const res = await POST(makeRequest({ message: "ok", signature: VALID_SIGNATURE }));
    expect(res.status).toBe(500);

    process.env.NEXT_PUBLIC_VAULT_ADDRESS = original;
  });
});
