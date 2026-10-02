import { describe, it, expect } from 'vitest';
import { parseSettings, mergeSettings } from '../../../src/domain/settings/schema.js';

const DEFAULTS = {
  summary: { enabled: true, time: '09:00' },
  reminders: {
    preDueTime: '10:00',
    allDayDueTime: '10:00',
    overdueTime: '10:00',
    groupOverdueThreshold: 3,
  },
  quiet: { enabled: false, weekdays: [], windows: [], dateRanges: [] },
  fuzzyTimes: {
    morning: '10:00',
    afternoon: '15:00',
    evening: '19:00',
    endOfWeekDay: 5,
    endOfWeekTime: '18:00',
    soonWorkdays: 2,
    defaultTime: '18:00',
  },
  ai: {
    thresholds: { low: 0.35, high: 0.7, modify: 0.5 },
    autoCreate: { enabled: false, minConfidence: 0.9 },
    proposalExpiryDays: 7,
  },
  batch: { quietSeconds: 180, maxMessages: 25, maxWaitSeconds: 600 },
  reactions: { onDetect: '👀', onAccept: null },
  retention: { messageDays: 30, batchRawDays: 30 },
  privacyNoticeText: null,
};

describe('settings', () => {
  it('fills every default from SPEC §16', () => {
    expect(parseSettings({})).toEqual(DEFAULTS);
    expect(parseSettings(null)).toEqual(DEFAULTS);
  });
  it('deep-merges partial values', () => {
    const s = parseSettings({ summary: { time: '08:30' } });
    expect(s.summary).toEqual({ enabled: true, time: '08:30' });
    expect(s.reminders).toEqual(DEFAULTS.reminders);
  });
  it('rejects invalid values on merge', () => {
    expect(() => mergeSettings(parseSettings({}), { summary: { time: '25:00' } })).toThrow();
    expect(() => mergeSettings(parseSettings({}), { ai: { thresholds: { low: 1.2 } } })).toThrow();
    expect(() => mergeSettings(parseSettings({}), { quiet: { weekdays: [8] } })).toThrow();
    expect(() =>
      mergeSettings(parseSettings({}), { quiet: { dateRanges: [{ from: '2026-13-01', to: '2027-01-08' }] } }),
    ).toThrow();
  });
  it('accepts quiet windows crossing midnight and labelled date ranges', () => {
    const s = mergeSettings(parseSettings({}), {
      quiet: {
        enabled: true,
        windows: [{ from: '22:00', to: '08:00' }],
        dateRanges: [{ from: '2026-12-31', to: '2027-01-08', label: 'Каникулы' }],
      },
    });
    expect(s.quiet.windows).toHaveLength(1);
  });
  it('falls back to defaults on corrupted stored JSON', () => {
    expect(parseSettings({ summary: { time: 42 } }).summary.time).toBe('09:00');
  });
  it('still parses a pre-D40 row carrying the now-removed forMembers/notifyAssignees keys', () => {
    const s = parseSettings({
      summary: { enabled: true, time: '09:00', forMembers: true },
      reminders: {
        preDueTime: '10:00',
        allDayDueTime: '10:00',
        overdueTime: '10:00',
        notifyAssignees: false,
        groupOverdueThreshold: 3,
      },
    });
    expect(s.summary).toEqual({ enabled: true, time: '09:00' });
    expect(s.reminders).toEqual(DEFAULTS.reminders);
  });
});
