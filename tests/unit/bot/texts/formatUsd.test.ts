import { describe, it, expect } from 'vitest';
import { formatUsd } from '../../../../src/bot/texts/ru.js';

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

  it('prints "<0.0001" instead of a misleading "0.0000" for anything smaller still (M7)', () => {
    expect(formatUsd(0.00009)).toBe('<0.0001');
    expect(formatUsd(0.000001)).toBe('<0.0001');
  });
});
