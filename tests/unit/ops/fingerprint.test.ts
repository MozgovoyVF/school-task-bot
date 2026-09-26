import { describe, it, expect } from 'vitest';
import { fingerprint } from '../../../src/ops/errorReporter.js';

function errAt(message: string) {
  return new Error(message);
}

describe('fingerprint', () => {
  it('ignores digits in the message', () => {
    const make = (id: number) => errAt(`Task ${id} not found`);
    expect(fingerprint(make(12))).toBe(fingerprint(make(13)));
  });
  it('differs by error type and message', () => {
    expect(fingerprint(new TypeError('x'))).not.toBe(fingerprint(new RangeError('x')));
    expect(fingerprint(new Error('a'))).not.toBe(fingerprint(new Error('b')));
  });
  it('handles non-Error values', () => {
    expect(fingerprint('boom')).toMatch(/^[a-f0-9]{16,}$/);
  });
});
