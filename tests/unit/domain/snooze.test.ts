import { describe, it, expect } from 'vitest';
import { snoozeFireAt, SnoozeOptionSchema } from '../../../src/domain/notifications/snooze.js';

const reminders = {
  preDueTime: '10:00',
  allDayDueTime: '10:00',
  overdueTime: '10:00',
  notifyAssignees: true,
  groupOverdueThreshold: 3,
};

const ZONE = 'Europe/Moscow';
// 2026-09-23T09:00:00Z = 12:00 MSK (brief's own fixture, task-3.4-brief.md Step 1).
const NOW = new Date('2026-09-23T09:00:00Z');

describe('snoozeFireAt', () => {
  it('1h → +1 hour', () => {
    expect(snoozeFireAt('1h', NOW, ZONE, reminders)?.toISOString()).toBe('2026-09-23T10:00:00.000Z');
  });

  it('3h → +3 hours', () => {
    expect(snoozeFireAt('3h', NOW, ZONE, reminders)?.toISOString()).toBe('2026-09-23T12:00:00.000Z');
  });

  it('tomorrow → next day at reminders.preDueTime (10:00 MSK)', () => {
    expect(snoozeFireAt('tomorrow', NOW, ZONE, reminders)?.toISOString()).toBe('2026-09-24T07:00:00.000Z');
  });

  it('dayafter → day after next at reminders.preDueTime (10:00 MSK)', () => {
    expect(snoozeFireAt('dayafter', NOW, ZONE, reminders)?.toISOString()).toBe('2026-09-25T07:00:00.000Z');
  });

  it('today18 → 18:00 today, while still in the future', () => {
    expect(snoozeFireAt('today18', NOW, ZONE, reminders)?.toISOString()).toBe('2026-09-23T15:00:00.000Z');
  });

  it('today18 → null once 18:00 has already passed', () => {
    const after1830 = new Date('2026-09-23T15:30:00Z'); // 18:30 MSK
    expect(snoozeFireAt('today18', after1830, ZONE, reminders)).toBeNull();
  });

  it('today18 → null exactly at 18:00 (no longer strictly in the future)', () => {
    const at1800 = new Date('2026-09-23T15:00:00Z'); // 18:00 MSK
    expect(snoozeFireAt('today18', at1800, ZONE, reminders)).toBeNull();
  });

  it('respects a non-default reminders.preDueTime for tomorrow/dayafter', () => {
    const custom = { ...reminders, preDueTime: '08:30' };
    expect(snoozeFireAt('tomorrow', NOW, ZONE, custom)?.toISOString()).toBe('2026-09-24T05:30:00.000Z');
    expect(snoozeFireAt('dayafter', NOW, ZONE, custom)?.toISOString()).toBe('2026-09-25T05:30:00.000Z');
  });
});

describe('SnoozeOptionSchema', () => {
  it('accepts every documented option', () => {
    for (const option of ['1h', 'tomorrow', '3h', 'today18', 'dayafter']) {
      expect(SnoozeOptionSchema.safeParse(option).success).toBe(true);
    }
  });

  it('rejects anything else, including undefined (a missing callback_data arg)', () => {
    expect(SnoozeOptionSchema.safeParse('2h').success).toBe(false);
    expect(SnoozeOptionSchema.safeParse(undefined).success).toBe(false);
  });
});
