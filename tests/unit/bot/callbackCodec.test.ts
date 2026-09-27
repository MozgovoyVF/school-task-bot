import { describe, it, expect } from 'vitest';
import {
  encodeCallback,
  decodeCallback,
  CallbackTooLongError,
} from '../../../src/bot/keyboards/callbackCodec.js';

describe('callback codec', () => {
  it('encodes per SPEC §25', () => {
    expect(encodeCallback({ entity: 'p', action: 'acc', id: 123 })).toBe('v1:p:acc:123');
    expect(encodeCallback({ entity: 't', action: 'snz', id: 45, arg: '1h' })).toBe('v1:t:snz:45:1h');
  });
  it('round-trips', () => {
    const p = { entity: 'l', action: 'ovd', id: 2, arg: 'a17' } as const;
    expect(decodeCallback(encodeCallback(p))).toEqual(p);
  });
  it.each([
    'v2:p:acc:1',
    'v1:p:acc:abc',
    'v1:zz:acc:1',
    'garbage',
    '',
    'v1:p:acc:-5',
    'v1:p::1',
    'v1:p:ACC:1',
    'v1:p:acc:1:a:b',
  ])('rejects %j', (s) => expect(decodeCallback(s)).toBeNull());
  it('refuses payloads over 64 bytes or with unsafe args', () => {
    expect(() => encodeCallback({ entity: 'p', action: 'acc', id: 1, arg: 'x'.repeat(60) })).toThrow(
      CallbackTooLongError,
    );
    expect(() => encodeCallback({ entity: 'p', action: 'acc', id: 1, arg: 'a:b' })).toThrow();
  });

  // Regression: an id/arg pair can stay under the 64-byte total while still
  // exceeding decodeCallback's per-field caps (arg {1,40}, id {1,15}
  // digits). encodeCallback must reject that instead of silently producing
  // a callback_data its own decoder can't parse back.
  it('refuses an arg under 64 bytes total but over the 40-char wire cap', () => {
    const arg = 'x'.repeat(55);
    const data = `v1:p:a:1:${arg}`;
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(decodeCallback(data)).toBeNull();
    expect(() => encodeCallback({ entity: 'p', action: 'a', id: 1, arg })).toThrow(CallbackTooLongError);
  });

  it('refuses an id under 64 bytes total but over the 15-digit wire cap', () => {
    const id = 1234567890123456; // 16 digits, still a safe integer
    const data = `v1:p:a:${String(id)}`;
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(decodeCallback(data)).toBeNull();
    expect(() => encodeCallback({ entity: 'p', action: 'a', id })).toThrow(CallbackTooLongError);
  });
});
