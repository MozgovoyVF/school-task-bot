/**
 * The only source of "now" allowed in domain/, ai/, scheduler/ and time/ code
 * (CLAUDE.md §8). Injecting a {@link Clock} instead of calling `new Date()` or
 * `Date.now()` directly lets tests shift time deterministically via
 * `tests/helpers/clock.ts`'s `fixedClock`.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  // eslint-disable-next-line no-restricted-syntax -- the single allowed place
  now: () => new Date(),
};
