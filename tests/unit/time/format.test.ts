import { describe, it, expect } from 'vitest';
import { formatDue } from '../../../src/time/format.js';
import { texts } from '../../../src/bot/texts/ru.js';

const render = (due: { at: Date; allDay: boolean; tz: string | null } | null, viewerZone: string): string =>
  texts.formatDue(formatDue(due, viewerZone));

describe('formatDue', () => {
  it('returns null for no due date, rendered as "без срока"', () => {
    expect(formatDue(null, 'Europe/Moscow')).toBeNull();
    expect(render(null, 'Europe/Moscow')).toBe('без срока');
  });

  it('renders an all-day due date without a time or a zone label (D29)', () => {
    const due = { at: new Date('2026-09-25T20:59:00Z'), allDay: true, tz: 'Europe/Moscow' };
    const struct = formatDue(due, 'Europe/Moscow');
    expect(struct).toEqual({ date: 'пт, 25 сен', time: null, zone: null });
    expect(render(due, 'Europe/Moscow')).toBe('пт, 25 сен');
    // Even a different viewer zone (which also rolls the calendar day itself
    // forward, 23:59 MSK -> 01:59 Yekaterinburg the next day) must not add a
    // time or a zone label for an all-day due date.
    const struct2 = formatDue(due, 'Asia/Yekaterinburg');
    expect(struct2).toEqual({ date: 'сб, 26 сен', time: null, zone: null });
  });

  it('does not pad a single-digit day (1 января)', () => {
    const due = { at: new Date('2026-01-01T07:00:00Z'), allDay: false, tz: 'Europe/Moscow' };
    expect(render(due, 'Europe/Moscow')).toBe('чт, 1 янв, 10:00');
  });

  it('omits the zone label when the viewer zone matches the due date zone', () => {
    const due = { at: new Date('2026-09-25T15:00:00Z'), allDay: false, tz: 'Europe/Moscow' };
    const struct = formatDue(due, 'Europe/Moscow');
    expect(struct?.zone).toBeNull();
    expect(render(due, 'Europe/Moscow')).toBe('пт, 25 сен, 18:00');
  });

  it('appends the viewer zone label when it differs from the due date zone (D29)', () => {
    const due = { at: new Date('2026-09-25T15:00:00Z'), allDay: false, tz: 'Europe/Moscow' };
    expect(render(due, 'Asia/Yekaterinburg')).toBe('пт, 25 сен, 20:00 (МСК+2)');
  });
});
