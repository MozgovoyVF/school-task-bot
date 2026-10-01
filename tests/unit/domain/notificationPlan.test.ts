import { describe, it, expect } from 'vitest';
import { planTaskNotifications, type PlanRecipient } from '../../../src/domain/notifications/plan.js';

const reminders = {
  preDueTime: '10:00',
  allDayDueTime: '10:00',
  overdueTime: '10:00',
  // Not part of the brief's fixture, but required by `Settings['reminders']` (schema.ts) and unused by this
  // module (D40: task notifications go only to the owner, never assignees).
  notifyAssignees: true,
  groupOverdueThreshold: 3,
};
const owner: PlanRecipient = { userId: 10, zone: 'Europe/Moscow' };
const FRI_18_MSK = new Date('2026-09-25T15:00:00Z');
const FRI_ALLDAY_MSK = new Date('2026-09-25T20:59:00Z');
const task = (
  o: Partial<{
    id: number;
    version: number;
    dueAt: Date | null;
    dueAllDay: boolean;
    dueTz: string | null;
    status: string;
  }> = {},
) => ({
  id: 1,
  version: 1,
  dueAt: FRI_18_MSK,
  dueAllDay: false,
  dueTz: 'Europe/Moscow',
  status: 'open',
  ...o,
});
const plan = (
  t: ReturnType<typeof task>,
  now: string,
  recipients: PlanRecipient[] = [owner],
  r = reminders,
) =>
  planTaskNotifications({ task: t, recipients, reminders: r, now: new Date(now) }).map((n) => [
    n.kind,
    n.recipientUserId,
    n.fireAt.toISOString(),
    n.dedupeKey,
  ]);

describe('planTaskNotifications', () => {
  it('datetime due more than 24h ahead', () => {
    expect(plan(task(), '2026-09-23T09:00:00Z')).toEqual([
      ['pre_due', 10, '2026-09-24T07:00:00.000Z', 'task:1:v1:pre_due:10:2026-09-24'],
      ['due', 10, '2026-09-25T15:00:00.000Z', 'task:1:v1:due:10:2026-09-25'],
      ['overdue', 10, '2026-09-26T07:00:00.000Z', 'task:1:v1:overdue:10:2026-09-26'],
    ]);
  });
  it('skips pre_due when due is less than 24h away (D8)', () => {
    expect(plan(task(), '2026-09-25T00:00:00Z').map((x) => x[0])).toEqual(['due', 'overdue']);
  });
  it('all-day due', () => {
    expect(
      plan(task({ dueAt: FRI_ALLDAY_MSK, dueAllDay: true }), '2026-09-23T09:00:00Z').map((x) => x[2]),
    ).toEqual(['2026-09-24T07:00:00.000Z', '2026-09-25T07:00:00.000Z', '2026-09-26T07:00:00.000Z']);
  });
  it('never schedules in the past (D7)', () => {
    expect(
      plan(task({ dueAt: FRI_ALLDAY_MSK, dueAllDay: true }), '2026-09-24T12:00:00Z').map((x) => x[0]),
    ).toEqual(['due', 'overdue']);
  });
  it('uses the recipient zone for all-day dates', () => {
    const yekt: PlanRecipient = { userId: 10, zone: 'Asia/Yekaterinburg' };
    expect(
      plan(task({ dueAt: FRI_ALLDAY_MSK, dueAllDay: true }), '2026-09-23T03:00:00Z', [yekt]).map((x) => x[2]),
    ).toEqual(['2026-09-24T05:00:00.000Z', '2026-09-25T05:00:00.000Z', '2026-09-26T05:00:00.000Z']);
  });
  it('first overdue for an already overdue task is the next overdueTime after now', () => {
    expect(plan(task(), '2026-09-27T09:00:00Z')).toEqual([
      ['overdue', 10, '2026-09-28T07:00:00.000Z', 'task:1:v1:overdue:10:2026-09-28'],
    ]);
  });
  it('datetime overdue may fire the same day (D7, literal SPEC §13.2)', () => {
    const due0900 = new Date('2026-09-25T06:00:00Z');
    expect(plan(task({ dueAt: due0900 }), '2026-09-23T09:00:00Z').at(-1)?.[2]).toBe(
      '2026-09-25T07:00:00.000Z',
    );
  });
  it('handles DST in the recipient zone', () => {
    const berlin: PlanRecipient = { userId: 10, zone: 'Europe/Berlin' };
    const t = task({ dueAt: new Date('2026-10-25T22:59:00Z'), dueAllDay: true, dueTz: 'Europe/Berlin' });
    expect(plan(t, '2026-10-20T10:00:00Z', [berlin]).map((x) => x[2])).toEqual([
      '2026-10-24T08:00:00.000Z',
      '2026-10-25T09:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
    ]);
  });
  it('returns nothing without due or for closed tasks', () => {
    expect(plan(task({ dueAt: null }), '2026-09-23T09:00:00Z')).toEqual([]);
    expect(plan(task({ status: 'done' }), '2026-09-23T09:00:00Z')).toEqual([]);
    expect(plan(task({ status: 'cancelled' }), '2026-09-23T09:00:00Z')).toEqual([]);
  });
  it('reminds in_progress tasks the same way', () => {
    expect(plan(task({ status: 'in_progress' }), '2026-09-23T09:00:00Z')).toHaveLength(3);
  });
  it('embeds the task version in dedupe keys (D6) and honours custom times', () => {
    const r = plan(task({ version: 3 }), '2026-09-23T09:00:00Z', [owner], {
      ...reminders,
      preDueTime: '09:00',
    });
    expect(r[0]).toEqual(['pre_due', 10, '2026-09-24T06:00:00.000Z', 'task:1:v3:pre_due:10:2026-09-24']);
  });
});
