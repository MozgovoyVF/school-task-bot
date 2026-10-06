import { describe, it, expect } from 'vitest';
import { formatUsd, texts } from '../../../../src/bot/texts/ru.js';

/** A `<` not followed by a letter or `/` can never start a real HTML tag — Telegram's `parse_mode: 'HTML'`
 * rejects it outright ("can't parse entities"), rejecting the *whole* message, not just that fragment. */
const RAW_LT = /<(?![a-zA-Z/])/;

// review round 1, M7: a flat `toFixed(2)` rounded any USD amount under one cent to `"0.00"`
// (`LLM_DAILY_BUDGET_USD=0.0001` showed as «из 0.00 $»); the fix (up to 4 decimals, trimmed, for small
// amounts) then had its own edge case — anything below `0.0001` itself still rounded to a bare `"0.0000"`.
describe('formatUsd', () => {
  it('uses two decimal places for zero and anything a whole cent or larger', () => {
    expect(formatUsd(0)).toBe('0.00');
    expect(formatUsd(0.02)).toBe('0.02');
    expect(formatUsd(1.5)).toBe('1.50');
    expect(formatUsd(12.3456)).toBe('12.35');
  });

  it('shows up to 4 decimal places, trimmed of trailing zeros, below one cent', () => {
    expect(formatUsd(0.0001)).toBe('0.0001');
    expect(formatUsd(0.005)).toBe('0.005');
    expect(formatUsd(0.0099)).toBe('0.0099');
  });

  it('prints «менее 0.0001» instead of a misleading "0.0000" for anything smaller still (M7)', () => {
    expect(formatUsd(0.00009)).toBe('менее 0.0001');
    expect(formatUsd(0.000001)).toBe('менее 0.0001');
  });

  // Re-review finding (Important): a raw `<0.0001` broke every HTML call site — Telegram's
  // `parse_mode: 'HTML'` rejects a bare `<` that isn't part of a real tag with "can't parse entities",
  // losing the whole message (the admin panel never rendered, the budget alert never reached the Owner
  // despite being marked sent). formatUsd must never emit a raw `<`/`>`/`&`.
  it('never emits raw HTML-special characters', () => {
    for (const amount of [0, 0.000001, 0.00009, 0.0001, 0.005, 0.02, 1.5, 12.3456]) {
      expect(formatUsd(amount)).not.toMatch(/[<>&]/);
    }
  });
});

// Re-review finding (Important): it's not enough for `formatUsd` itself to be clean in isolation — the two
// real `parse_mode: 'HTML'` messages it's interpolated into (both sent for real with a sub-0.0001 amount,
// e.g. `LLM_DAILY_BUDGET_USD=0.0001`-adjacent spend) must come out with no raw `<` either.
describe('rendered texts using formatUsd stay valid HTML with a sub-0.0001 amount', () => {
  it('texts.errors.budgetPaused', () => {
    const rendered = texts.errors.budgetPaused(0.000001, 0.0001);
    expect(rendered).toContain('менее 0.0001');
    expect(rendered).not.toMatch(RAW_LT);
  });

  it('texts.admin.panel', () => {
    const rendered = texts.admin.panel(
      'test-sha',
      90,
      {
        costToday: 0.000001,
        costMonth: 0.000001,
        last7: { shown: 0, suppressed: 0, accepted: 0, rejected: 0 },
        precision: null,
      },
      [],
      [],
    );
    expect(rendered).toContain('менее 0.0001');
    expect(rendered).not.toMatch(RAW_LT);
  });
});
