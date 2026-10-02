import { describe, it, expect, vi } from 'vitest';
import { resolveActions, defaultAssignee, type ResolveContext } from '../../../src/ai/pipeline/resolve.js';
import type { RefMaps } from '../../../src/ai/pipeline/buildInput.js';
import type { ActionT, ExtractionResultT } from '../../../src/ai/schemas.js';

type CreateAction = Extract<ActionT, { type: 'create' }>;
type UpdateAction = Extract<ActionT, { type: 'update' }>;
type CompleteOrCancelAction = Extract<ActionT, { type: 'complete' | 'cancel' }>;

const NOW = new Date('2026-09-23T09:00:00.000Z'); // 2026-09-23T12:00+03:00, Europe/Moscow
const WORKSPACE_TZ = 'Europe/Moscow';

const fuzzy = {
  morning: '10:00',
  afternoon: '15:00',
  evening: '19:00',
  endOfWeekDay: 5,
  endOfWeekTime: '18:00',
  soonWorkdays: 2,
  defaultTime: '18:00',
};

// P1 = userId 111 (authors M1, tz Yekaterinburg, no reply target).
// P2 = userId 222 (authors M2, no tz set → falls back to workspace tz), M2 replies to M1 (authored by P1/111).
const refs: RefMaps = {
  messages: new Map([
    ['M1', 501],
    ['M2', 502],
  ]),
  participants: new Map([
    ['P1', 111],
    ['P2', 222],
  ]),
  tasks: new Map([['T12', 12]]),
  proposals: new Map([['R5', 5]]),
};

const messages: ResolveContext['messages'] = new Map([
  [501, { authorUserId: 111, authorTz: 'Asia/Yekaterinburg', replyToAuthorUserId: null }],
  [502, { authorUserId: 222, authorTz: null, replyToAuthorUserId: 111 }],
]);

const OWNER_USER_ID = 999;

// D47 (plan.md Task 3.15): T12's current assignee is P1 (userId 111) — most
// pre-existing tests below don't touch `changes.assignee`, so this entry is
// inert for them (the D47 conversion only fires when `changes.assignee` is
// itself present and resolves to a *different* specific person).
const targetTasks: ResolveContext['targetTasks'] = new Map([
  [12, { title: 'Исходное название задачи', assignee: { type: 'user', userId: 111 } }],
]);

const ctx: ResolveContext = {
  refs,
  messages,
  ownerUserId: OWNER_USER_ID,
  workspaceTz: WORKSPACE_TZ,
  now: NOW,
  fuzzy,
  targetTasks,
};

const NO_DUE = { due_local: null, time_hint: 'none' as const, due_text: null };

function createAction(over: Partial<CreateAction> = {}): CreateAction {
  return {
    type: 'create',
    category: 'assignment',
    title: 'Prepare the schedule',
    description: null,
    assignee_ref: null,
    assignee_name_text: null,
    due: NO_DUE,
    priority: 'normal',
    target_ref: null,
    source_message_ids: ['M1'],
    confidence: 0.8,
    reasoning: 'test',
    ...over,
  };
}

function updateAction(over: Partial<UpdateAction> = {}): UpdateAction {
  return {
    type: 'update',
    target_ref: 'T12',
    changes: {},
    source_message_ids: ['M1'],
    confidence: 0.8,
    reasoning: 'test',
    ...over,
  };
}

function completeAction(over: Partial<CompleteOrCancelAction> = {}): CompleteOrCancelAction {
  return {
    type: 'complete',
    target_ref: 'T12',
    source_message_ids: ['M1'],
    confidence: 0.8,
    reasoning: 'test',
    ...over,
  };
}

function extraction(actions: ActionT[]): ExtractionResultT {
  return { actions };
}

describe('resolveActions — message refs (SPEC §9.5)', () => {
  it('drops an unknown message ref but keeps the action when another ref is known', () => {
    const result = extraction([createAction({ source_message_ids: ['M1', 'M9'] })]);
    const { actions, dropped } = resolveActions(result, ctx);
    expect(dropped).toEqual([]);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.sourceMessageIds).toEqual([501]);
  });

  it('drops the whole action when every message ref is unknown', () => {
    const result = extraction([createAction({ source_message_ids: ['M9'] })]);
    const { actions, dropped } = resolveActions(result, ctx);
    expect(actions).toEqual([]);
    expect(dropped).toEqual([{ index: 0, reason: 'unknown_message_refs' }]);
  });

  it('keeps original array indices in dropped when earlier actions survive', () => {
    const result = extraction([
      createAction({ source_message_ids: ['M1'] }),
      createAction({ source_message_ids: ['M9'] }),
    ]);
    const { actions, dropped } = resolveActions(result, ctx);
    expect(actions).toHaveLength(1);
    expect(dropped).toEqual([{ index: 1, reason: 'unknown_message_refs' }]);
  });
});

