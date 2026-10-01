import { describe, it, expect } from 'vitest';
import { resolveDue } from '../../../src/time/resolveDue.js';
import type { DueT } from '../../../src/ai/schemas.js';

const fuzzy = {
  morning: '10:00',
  afternoon: '15:00',
  evening: '19:00',
  endOfWeekDay: 5,
  endOfWeekTime: '18:00',
  soonWorkdays: 2,
  defaultTime: '18:00',
};
const WED = '2026-09-23T12:00:00+03:00'; // среда
const r = (due: Partial<DueT>, now = WED, zone = 'Europe/Moscow') =>
  resolveDue(
    { due_local: null, time_hint: 'none', due_text: null, ...due },
    { zone, now: new Date(now), fuzzy },
  );
const iso = (x: { dueAt: Date | null }) => x.dueAt?.toISOString() ?? null;

describe('resolveDue (SPEC §10)', () => {
  it.each([
    [{ due_local: '2026-09-25T18:00' }, '2026-09-25T15:00:00.000Z', false],
    [{ due_local: '2026-09-25', time_hint: 'morning' }, '2026-09-25T07:00:00.000Z', false],
    [{ due_local: '2026-09-25', time_hint: 'afternoon' }, '2026-09-25T12:00:00.000Z', false],
    [{ due_local: '2026-09-25', time_hint: 'evening' }, '2026-09-25T16:00:00.000Z', false],
    [{ due_local: '2026-09-25' }, '2026-09-25T20:59:00.000Z', true],
    [{ time_hint: 'end_of_week' }, '2026-09-25T15:00:00.000Z', false],
    [{ time_hint: 'soon' }, '2026-09-25T15:00:00.000Z', false],
    [{ due_local: '2026-09-25', time_hint: 'end_of_week' }, '2026-09-25T15:00:00.000Z', false], // дата есть → дата + defaultTime
  ] as const)('%j', (due, expected, allDay) => {
    const res = r(due);
    expect(iso(res)).toBe(expected);
    expect(res.allDay).toBe(allDay);
    expect(res.tz).toBe('Europe/Moscow');
  });

  it('returns null due when nothing is given', () => {
    expect(r({})).toMatchObject({ dueAt: null, allDay: false, tz: null, inPast: false });
  });

  it.each([
    ['2026-09-25T17:00:00+03:00', '2026-09-25T15:00:00.000Z'], // пт до 18:00 → сегодня
    ['2026-09-25T18:00:00+03:00', '2026-10-02T15:00:00.000Z'], // ровно 18:00 → следующая
    ['2026-09-25T18:30:00+03:00', '2026-10-02T15:00:00.000Z'],
    ['2026-09-26T10:00:00+03:00', '2026-10-02T15:00:00.000Z'], // сб
    ['2026-09-27T10:00:00+03:00', '2026-10-02T15:00:00.000Z'], // вс
  ])('end_of_week at %s', (now, expected) =>
    expect(iso(r({ time_hint: 'end_of_week' }, now))).toBe(expected),
  );

  it.each([
    ['2026-09-24T12:00:00+03:00', '2026-09-28T15:00:00.000Z'], // чт → пн
    ['2026-09-25T12:00:00+03:00', '2026-09-29T15:00:00.000Z'], // пт → вт
    ['2026-09-26T12:00:00+03:00', '2026-09-29T15:00:00.000Z'], // сб → вт
  ])('soon at %s', (now, expected) => expect(iso(r({ time_hint: 'soon' }, now))).toBe(expected));

  it('crosses the year boundary', () => {
    expect(iso(r({ time_hint: 'soon' }, '2026-12-30T12:00:00+03:00'))).toBe('2027-01-01T15:00:00.000Z');
    expect(iso(r({ time_hint: 'end_of_week' }, '2026-12-31T12:00:00+03:00'))).toBe(
      '2027-01-01T15:00:00.000Z',
    );
  });

  it('flags dates in the past', () => {
    expect(r({ due_local: '2026-09-22' }).inPast).toBe(true);
    expect(r({ due_local: '2026-09-23' }).inPast).toBe(false); // 23:59 сегодня
    expect(r({ due_local: '2026-09-23', time_hint: 'morning' }).inPast).toBe(true);
  });

  it('uses the author zone', () => {
    const res = r({ due_local: '2026-09-25T18:00' }, WED, 'Asia/Yekaterinburg');
    expect(iso(res)).toBe('2026-09-25T13:00:00.000Z');
    expect(res.tz).toBe('Asia/Yekaterinburg');
  });

  it('handles DST gaps and overlaps deterministically', () => {
    expect(iso(r({ due_local: '2026-03-29T02:30' }, '2026-03-20T12:00:00+01:00', 'Europe/Berlin'))).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    expect(iso(r({ due_local: '2026-10-25T02:30' }, '2026-10-20T12:00:00+02:00', 'Europe/Berlin'))).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('marks impossible dates as invalid instead of throwing', () => {
    expect(r({ due_local: '2026-02-30' })).toMatchObject({ dueAt: null, invalid: true });
  });

  it('respects fuzzyTimes overrides', () => {
    const res = resolveDue(
      { due_local: '2026-09-25', time_hint: 'morning', due_text: null },
      { zone: 'Europe/Moscow', now: new Date(WED), fuzzy: { ...fuzzy, morning: '09:30' } },
    );
    expect(iso(res)).toBe('2026-09-25T06:30:00.000Z');
  });
});
