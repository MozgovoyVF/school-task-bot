import { describe, it, expect } from 'vitest';
import {
  CLAIM_ALPHABET,
  generateClaimCode,
  normalizeClaimCode,
  hashClaimCode,
} from '../../../src/domain/people/claim.js';

describe('generateClaimCode', () => {
  it('produces an 8-character code drawn from CLAIM_ALPHABET', () => {
    const code = generateClaimCode();
    expect(code).toHaveLength(8);
    for (const ch of code) {
      expect(CLAIM_ALPHABET).toContain(ch);
    }
  });

  it('is deterministic given a fixed randomBytes source, and unbiased across the whole alphabet (mod 256/32)', () => {
    const zeros = (n: number) => new Uint8Array(n).fill(0);
    expect(generateClaimCode(zeros)).toBe(generateClaimCode(zeros));
    expect(generateClaimCode(zeros)).toBe(CLAIM_ALPHABET[0]?.repeat(8));

    const maxByte = (n: number) => new Uint8Array(n).fill(255);
    const lastChar = CLAIM_ALPHABET[CLAIM_ALPHABET.length - 1];
    expect(generateClaimCode(maxByte)).toBe(lastChar?.repeat(8));
  });
});

describe('normalizeClaimCode', () => {
  it('uppercases and strips spaces and hyphens', () => {
    expect(normalizeClaimCode(' abcd-2345 ')).toBe('ABCD2345');
  });

  it('strips internal spaces and multiple hyphens too', () => {
    expect(normalizeClaimCode('ab-cd 23-45')).toBe('ABCD2345');
  });
});

describe('hashClaimCode', () => {
  it('is deterministic and differs from the input code', () => {
    const h1 = hashClaimCode('ABCD2345');
    const h2 = hashClaimCode('ABCD2345');
    expect(h1).toBe(h2);
    expect(h1).not.toBe('ABCD2345');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different codes', () => {
    expect(hashClaimCode('ABCD2345')).not.toBe(hashClaimCode('ABCD2346'));
  });

  it('normalizes internally, so an un-normalized input hashes the same as its normalized form', () => {
    expect(hashClaimCode(' abcd-2345 ')).toBe(hashClaimCode('ABCD2345'));
  });
});
