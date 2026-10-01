import { describe, it, expect } from 'vitest';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { callback, botKeyboardMessage, dmText } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { chats, memberships, tasks } from '../../../src/db/schema/index.js';
import type { NewTaskRow, TaskRow } from '../../../src/domain/tasks/repo.js';
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

async function insertTask(harness: BotHarness, overrides: Partial<NewTaskRow> = {}): Promise<TaskRow> {
  const [row] = await harness.db
    .insert(tasks)
    .values({
      workspaceId: harness.deps.workspace.id,
      title: 'Подготовить расписание',
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

function listCallback(action: string, page: number, arg?: string): string {
  return encodeCallback({ entity: 'l', action, id: page, ...(arg !== undefined ? { arg } : {}) });
}

describe('/tasks, /today, /overdue, /archive', () => {
  it('is forbidden for a Member', async () => {
    const harness = await createBotHarness();
    await makeMember(harness, MEMBER);

    await harness.send(dmText(MEMBER, '/tasks'));

    expect(harness.replies(MEMBER.id)).toEqual([texts.common.forbidden]);
  });

  it("/today shows both today's and overdue tasks, but not a later one", async () => {
    const h = await createBotHarness({ clock: '2026-09-25T10:00:00Z' }); // 13:00 MSK
    await makeOwner(h, OWNER);

    const overdue = await insertTask(h, { title: 'Просроченная', dueAt: new Date('2026-09-25T09:00:00Z') });
    const today = await insertTask(h, { title: 'Сегодняшняя', dueAt: new Date('2026-09-25T15:00:00Z') });
    const later = await insertTask(h, { title: 'Позже', dueAt: new Date('2026-10-01T10:00:00Z') });

    await h.send(dmText(OWNER, '/today'));

    const [reply] = h.replies(OWNER.id);
    expect(reply).toContain(`T${String(overdue.id)}`);
    expect(reply).toContain(`T${String(today.id)}`);
    expect(reply).not.toContain(`T${String(later.id)}`);
  });

  it('/overdue only shows overdue tasks', async () => {
    const h = await createBotHarness({ clock: '2026-09-25T10:00:00Z' });
    await makeOwner(h, OWNER);

    const overdue = await insertTask(h, { title: 'Просроченная', dueAt: new Date('2026-09-25T09:00:00Z') });
    const today = await insertTask(h, { title: 'Сегодняшняя', dueAt: new Date('2026-09-25T15:00:00Z') });

    await h.send(dmText(OWNER, '/overdue'));

    const [reply] = h.replies(OWNER.id);
    expect(reply).toContain(`T${String(overdue.id)}`);
    expect(reply).not.toContain(`T${String(today.id)}`);
  });

  it('/archive shows done/cancelled tasks, not open ones', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);
    const done = await insertTask(h, { status: 'done', completedAt: h.clock.now() });
    const open = await insertTask(h, { status: 'open' });

    await h.send(dmText(OWNER, '/archive'));

    const [reply] = h.replies(OWNER.id);
    expect(reply).toContain(`T${String(done.id)}`);
    expect(reply).not.toContain(`T${String(open.id)}`);
  });
});

describe('v1:l:* callbacks', () => {
  it('the morning summary\'s pre-existing "📋 Все задачи" button (v1:l:all:0) now opens the open-tasks list', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);
    await insertTask(h, { title: 'Открытая задача' });

    await h.send(callback(OWNER, listCallback('all', 0), botKeyboardMessage(OWNER)));

    const edit = lastEditTo(h, OWNER.id);
    expect(edit.text).toContain(texts.taskList.headerOpen);
  });

  it('is forbidden for a Member', async () => {
    const h = await createBotHarness();
    await makeMember(h, MEMBER);

    await h.send(callback(MEMBER, listCallback('all', 0), botKeyboardMessage(MEMBER)));

    expect(fake(h).edits).toHaveLength(0);
  });

  it("tapping a row's own button opens that task's card", async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);
    const task = await insertTask(h, { title: 'Задача для карточки' });

    await h.send(callback(OWNER, listCallback('all', 0), botKeyboardMessage(OWNER)));
    await h.send(
      callback(OWNER, encodeCallback({ entity: 'l', action: 'opn', id: task.id }), botKeyboardMessage(OWNER)),
    );

    const edit = lastEditTo(h, OWNER.id);
    expect(edit.text).toContain(`T${String(task.id)}`);
    expect(edit.buttons?.flat().some((b) => b.text === texts.taskCard.doneButton)).toBe(true);
  });

  it('"По исполнителю ▾" opens a picker, and picking a member applies the assignee filter', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);
    const maria = await makeMember(h, { id: 300, firstName: 'Мария' });
    const hers = await insertTask(h, { title: 'Задача Марии', assigneeUserId: maria.id });
    await insertTask(h, { title: 'Чужая задача' });

    await h.send(
      callback(OWNER, encodeCallback({ entity: 'l', action: 'asm', id: 1 }), botKeyboardMessage(OWNER)),
    );
    const menuEdit = lastEditTo(h, OWNER.id);
    expect(menuEdit.text).toBe(texts.taskList.assigneeMenuHeader);
    const pickButton = menuEdit.buttons?.flat().find((b) => b.text === 'Мария');
    expect(pickButton?.data).toBeDefined();

    await h.send(callback(OWNER, pickButton!.data!, botKeyboardMessage(OWNER)));
    const filtered = lastEditTo(h, OWNER.id);
    expect(filtered.text).toContain(`T${String(hers.id)}`);
    expect(filtered.text).not.toContain('Чужая задача');
  });

  it('"По чату ▾" opens a picker, and picking a chat applies the chat filter', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);
    const [chatRow] = await h.db
      .insert(chats)
      .values({
        tgChatId: -1001,
        workspaceId: h.deps.workspace.id,
        title: 'Учительская',
        type: 'supergroup',
        status: 'active',
      })
      .returning();
    if (!chatRow) throw new Error('expected the chat row to be inserted');
    const fromChat = await insertTask(h, { title: 'Задача из чата', sourceChatId: chatRow.id });
    await insertTask(h, { title: 'Другая задача' });

    await h.send(
      callback(OWNER, encodeCallback({ entity: 'l', action: 'csm', id: 1 }), botKeyboardMessage(OWNER)),
    );
    const menuEdit = lastEditTo(h, OWNER.id);
    expect(menuEdit.text).toBe(texts.taskList.chatMenuHeader);
    const pickButton = menuEdit.buttons?.flat().find((b) => b.text === 'Учительская');
    expect(pickButton?.data).toBeDefined();

    await h.send(callback(OWNER, pickButton!.data!, botKeyboardMessage(OWNER)));
    const filtered = lastEditTo(h, OWNER.id);
    expect(filtered.text).toContain(`T${String(fromChat.id)}`);
    expect(filtered.text).not.toContain('Другая задача');
  });
});
