import { describe, it, expect } from 'vitest';
import { AliasValidationError, parseAliases } from '../../../src/domain/people/repo.js';

describe('parseAliases', () => {
  it('trims whitespace, drops empty entries, and dedupes case-insensitively', () => {
    expect(parseAliases('Маша, Машенька ,маша,, ')).toEqual(['Маша', 'Машенька']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseAliases('   ')).toEqual([]);
    expect(parseAliases('')).toEqual([]);
  });

  it('throws AliasValidationError("too_many") for more than 10 aliases', () => {
    const input = Array.from({ length: 11 }, (_, i) => `alias${String(i)}`).join(', ');
    expect(() => parseAliases(input)).toThrow(AliasValidationError);
    try {
      parseAliases(input);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AliasValidationError);
      expect((err as AliasValidationError).reason).toBe('too_many');
    }
  });

  it('accepts exactly 10 aliases (the limit itself is not an error)', () => {
    const input = Array.from({ length: 10 }, (_, i) => `alias${String(i)}`).join(', ');
    expect(parseAliases(input)).toHaveLength(10);
  });

  it('throws AliasValidationError("too_long") for an alias longer than 30 characters', () => {
    const input = 'a'.repeat(31);
    expect(() => parseAliases(input)).toThrow(AliasValidationError);
    try {
      parseAliases(input);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AliasValidationError);
      expect((err as AliasValidationError).reason).toBe('too_long');
    }
  });

  it('accepts an alias exactly 30 characters long (the limit itself is not an error)', () => {
    const input = 'a'.repeat(30);
    expect(parseAliases(input)).toEqual([input]);
  });
});
