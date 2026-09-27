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
});
