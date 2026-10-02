import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { callback, botKeyboardMessage } from '../../helpers/updates.js';
import { encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { memberships, tasks, taskEvents, notifications } from '../../../src/db/schema/index.js';
import type { TaskRow } from '../../../src/domain/tasks/repo.js';
import type { FakeMessenger } from '../../helpers/fakeMessenger.js';

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
      createdAt: harness.clock.now(),
      updatedAt: harness.clock.now(),
      version: 1,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('expected the task row to be inserted');
  return row;
}

async function insertNotification(harness: BotHarness, taskId: number, recipientUserId: number) {
  const [row] = await harness.db
    .insert(notifications)
    .values({
      workspaceId: harness.deps.workspace.id,
      taskId,
      recipientUserId,
      kind: 'due',
      fireAt: harness.clock.now(),
      status: 'scheduled',
      dedupeKey: `task:${String(taskId)}:v1:due:${String(recipientUserId)}:2026-10-01`,
      createdAt: harness.clock.now(),
    })
    .returning();
  if (!row) throw new Error('expected the notification row to be inserted');
  return row;
}

async function getTaskRow(harness: BotHarness, id: number): Promise<TaskRow | undefined> {
  const [row] = await harness.db.select().from(tasks).where(eq(tasks.id, id));
  return row;
}

function taskCallback(action: string, taskId: number, arg?: string): string {
  return encodeCallback({ entity: 't', action, id: taskId, ...(arg !== undefined ? { arg } : {}) });
}

describe('task card callbacks (v1:t:*)', () => {
  it('owner marking an open task done sets status, completedAt/completedBy and a status_changed event', async () => {
    const harness = await createBotHarness();
    const owner = await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness);

    await harness.send(callback(OWNER, taskCallback('don', task.id), botKeyboardMessage(OWNER)));

    const updated = await getTaskRow(harness, task.id);
    expect(updated?.status).toBe('done');
    expect(updated?.completedAt).not.toBeNull();
    expect(updated?.completedByUserId).toBe(owner.id);
    expect(updated?.version).toBe(2);

    const events = await harness.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(events.some((e) => e.type === 'status_changed')).toBe(true);

    const edit = lastEditTo(harness, OWNER.id);
    expect(edit.text).toContain('выполнена');
    expect(edit.buttons?.flat().some((b) => b.text === texts.taskCard.restoreButton)).toBe(true);
  });

  it('owner pressing "В работу" moves an open task to in_progress', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness);

    await harness.send(callback(OWNER, taskCallback('prg', task.id), botKeyboardMessage(OWNER)));

    const updated = await getTaskRow(harness, task.id);
    expect(updated?.status).toBe('in_progress');
  });

  it('owner cancelling an open task archives it, and restoring brings it back to open', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness);

    await harness.send(callback(OWNER, taskCallback('cnl', task.id), botKeyboardMessage(OWNER)));
    const cancelled = await getTaskRow(harness, task.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.cancelledAt).not.toBeNull();

    const cancelledEdit = lastEditTo(harness, OWNER.id);
    expect(cancelledEdit.buttons?.flat().some((b) => b.text === texts.taskCard.deleteForeverButton)).toBe(
      true,
    );

    await harness.send(callback(OWNER, taskCallback('rst', task.id), botKeyboardMessage(OWNER)));
    const restored = await getTaskRow(harness, task.id);
    expect(restored?.status).toBe('open');
  });

  it('delete forever requires two confirmations past the initial press, and cascades events/notifications', async () => {
    const harness = await createBotHarness();
    const owner = await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness, { status: 'cancelled' });
    await insertNotification(harness, task.id, owner.id);

    // The initial "🗑 Удалить навсегда" press only opens the first confirm screen — nothing is deleted yet.
    await harness.send(callback(OWNER, taskCallback('del', task.id), botKeyboardMessage(OWNER)));
    expect(await getTaskRow(harness, task.id)).toBeDefined();
    const confirm1 = lastEditTo(harness, OWNER.id);
    expect(confirm1.text).toContain(String(task.id));

    // First confirmation — still not deleted, now shows the second (final) confirm screen.
    await harness.send(callback(OWNER, taskCallback('dla', task.id), botKeyboardMessage(OWNER)));
    expect(await getTaskRow(harness, task.id)).toBeDefined();
    const confirm2 = lastEditTo(harness, OWNER.id);
    expect(confirm2.text).toBe(texts.taskCard.deleteConfirm2);

    // Second confirmation — now it's actually gone, along with its events and notifications (cascade).
    await harness.send(callback(OWNER, taskCallback('dlb', task.id), botKeyboardMessage(OWNER)));
    expect(await getTaskRow(harness, task.id)).toBeUndefined();

    const remainingEvents = await harness.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(remainingEvents).toHaveLength(0);
    const remainingNotifications = await harness.db
      .select()
      .from(notifications)
      .where(eq(notifications.taskId, task.id));
    expect(remainingNotifications).toHaveLength(0);

    const finalEdit = lastEditTo(harness, OWNER.id);
    expect(finalEdit.text).toContain('удалена навсегда');
    expect(finalEdit.buttons ?? []).toHaveLength(0);
  });

  it('"delete forever" on a task that is not archived is a no-op (redraws the live card instead)', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness);

    await harness.send(callback(OWNER, taskCallback('del', task.id), botKeyboardMessage(OWNER)));

    expect(await getTaskRow(harness, task.id)).toBeDefined();
    const edit = lastEditTo(harness, OWNER.id);
    expect(edit.text).not.toContain(texts.taskCard.deleteConfirm2);
  });

  it('pressing any button on an already-deleted task replies "not found" instead of throwing', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness);
    await harness.db.delete(tasks).where(eq(tasks.id, task.id));

    await expect(
      harness.send(callback(OWNER, taskCallback('don', task.id), botKeyboardMessage(OWNER))),
    ).resolves.not.toThrow();

    expect(lastAnswerText(harness)).toBe(texts.taskCard.notFound);
  });

  it('a member pressing a task-card button gets "forbidden" and the task is unchanged', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await makeMember(harness, MEMBER);
    const task = await insertOpenTask(harness);

    await harness.send(callback(MEMBER, taskCallback('don', task.id), botKeyboardMessage(MEMBER)));

    expect(lastAnswerText(harness)).toBe(texts.common.forbidden);
    const unchanged = await getTaskRow(harness, task.id);
    expect(unchanged?.status).toBe('open');
  });

  it('"История" shows the task\'s events with a back button, newest first', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness);
    await harness.send(callback(OWNER, taskCallback('don', task.id), botKeyboardMessage(OWNER)));

    await harness.send(callback(OWNER, taskCallback('his', task.id), botKeyboardMessage(OWNER)));

    const edit = lastEditTo(harness, OWNER.id);
    expect(edit.text).toContain('История задачи');
    expect(edit.buttons?.flat().some((b) => b.text === texts.taskCard.backButton)).toBe(true);

    await harness.send(callback(OWNER, taskCallback('bck', task.id), botKeyboardMessage(OWNER)));
    const backEdit = lastEditTo(harness, OWNER.id);
    expect(backEdit.buttons?.flat().some((b) => b.text === texts.taskCard.restoreButton)).toBe(true);
  });
});
