import { describe, it, expect } from 'vitest';
import { isQuietAt } from '../../../src/time/quiet.js';
import type { Settings } from '../../../src/domain/settings/schema.js';

type QuietConfig = Settings['quiet'];

const MSK = 'Europe/Moscow';
// Explicitly typed (rather than inferred): an inferred `off` would type its empty `weekdays`/`dateRanges`
// array literals as `never[]`, which then rejects every other fixture below that fills them in.
const off: QuietConfig = {
  enabled: false,
  weekdays: [],
  windows: [{ from: '22:00', to: '08:00' }],
  dateRanges: [],
};
const night: QuietConfig = { ...off, enabled: true };
const q = (iso: string, cfg: QuietConfig, zone = MSK) => isQuietAt(new Date(iso), zone, cfg);

describe('quiet hours (SPEC §13.5, D10)', () => {
  it('is off when disabled', () => expect(q('2026-09-23T20:00:00Z', off)).toBe(false));
  it.each([
    ['2026-09-23T20:00:00Z', true], // 23:00 МСК
    ['2026-09-24T04:59:00Z', true], // 07:59
    ['2026-09-24T05:00:00Z', false], // 08:00
    ['2026-09-23T18:59:00Z', false], // 21:59
  ])('overnight window at %s', (iso, expected) => expect(q(iso, night)).toBe(expected));
  it('supports same-day windows', () => {
    const lunch = { ...night, windows: [{ from: '13:00', to: '14:00' }] };
    expect(q('2026-09-23T10:30:00Z', lunch)).toBe(true);
    expect(q('2026-09-23T11:00:00Z', lunch)).toBe(false);
  });
  it('supports ISO weekdays', () => {
    const weekend = { ...night, windows: [], weekdays: [6, 7] };
    expect(q('2026-09-26T09:00:00Z', weekend)).toBe(true); // сб
    expect(q('2026-09-25T09:00:00Z', weekend)).toBe(false); // пт
  });
  it('supports inclusive date ranges', () => {
    const hol = { ...night, windows: [], dateRanges: [{ from: '2026-12-31', to: '2027-01-08' }] };
    expect(q('2027-01-08T20:00:00Z', hol)).toBe(true); // 23:00 8 янв
    expect(q('2027-01-08T21:00:00Z', hol)).toBe(false); // 00:00 9 янв
    expect(q('2026-12-30T20:59:00Z', hol)).toBe(false); // 23:59 30 дек
  });
  it('evaluates in the recipient zone', () => {
    expect(q('2026-09-23T18:00:00Z', night, MSK)).toBe(false); // 21:00 МСК
    expect(q('2026-09-23T18:00:00Z', night, 'Asia/Yekaterinburg')).toBe(true); // 23:00
  });
});