describe('resolveActions — target refs (SPEC §9.5)', () => {
  it('drops update/complete/cancel actions with an unknown target', () => {
    const result = extraction([completeAction({ target_ref: 'T99' })]);
    const { actions, dropped } = resolveActions(result, ctx);
    expect(actions).toEqual([]);
    expect(dropped).toEqual([{ index: 0, reason: 'unknown_target' }]);
  });

  it('resolves a known T# target ref to a taskId', () => {
    const result = extraction([completeAction({ target_ref: 'T12' })]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({ kind: 'complete', target: { taskId: 12 } });
  });

  it('resolves a known R# target ref to a proposalId', () => {
    const result = extraction([completeAction({ type: 'cancel', target_ref: 'R5' })]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({ kind: 'cancel', target: { proposalId: 5 } });
  });
});

describe('resolveActions — assignee refs (SPEC §9.5-9.6)', () => {
  it('falls back to the default assignee and warns when assignee_ref is unknown', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = extraction([
      createAction({ category: 'commitment', assignee_ref: 'P7', source_message_ids: ['M1'] }),
    ]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({ assignee: { type: 'user', userId: 111 } });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('resolves OWNER to the workspace owner', () => {
    const result = extraction([createAction({ assignee_ref: 'OWNER' })]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({ assignee: { type: 'user', userId: OWNER_USER_ID } });
  });

  it('resolves ALL to the all-assignee marker', () => {
    const result = extraction([createAction({ assignee_ref: 'ALL' })]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({ assignee: { type: 'all' } });
  });

  it('resolves a null assignee_ref with free-text name to a text assignee', () => {
    const result = extraction([createAction({ assignee_ref: null, assignee_name_text: 'Olga' })]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({ assignee: { type: 'text', name: 'Olga' } });
  });

  it('resolves a known P# assignee_ref to that participant', () => {
    const result = extraction([createAction({ assignee_ref: 'P2' })]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({ assignee: { type: 'user', userId: 222 } });
  });
});

describe('defaultAssignee (SPEC §9.6)', () => {
  const base = { authorUserId: 111, replyToAuthorUserId: null, ownerUserId: OWNER_USER_ID };

  it('commitment → the author of the first source message', () => {
    expect(defaultAssignee('commitment', base)).toEqual({ type: 'user', userId: 111 });
  });

  it('request_to_owner → owner', () => {
    expect(defaultAssignee('request_to_owner', base)).toEqual({ type: 'user', userId: OWNER_USER_ID });
  });

  it('owner_intent → owner', () => {
    expect(defaultAssignee('owner_intent', base)).toEqual({ type: 'user', userId: OWNER_USER_ID });
  });

  it('assignment in reply to a person → that person', () => {
    expect(defaultAssignee('assignment', { ...base, replyToAuthorUserId: 222 })).toEqual({
      type: 'user',
      userId: 222,
    });
  });

  it('assignment without a reply → none', () => {
    expect(defaultAssignee('assignment', base)).toEqual({ type: 'none' });
  });

  it('event → none', () => {
    expect(defaultAssignee('event', base)).toEqual({ type: 'none' });
  });

  it('resolveActions applies the reply-based default end-to-end for a bare assignment', () => {
    const result = extraction([
      createAction({ category: 'assignment', assignee_ref: null, source_message_ids: ['M2'] }),
    ]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({ assignee: { type: 'user', userId: 111 } });
  });
});

describe('resolveActions — due dates (SPEC §10)', () => {
  it('resolves create.due in the first source message author timezone', () => {
    const result = extraction([
      createAction({
        due: { due_local: '2026-09-25T18:00', time_hint: 'none', due_text: null },
        source_message_ids: ['M1'],
      }),
    ]);
    const { actions } = resolveActions(result, ctx);
    const action = actions[0];
    expect(action?.kind).toBe('create');
    if (action?.kind === 'create') {
      expect(action.due.dueAt?.toISOString()).toBe('2026-09-25T13:00:00.000Z'); // 18:00 in UTC+5
      expect(action.due.tz).toBe('Asia/Yekaterinburg');
    }
  });

  it('falls back to the workspace timezone when the author has none set', () => {
    const result = extraction([
      createAction({
        due: { due_local: '2026-09-25T18:00', time_hint: 'none', due_text: null },
        source_message_ids: ['M2'],
      }),
    ]);
    const { actions } = resolveActions(result, ctx);
    const action = actions[0];
    if (action?.kind === 'create') expect(action.due.tz).toBe('Europe/Moscow');
  });

  it('resolves update.changes.due through resolveDue', () => {
    const result = extraction([
      updateAction({
        changes: { due: { due_local: '2026-09-25T18:00', time_hint: 'none', due_text: null } },
        source_message_ids: ['M1'],
      }),
    ]);
    const { actions } = resolveActions(result, ctx);
    const action = actions[0];
    expect(action?.kind).toBe('update');
    if (action?.kind === 'update') {
      expect(action.changes.due?.dueAt?.toISOString()).toBe('2026-09-25T13:00:00.000Z');
    }
  });

  it('leaves update.changes.due absent when not provided', () => {
    const result = extraction([updateAction({ changes: {} })]);
    const { actions } = resolveActions(result, ctx);
    const action = actions[0];
    if (action?.kind === 'update') expect(action.changes.due).toBeUndefined();
  });
});

describe('resolveActions — D47 new-instruction-vs-update split (plan.md Task 3.15)', () => {
  it('splits into a new create when the target has a specific assignee and changes.assignee names someone else', () => {
    const result = extraction([
      updateAction({
        changes: { assignee_ref: 'P2' },
        explicit_transfer: false,
        new_task_title: null,
      }),
    ]);
    const { actions } = resolveActions(result, ctx);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'create',
      category: 'assignment',
      title: 'Исходное название задачи',
      description: null,
      assignee: { type: 'user', userId: 222 },
      priority: 'normal',
    });
    if (actions[0]?.kind === 'create') {
      expect(actions[0].due.dueAt).toBeNull();
      expect('target' in actions[0]).toBe(false);
    }
  });

  it('uses new_task_title as the synthesized create title when the model provided one', () => {
    const result = extraction([
      updateAction({
        changes: { assignee_ref: 'P2' },
        explicit_transfer: false,
        new_task_title: 'Подготовить отчёт',
      }),
    ]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({ kind: 'create', title: 'Подготовить отчёт' });
  });

  it('uses changes.due for the synthesized create when the model provided one', () => {
    const result = extraction([
      updateAction({
        changes: {
          assignee_ref: 'P2',
          due: { due_local: '2026-09-25T18:00', time_hint: 'none', due_text: null },
        },
        explicit_transfer: false,
      }),
    ]);
    const { actions } = resolveActions(result, ctx);
    const action = actions[0];
    expect(action?.kind).toBe('create');
    if (action?.kind === 'create') {
      expect(action.due.dueAt?.toISOString()).toBe('2026-09-25T13:00:00.000Z');
    }
  });

  it('stays an update (with the assignee change applied) when explicit_transfer is true', () => {
    const result = extraction([
      updateAction({
        changes: { assignee_ref: 'P2' },
        explicit_transfer: true,
        new_task_title: 'Подготовить отчёт',
      }),
    ]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({
      kind: 'update',
      target: { taskId: 12 },
      changes: { assignee: { type: 'user', userId: 222 } },
    });
  });

  it('stays an update and threads new_task_title through when there is no assignee change', () => {
    const result = extraction([
      updateAction({
        changes: { due: { due_local: '2026-09-25T18:00', time_hint: 'none', due_text: null } },
        explicit_transfer: false,
        new_task_title: 'Подготовить отчёт',
      }),
    ]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({ kind: 'update', newTaskTitle: 'Подготовить отчёт' });
  });

  it('stays an update when the new assignee resolves to the same person as the target', () => {
    const result = extraction([updateAction({ changes: { assignee_ref: 'P1' }, explicit_transfer: false })]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({
      kind: 'update',
      changes: { assignee: { type: 'user', userId: 111 } },
    });
  });

  it('stays an update when the target has no specific assignee (all/none)', () => {
    const noneCtx: ResolveContext = {
      ...ctx,
      targetTasks: new Map([[12, { title: 'Исходное название задачи', assignee: { type: 'none' } }]]),
    };
    const result = extraction([updateAction({ changes: { assignee_ref: 'P2' }, explicit_transfer: false })]);
    const { actions } = resolveActions(result, noneCtx);
    expect(actions[0]).toMatchObject({
      kind: 'update',
      changes: { assignee: { type: 'user', userId: 222 } },
    });
  });

  it('splits when the target assignee is a free-text name and the new assignee is a different specific person', () => {
    const textCtx: ResolveContext = {
      ...ctx,
      targetTasks: new Map([[12, { title: 'Сделать отчёт', assignee: { type: 'text', name: 'Маша' } }]]),
    };
    const result = extraction([updateAction({ changes: { assignee_ref: 'P2' }, explicit_transfer: false })]);
    const { actions } = resolveActions(result, textCtx);
    expect(actions[0]).toMatchObject({
      kind: 'create',
      title: 'Сделать отчёт',
      assignee: { type: 'user', userId: 222 },
    });
  });

  it('does not split when the target proposal (R#) is the target, even with a different changes.assignee', () => {
    const result = extraction([
      updateAction({ target_ref: 'R5', changes: { assignee_ref: 'P2' }, explicit_transfer: false }),
    ]);
    const { actions } = resolveActions(result, ctx);
    expect(actions[0]).toMatchObject({ kind: 'update', target: { proposalId: 5 } });
  });

  it('stays an update (defensive) when the target task has no entry in ctx.targetTasks', () => {
    const emptyCtx: ResolveContext = { ...ctx, targetTasks: new Map() };
    const result = extraction([updateAction({ changes: { assignee_ref: 'P2' }, explicit_transfer: false })]);
    const { actions } = resolveActions(result, emptyCtx);
    expect(actions[0]).toMatchObject({ kind: 'update' });
  });
});
