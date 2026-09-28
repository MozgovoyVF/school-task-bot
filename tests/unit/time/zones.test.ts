import { describe, it, expect } from 'vitest';
import { parseZoneInput, zoneLabel as rawZoneLabel, userZone } from '../../../src/time/zones.js';
import { formatZoneLabel } from '../../../src/bot/texts/ru.js';

const zoneLabel = (zone: string, at: Date) => formatZoneLabel(rawZoneLabel(zone, at));
const at = new Date('2026-09-23T09:00:00Z');

describe('zones', () => {
  it.each([
    ['Europe/Samara', 'Europe/Samara'],
    ['  asia/yekaterinburg ', 'Asia/Yekaterinburg'],
    ['+5', 'UTC+5'],
    ['UTC+5', 'UTC+5'],
    ['GMT+05:00', 'UTC+5'],
    ['UTC-3:30', 'UTC-3:30'],
    ['МСК+2', 'UTC+5'],
    ['мск', 'Europe/Moscow'],
    ['Mars/Base', null],
    ['+15', null],
  ])('parseZoneInput(%j) → %j', (input, out) => expect(parseZoneInput(input)).toBe(out));

  it.each([
    ['Europe/Moscow', 'МСК'],
    ['Asia/Yekaterinburg', 'МСК+2'],
    ['Europe/Kaliningrad', 'МСК−1'],
    ['Europe/Paris', 'UTC+2'],
    ['UTC+5', 'UTC+5'],
  ])('zoneLabel(%s) → %s', (zone, label) => expect(zoneLabel(zone, at)).toBe(label));

  it('userZone prefers the user zone over the workspace zone', () => {
    expect(userZone({ timezone: 'Asia/Omsk' }, { timezone: 'Europe/Moscow' })).toBe('Asia/Omsk');
  });

  it('userZone falls back to the workspace zone when the user has none', () => {
    expect(userZone({ timezone: null }, { timezone: 'Europe/Moscow' })).toBe('Europe/Moscow');
  });
});
