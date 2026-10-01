import { describe, it, expect } from 'vitest';
import { shouldEnqueue, nextAttemptAt } from '../../../src/ai/pipeline/batcher.js';

const cfg = { quietSeconds: 180, maxMessages: 25, maxWaitSeconds: 600 };
const now = new Date('2026-09-23T09:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000);

describe('shouldEnqueue (SPEC §8)', () => {
  it.each([
    [{ pendingCount: 3, lastMessageAt: ago(180), oldestPendingAt: ago(200) }, true],
    [{ pendingCount: 3, lastMessageAt: ago(179), oldestPendingAt: ago(179) }, false],
    [{ pendingCount: 25, lastMessageAt: ago(5), oldestPendingAt: ago(60) }, true],
    [{ pendingCount: 4, lastMessageAt: ago(10), oldestPendingAt: ago(600) }, true],
    [{ pendingCount: 0, lastMessageAt: ago(999), oldestPendingAt: ago(999) }, false],
  ])('%j → %s', (s, expected) => expect(shouldEnqueue(s, cfg, now)).toBe(expected));
});

describe('nextAttemptAt', () => {
  it.each([
    [1, 1],
    [2, 5],
    [3, 15],
    [4, 15],
  ])('after failure %i waits %i min', (n, min) =>
    expect(nextAttemptAt(n, now)!.getTime() - now.getTime()).toBe(min * 60_000),
  );
  it('gives up after the 5th failure', () => expect(nextAttemptAt(5, now)).toBeNull());
});
