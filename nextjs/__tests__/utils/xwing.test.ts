/**
 * Unit tests for the X-Wing (v2) on-chain claim ciphertext — utils/xwing.ts
 * plus utils/crypto.ts encryptWithXWing.
 *
 * Coverage: seed derivation from a 65-byte personal_sign mock (HKDF-SHA256,
 * salt "soulkey-xwing-v2", full-signature IKM), server-encrypt → client
 * WebCrypto-decrypt roundtrip, the exact on-chain blob layout, tamper
 * rejection, v1 (unprefixed X25519) dual-read, and length-based version
 * disambiguation.
 */
import { hexToBytes } from 'viem';
import { describe, expect, it, vi } from 'vitest';

// jsdom ships no crypto.subtle — Node webcrypto is drop-in for AES-GCM.
if (!globalThis.crypto?.subtle) {
  const { webcrypto } = await import('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
}

// crypto.ts reads ENCRYPTION_KEY at module load. The X-Wing path does not
// use it (the KEM shared secret is the AES key), but keep the module
// deterministic for the legacy encryptWithX25519 helper used below.
process.env.ENCRYPTION_KEY = '0f'.repeat(32);

const { encryptWithX25519, encryptWithXWing } = await import('@/utils/crypto');
const {
  XWING_CT_BYTES,
  XWING_VERSION_BYTE,
  claimCiphertextVersion,
  decryptClaimCiphertextWebCrypto,
  decryptXWingWebCrypto,
  deriveXWingSeedFromSignature,
  xwingKeypairFromSeed,
} = await import('@/utils/xwing');
const {
  deriveX25519SecretFromSignature,
  x25519PublicFromSecret,
} = await import('@/utils/x25519');

// Full 65-byte signature (r || s || v) — same shape as the HomeClient mocks.
const MOCK_SIG = '0x' + 'ab'.repeat(64) + '01';
const CD_KEY = 'STEAM-AB12-CD34-EF56';

function pkHex(pk: Uint8Array): string {
  return '0x' + Buffer.from(pk).toString('hex');
}

describe('X-Wing seed derivation (personal_sign + HKDF-SHA256, salt soulkey-xwing-v2)', () => {
  it('derives a deterministic 32-byte seed from the full 65-byte signature', () => {
    const a = deriveXWingSeedFromSignature(MOCK_SIG);
    const b = deriveXWingSeedFromSignature(MOCK_SIG);
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('is domain-separated from the v1 X25519 derivation (different salt)', () => {
    const seed = deriveXWingSeedFromSignature(MOCK_SIG);
    const v1 = deriveX25519SecretFromSignature(MOCK_SIG);
    expect(Buffer.from(seed).equals(Buffer.from(v1))).toBe(false);
  });

  it('rejects a signature that is not 65 bytes (never slices to 32)', () => {
    expect(() => deriveXWingSeedFromSignature('0x' + 'ab'.repeat(32) + '01')).toThrow(/65/);
  });

  it('expands the seed to a 1216-byte X-Wing public key', () => {
    const seed = deriveXWingSeedFromSignature(MOCK_SIG);
    const { publicKey } = xwingKeypairFromSeed(seed);
    expect(publicKey).toHaveLength(1216);
  });
});

describe('encryptWithXWing — on-chain v2 blob', () => {
  const seed = deriveXWingSeedFromSignature(MOCK_SIG);
  const { publicKey } = xwingKeypairFromSeed(seed);

  it('emits version(0x02) || xwing_ct(1120) || nonce(12) || tag(16) || aes_ct', () => {
    const ct = encryptWithXWing(CD_KEY, pkHex(publicKey));
    const raw = hexToBytes(ct as `0x${string}`);
    expect(raw[0]).toBe(XWING_VERSION_BYTE);
    expect(raw.length).toBe(1 + XWING_CT_BYTES + 12 + 16 + CD_KEY.length);
    expect(claimCiphertextVersion(raw)).toBe(2);
  });

  it('roundtrips through the client-side WebCrypto decrypt', async () => {
    const ct = encryptWithXWing(CD_KEY, pkHex(publicKey));
    expect(await decryptXWingWebCrypto(ct, seed)).toBe(CD_KEY);
    expect(
      await decryptClaimCiphertextWebCrypto(ct, {
        x25519SecretKey: deriveX25519SecretFromSignature(MOCK_SIG),
        xwingSeed: seed,
      }),
    ).toBe(CD_KEY);
  });

  it('rejects a tampered AES-GCM nibble', async () => {
    const ct = encryptWithXWing(CD_KEY, pkHex(publicKey));
    const tail = ct.slice(0, -2) + (ct.endsWith('00') ? '01' : '00');
    await expect(decryptXWingWebCrypto(tail, seed)).rejects.toThrow();
  });

  it('rejects a tampered X-Wing ciphertext nibble (wrong shared secret)', async () => {
    const ct = encryptWithXWing(CD_KEY, pkHex(publicKey));
    const i = 10; // inside the xwing_ct region ("0x" + "02" + ct bytes...)
    const ch = ct[i] === 'f' ? '0' : 'f';
    const tampered = ct.slice(0, i) + ch + ct.slice(i + 1);
    await expect(decryptXWingWebCrypto(tampered, seed)).rejects.toThrow();
  });
});

describe('dual-read — v1 (unprefixed X25519) blobs still reveal', () => {
  it('decrypts a v1 ciphertext through the combined reveal helper', async () => {
    const v1Sk = deriveX25519SecretFromSignature(MOCK_SIG);
    const v1Ct = encryptWithX25519(CD_KEY, pkHex(x25519PublicFromSecret(v1Sk)));
    const raw = hexToBytes(v1Ct as `0x${string}`);
    expect(claimCiphertextVersion(raw)).toBe(1);
    const pt = await decryptClaimCiphertextWebCrypto(v1Ct, {
      x25519SecretKey: v1Sk,
      xwingSeed: deriveXWingSeedFromSignature(MOCK_SIG),
    });
    expect(pt).toBe(CD_KEY);
  });

  it('treats a short 0x02-prefixed blob as v1 (length disambiguates)', () => {
    const fakeV1 = new Uint8Array(70);
    fakeV1[0] = XWING_VERSION_BYTE;
    expect(claimCiphertextVersion(fakeV1)).toBe(1);
  });
});
