import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, callback, botKeyboardMessage } from '../../helpers/updates.js';
import { encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { formatDue } from '../../../src/time/format.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { memberships, tasks, taskEvents, notifications } from '../../../src/db/schema/index.js';
import type { TaskRow } from '../../../src/domain/tasks/repo.js';
import { FixtureClient } from '../../../src/ai/providers/fixture.js';
import type { AiProviders, CompletionResponse } from '../../../src/ai/providers/types.js';
import type { FakeMessenger } from '../../helpers/fakeMessenger.js';

// plan.md Task 3.4: the reminder DM's own `v1:n:*` buttons (`src/bot/handlers/reminderCallbacks.ts`,
// `src/bot/conversations/snoozeInput.ts`) end to end — `done`/`hour`/`pick`/the picker submenu's fixed and
// free-text options, and D40's own owner-only enforcement (SPEC §13.3, `can(actor, 'reminders.receive')`).

const OWNER = { id: 100, firstName: 'Anna' };
const MEMBER = { id: 200, firstName: 'Boris' };

function fake(harness: BotHarness): FakeMessenger {
  return harness.deps.messenger as FakeMessenger;
}

function lastEditTo(harness: BotHarness, chatId: number) {
  const edits = fake(harness).edits.filter((e) => e.chatId === chatId);
  const last = edits[edits.length - 1];
  if (!last) throw new Error(`no edit sent to ${String(chatId)}`);
  return last;
}

function lastAnswerText(harness: BotHarness): string | undefined {
  const calls = harness.calls.filter((c) => c.method === 'answerCallbackQuery');
  const last = calls[calls.length - 1];
  return typeof last?.payload.text === 'string' ? last.payload.text : undefined;
}

async function makeOwner(harness: BotHarness, tgUser: { id: number; firstName: string }) {
  const userRow = await upsertTelegramUser(harness.db, { id: tgUser.id, first_name: tgUser.firstName });
  await harness.db.insert(memberships).values({
    workspaceId: harness.deps.workspace.id,
    userId: userRow.id,
    role: 'owner',
    displayName: tgUser.firstName,
  });
  return userRow;
}

async function makeMember(harness: BotHarness, tgUser: { id: number; firstName: string }) {
  const userRow = await upsertTelegramUser(harness.db, { id: tgUser.id, first_name: tgUser.firstName });
  await harness.db.insert(memberships).values({
    workspaceId: harness.deps.workspace.id,
    userId: userRow.id,
    role: 'member',
    displayName: tgUser.firstName,
  });
  return userRow;
}

async function insertOpenTask(harness: BotHarness, overrides: Partial<TaskRow> = {}): Promise<TaskRow> {
  const [row] = await harness.db
    .insert(tasks)
    .values({
      workspaceId: harness.deps.workspace.id,
      title: 'Подготовить расписание на октябрь',
      origin: 'manual_dm',
      status: 'open',
      dueAt: new Date('2026-10-01T10:00:00+03:00'),
      dueAllDay: false,
      dueTz: 'Europe/Moscow',
      createdAt: harness.clock.now(),
      updatedAt: harness.clock.now(),
      version: 1,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('expected the task row to be inserted');
  return row;
}

async function getTaskRow(harness: BotHarness, id: number): Promise<TaskRow | undefined> {
  const [row] = await harness.db.select().from(tasks).where(eq(tasks.id, id));
  return row;
}

async function getSnoozeRows(harness: BotHarness, taskId: number) {
  return harness.db.select().from(notifications).where(eq(notifications.taskId, taskId));
}

function n(action: string, taskId: number, arg?: string): string {
  return encodeCallback(
    arg === undefined ? { entity: 'n', action, id: taskId } : { entity: 'n', action, id: taskId, arg },
  );
}

function response(content: string): CompletionResponse {
  return {
    content,
    usage: { inputTokens: 8, outputTokens: 4, costUsd: 0.0001 },
    model: 'fixture/primary',
    raw: {},
  };
}

function fixtureAi(script: ReadonlyArray<CompletionResponse | Error>): AiProviders {
  return {
    extraction: {
      extract() {
        throw new Error('extraction should not be used by the snoozeInput dialog');
      },
    },
    decision: null,
    client: new FixtureClient(script),
    models: { primary: 'fixture/primary', fallback: null },
  };
}

describe('reminder DM callbacks (v1:n:*, plan.md Task 3.4)', () => {
  it('"⏰ +1 час" from the owner creates a snooze notification and leaves the task\'s own due date unchanged', async () => {
    const harness = await createBotHarness();
    const owner = await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness);
    const originalDueAt = task.dueAt;

    await harness.send(callback(OWNER, n('hour', task.id), botKeyboardMessage(OWNER)));

    const expectedFireAt = new Date('2026-09-23T13:00:00+03:00');
    const rows = await getSnoozeRows(harness, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('snooze');
    expect(rows[0]?.status).toBe('scheduled');
    expect(rows[0]?.recipientUserId).toBe(owner.id);
    expect(rows[0]?.fireAt.toISOString()).toBe(expectedFireAt.toISOString());

    const unchanged = await getTaskRow(harness, task.id);
    expect(unchanged?.dueAt?.toISOString()).toBe(originalDueAt?.toISOString());
    expect(unchanged?.status).toBe('open');

    const expectedLabel = texts.formatDue(
      formatDue({ at: expectedFireAt, allDay: false, tz: null }, 'Europe/Moscow'),
    );
    const edit = lastEditTo(harness, OWNER.id);
    expect(edit.text).toBe(texts.reminders.snoozeConfirm(expectedLabel));
  });

  it('"🕐 Выбрать время" opens the picker submenu, and its own fixed options (e.g. "Через 3 ч") create a snooze', async () => {
    const harness = await createBotHarness();
    const owner = await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness);

    await harness.send(callback(OWNER, n('pick', task.id), botKeyboardMessage(OWNER)));

    const menuEdit = lastEditTo(harness, OWNER.id);
    expect(menuEdit.text).toBe(texts.reminders.pickMenuTitle);
    const labels = (menuEdit.buttons ?? []).flat().map((b) => b.text);
    expect(labels).toEqual([
      texts.reminders.pick3hButton,
      texts.reminders.pickToday18Button,
      texts.reminders.pickDayAfterButton,
      texts.reminders.pickEnterButton,
    ]);

    await harness.send(callback(OWNER, n('snz', task.id, '3h'), botKeyboardMessage(OWNER)));

    const rows = await getSnoozeRows(harness, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('snooze');
    expect(rows[0]?.recipientUserId).toBe(owner.id);
    expect(rows[0]?.fireAt.toISOString()).toBe(new Date('2026-09-23T15:00:00+03:00').toISOString());
  });

  it('the picker submenu\'s "Ввести…" button runs parseDateText, previews the result and creates a snooze on confirm', async () => {
    const dueLocal = '2026-09-24T09:00';
    const ai = fixtureAi([
      response(JSON.stringify({ due_local: dueLocal, time_hint: 'none', due_text: 'завтра в 9' })),
    ]);
    const harness = await createBotHarness({ ai });
    const owner = await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness);

    await harness.send(callback(OWNER, n('inp', task.id), botKeyboardMessage(OWNER)));
    expect(harness.replies(OWNER.id).at(-1)).toBe(texts.reminders.snoozeEnterPrompt);

    await harness.send(dmText(OWNER, 'завтра в 9'));
    const expectedFireAt = new Date('2026-09-24T09:00:00+03:00');
    const expectedLabel = texts.formatDue(
      formatDue({ at: expectedFireAt, allDay: false, tz: null }, 'Europe/Moscow'),
    );
    expect(harness.replies(OWNER.id).at(-1)).toBe(texts.editProposal.duePreview(expectedLabel));

    await harness.send(callback(OWNER, n('sok', task.id), botKeyboardMessage(OWNER)));

    const rows = await getSnoozeRows(harness, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipientUserId).toBe(owner.id);
    expect(rows[0]?.fireAt.toISOString()).toBe(expectedFireAt.toISOString());
    expect(harness.replies(OWNER.id).at(-1)).toBe(texts.reminders.snoozeConfirm(expectedLabel));
  });

  it('"✅ Готово" from the owner marks the task done', async () => {
    const harness = await createBotHarness();
    const owner = await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness);

    await harness.send(callback(OWNER, n('done', task.id), botKeyboardMessage(OWNER)));

    const updated = await getTaskRow(harness, task.id);
    expect(updated?.status).toBe('done');
    expect(updated?.completedByUserId).toBe(owner.id);
    expect(updated?.version).toBe(2);

    const events = await harness.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(events.some((e) => e.type === 'status_changed')).toBe(true);

    const edit = lastEditTo(harness, OWNER.id);
    expect(edit.text).toBe(texts.reminders.doneConfirm(task.id, task.title));
  });

  it('a non-owner (forged or forwarded callback) pressing any reminder button is forbidden and nothing is mutated', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await makeMember(harness, MEMBER);
    const task = await insertOpenTask(harness);

    await harness.send(callback(MEMBER, n('done', task.id), botKeyboardMessage(MEMBER)));

    expect(lastAnswerText(harness)).toBe(texts.common.forbidden);
    expect(fake(harness).edits).toHaveLength(0);
    const unchanged = await getTaskRow(harness, task.id);
    expect(unchanged?.status).toBe('open');
    const rows = await getSnoozeRows(harness, task.id);
    expect(rows).toHaveLength(0);

    // Also covers the snooze-button path specifically (SPEC §13.3's own buttons, not just "done").
    await harness.send(callback(MEMBER, n('hour', task.id), botKeyboardMessage(MEMBER)));
    expect(lastAnswerText(harness)).toBe(texts.common.forbidden);
    expect(await getSnoozeRows(harness, task.id)).toHaveLength(0);
  });
});
