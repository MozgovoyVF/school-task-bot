import { describe, it, expect } from 'vitest';
import { can, type Actor, type Action } from '../../../src/domain/people/permissions.js';

const superadmin: Actor = { userId: 1, isSuperadmin: true, role: null, dmStarted: true };
const owner: Actor = { userId: 2, isSuperadmin: false, role: 'owner', dmStarted: true };
const memberDm: Actor = { userId: 3, isSuperadmin: false, role: 'member', dmStarted: true };
const memberNoDm: Actor = { userId: 4, isSuperadmin: false, role: 'member', dmStarted: false };

const rows: Array<[Action, boolean, boolean, boolean, boolean]> = [
  // action,               superadmin, owner, memberDm, memberNoDm
  ['proposal.receive', false, true, false, false],
  ['proposal.decide', false, true, false, false],
  ['task.createDm', false, true, false, false],
  ['task.viewAll', false, true, false, false],
  ['task.edit', false, true, false, false],
  ['chat.approve', true, true, false, false],
  ['admin.tech', true, false, false, false],
  ['transfer.generate', true, true, false, false],
];

describe('permission matrix (SPEC §3)', () => {
  it.each(rows)('%s', (action, sa, ow, md, mn) => {
    expect([
      can(superadmin, action),
      can(owner, action),
      can(memberDm, action),
      can(memberNoDm, action),
    ]).toEqual([sa, ow, md, mn]);
  });
  it('members act only on their own tasks and only after starting DM', () => {
    expect(can(memberDm, 'task.viewOwn', { assigneeUserId: 3 })).toBe(true);
    expect(can(memberDm, 'task.startOwn', { assigneeUserId: 3 })).toBe(true);
    expect(can(memberDm, 'task.doneOwn', { assigneeUserId: 3 })).toBe(true);
    expect(can(memberDm, 'task.doneOwn', { assigneeUserId: 99 })).toBe(false);
    expect(can(memberNoDm, 'task.viewOwn', { assigneeUserId: 4 })).toBe(false);
    expect(can(memberDm, 'reminders.receive', { assigneeUserId: 3 })).toBe(true);
    expect(can(owner, 'task.doneOwn', { assigneeUserId: 99 })).toBe(true);
  });
  it('superadmin who is also owner gets both sets', () => {
    const both: Actor = { ...owner, isSuperadmin: true };
    expect(can(both, 'admin.tech')).toBe(true);
    expect(can(both, 'proposal.decide')).toBe(true);
  });
});
