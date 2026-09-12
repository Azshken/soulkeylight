/**
 * Unit tests for utils/crypto.ts — the AES layer for Neon cd_keys.encrypted_key.
 *
 * New writes are AES-256-GCM with the "v2gcm:" wire prefix (12-byte IV,
 * 16-byte tag). Legacy AES-256-CBC rows (ivHex:ctHex) must stay decryptable.
 * ENCRYPTION_KEY remains the same 32-byte env hex for both formats.
 */
import { describe, expect, it } from 'vitest';

// Must be set before utils/crypto is imported — the module reads env at load time.
process.env.ENCRYPTION_KEY = '0f'.repeat(32);

const { encrypt, decrypt } = await import('@/utils/crypto');

// Genuine AES-256-CBC ciphertext produced by the pre-GCM encrypt() with the
// key above, plaintext 'STEAM-AB12-CD34-EF56', fixed IV 000102...0f.
const CBC_FIXTURE =
  '000102030405060708090a0b0c0d0e0f:acfc8eb8c43767287a7020a8979b765fefc941dad9064184c4e0c42aa5b15abe';
const CBC_FIXTURE_PLAINTEXT = 'STEAM-AB12-CD34-EF56';

function flipNibble(hex: string): string {
  return (hex[0] === 'f' ? '0' : 'f') + hex.slice(1);
}

describe('encrypt — AES-256-GCM v2gcm wire format', () => {
  it('writes "v2gcm:" + ivHex(12B) + ":" + ctHex + ":" + tagHex(16B)', () => {
    const parts = encrypt('AAAA-BBBB').split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v2gcm');
    expect(parts[1]).toHaveLength(24); // 12-byte IV
    expect(parts[2].length).toBeGreaterThan(0);
    expect(parts[3]).toHaveLength(32); // 16-byte tag
  });

  it('roundtrips plaintext through decrypt', () => {
    const plaintext = 'STEAM-X1Y2-Z3W4-Q5R6';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('uses a fresh random IV per call (same plaintext, different wire)', () => {
    expect(encrypt('same-input')).not.toBe(encrypt('same-input'));
  });
});

describe('GCM authentication — tamper must throw', () => {
  it('throws when one ciphertext nibble is flipped', () => {
    const [p, iv, ct, tag] = encrypt('AAAA-BBBB-CCCC').split(':');
    expect(() => decrypt([p, iv, flipNibble(ct), tag].join(':'))).toThrow();
  });

  it('throws when one tag nibble is flipped', () => {
    const [p, iv, ct, tag] = encrypt('AAAA-BBBB-CCCC').split(':');
    expect(() => decrypt([p, iv, ct, flipNibble(tag)].join(':'))).toThrow();
  });

  it('throws when one IV nibble is flipped', () => {
    const [p, iv, ct, tag] = encrypt('AAAA-BBBB-CCCC').split(':');
    expect(() => decrypt([p, flipNibble(iv), ct, tag].join(':'))).toThrow();
  });

  it('throws on a malformed v2gcm wire string', () => {
    expect(() => decrypt('v2gcm:deadbeef')).toThrow();
  });
});

describe('legacy CBC rows — decrypt-only compatibility', () => {
  it('decrypts a pre-GCM fixture (ivHex:ctHex)', () => {
    expect(decrypt(CBC_FIXTURE)).toBe(CBC_FIXTURE_PLAINTEXT);
  });
});
