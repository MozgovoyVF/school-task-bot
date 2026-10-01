import { describe, it, expect } from 'vitest';
import { quickDue } from '../../../src/time/quickDue.js';

// 2026-09-23 12:00 MSK — a Wednesday (plan.md Task 2.14's brief, D23).
const WED = new Date('2026-09-23T12:00:00+03:00');
const ZONE = 'Europe/Moscow';

describe('quickDue (D23)', () => {
  it('today → 23.09, all-day 23:59 MSK (20:59Z)', () => {
    expect(quickDue('today', WED, ZONE)).toEqual({
      at: new Date('2026-09-23T20:59:00.000Z'),
      allDay: true,
      tz: ZONE,
    });
  });

  it('tomorrow → 24.09', () => {
    expect(quickDue('tomorrow', WED, ZONE)).toEqual({
      at: new Date('2026-09-24T20:59:00.000Z'),
      allDay: true,
      tz: ZONE,
    });
  });

  it('fri → 25.09 (this week, since today is before Friday)', () => {
    expect(quickDue('fri', WED, ZONE)).toEqual({
      at: new Date('2026-09-25T20:59:00.000Z'),
      allDay: true,
      tz: ZONE,
    });
  });

  it('fri on a Friday → the same day', () => {
    const fri = new Date('2026-09-25T09:00:00+03:00');
    expect(quickDue('fri', fri, ZONE).at).toEqual(new Date('2026-09-25T20:59:00.000Z'));
  });

  it('fri on a Saturday → the next Friday (02.10), not the one just passed', () => {
    const sat = new Date('2026-09-26T09:00:00+03:00');
    expect(quickDue('fri', sat, ZONE).at).toEqual(new Date('2026-10-02T20:59:00.000Z'));
  });

  it('next_mon → 28.09', () => {
    expect(quickDue('next_mon', WED, ZONE)).toEqual({
      at: new Date('2026-09-28T20:59:00.000Z'),
      allDay: true,
      tz: ZONE,
    });
  });

  it('next_mon on a Monday → next week’s Monday, not today', () => {
    const mon = new Date('2026-09-28T09:00:00+03:00');
    expect(quickDue('next_mon', mon, ZONE).at).toEqual(new Date('2026-10-05T20:59:00.000Z'));
  });

  it('none → no due date', () => {
    expect(quickDue('none', WED, ZONE)).toEqual({ at: null, allDay: false, tz: null });
  });
});
