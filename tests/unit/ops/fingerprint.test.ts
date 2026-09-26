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
  it('still groups occurrences when the message itself spans multiple lines', () => {
    // Regression: a naive `stack.split('\n').slice(1)` treats the message's own second line
    // ("field a is <id>") as if it were the first stack frame, so a digit embedded in a later
    // message line would leak into the fingerprint unmasked and defeat grouping.
    const make = (id: number) => errAt(`Validation failed:\nfield a is ${id}\nfield b is missing`);
    expect(fingerprint(make(1))).toBe(fingerprint(make(2)));
  });
});
