import { describe, expect, it } from 'vitest';
import { toBytes32, toHexBytes } from '@/utils/helpers';

// ── toBytes32 ─────────────────────────────────────────────────────────────────

describe('toBytes32', () => {
  it('accepts a valid 0x-prefixed 32-byte hash unchanged', () => {
    const valid = '0x' + 'a'.repeat(64);
    expect(toBytes32(valid)).toBe(valid);
  });

  it('adds 0x prefix when missing', () => {
    const noPrefixHash = 'b'.repeat(64);
    expect(toBytes32(noPrefixHash)).toBe('0x' + noPrefixHash);
  });

  it('throws on a hash that is too short', () => {
    expect(() => toBytes32('0x' + 'a'.repeat(32))).toThrow('malformed 32-byte hash');
  });

  it('throws on a hash that is too long', () => {
    expect(() => toBytes32('0x' + 'a'.repeat(66))).toThrow('malformed 32-byte hash');
  });

  it('throws on non-hex characters', () => {
    expect(() => toBytes32('0x' + 'g'.repeat(64))).toThrow('malformed 32-byte hash');
  });

  it('throws on an empty string', () => {
    expect(() => toBytes32('')).toThrow('malformed 32-byte hash');
  });
});

// ── toHexBytes ────────────────────────────────────────────────────────────────

describe('toHexBytes', () => {
  it('accepts an empty 0x (zero bytes)', () => {
    expect(toHexBytes('0x')).toBe('0x');
  });

  it('accepts arbitrary-length valid hex', () => {
    const hex = '0x' + 'deadbeef'.repeat(10);
    expect(toHexBytes(hex)).toBe(hex);
  });

  it('adds 0x prefix when missing', () => {
    expect(toHexBytes('deadbeef')).toBe('0xdeadbeef');
  });

  it('throws on non-hex characters', () => {
    expect(() => toHexBytes('0xzzzz')).toThrow('malformed hex value');
  });
});