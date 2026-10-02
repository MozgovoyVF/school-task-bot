import { describe, it, expect } from 'vitest';
import { parseDateRange, parseTimeWindow } from '../../../src/time/parseRanges.js';

// 2026-09-23 12:00 MSK (plan.md Task 3.11's brief) — a Wednesday.
const NOW = new Date('2026-09-23T12:00:00+03:00');
const ZONE = 'Europe/Moscow';

describe('parseDateRange', () => {
  it('parses "с DD.MM по DD.MM", inferring the year from `now`', () => {
    expect(parseDateRange('с 31.12 по 08.01', NOW, ZONE)).toEqual({
      from: '2026-12-31',
      to: '2027-01-08',
    });
  });

  it('is regex-based, not dependent on the "с"/"по" words', () => {
    expect(parseDateRange('31.12-08.01', NOW, ZONE)).toEqual({
      from: '2026-12-31',
      to: '2027-01-08',
    });
  });

  it('keeps the current year when the "from" date has not passed yet', () => {
    expect(parseDateRange('с 01.11 по 03.11', NOW, ZONE)).toEqual({
      from: '2026-11-01',
      to: '2026-11-03',
    });
  });

  it('rolls to next year when the "from" date has already passed this year', () => {
    expect(parseDateRange('с 01.03 по 05.03', NOW, ZONE)).toEqual({
      from: '2027-03-01',
      to: '2027-03-05',
    });
  });

  it('uses an explicit year as-is', () => {
    expect(parseDateRange('с 01.01.2027 по 10.01.2027', NOW, ZONE)).toEqual({
      from: '2027-01-01',
      to: '2027-01-10',
    });
  });

  it('rejects an invalid calendar date', () => {
    expect(parseDateRange('32.12', NOW, ZONE)).toBeNull();
  });

  it('rejects input with fewer than two date tokens', () => {
    expect(parseDateRange('только одна дата 01.11', NOW, ZONE)).toBeNull();
    expect(parseDateRange('без дат вообще', NOW, ZONE)).toBeNull();
  });
});

describe('parseTimeWindow', () => {
  it('parses HH:mm-HH:mm', () => {
    expect(parseTimeWindow('22:00-08:00')).toEqual({ from: '22:00', to: '08:00' });
  });

  it('parses the bare-hour shorthand', () => {
    expect(parseTimeWindow('22-8')).toEqual({ from: '22:00', to: '08:00' });
  });

  it('rejects an out-of-range hour', () => {
    expect(parseTimeWindow('25-8')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseTimeWindow('22:00')).toBeNull();
    expect(parseTimeWindow('not-a-window')).toBeNull();
  });
});
