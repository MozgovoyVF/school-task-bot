import type { Clock } from '../../src/time/clock.js';

/**
 * A test {@link Clock} pinned to a fixed instant, with `set`/`advance` to move
 * it forward deterministically. This is the one legitimate place outside
 * `src/time/clock.ts` allowed to call `new Date()` (tests/** is not covered
 * by the `no-restricted-syntax` clock rule in eslint.config.js).
 */
export function fixedClock(iso: string): Clock & { set(iso: string): void; advance(ms: number): void } {
  let current = new Date(iso);
  return {
    now: () => new Date(current.getTime()),
    set(next: string) {
      current = new Date(next);
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}
