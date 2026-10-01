import { describe, it, expect } from 'vitest';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { callback, botKeyboardMessage, dmText } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { memberships, tasks } from '../../../src/db/schema/index.js';
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
      title: 'Задача',
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

describe('/stats', () => {
  it('is forbidden for a Member', async () => {
    const h = await createBotHarness();
    await makeMember(h, MEMBER);

    await h.send(dmText(MEMBER, '/stats'));

    expect(h.replies(MEMBER.id)).toEqual([texts.common.forbidden]);
  });

  it('defaults to a 30-day window and shows a row per assignee with tasks in it', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);
    const maria = await makeMember(h, { id: 300, firstName: 'Мария' });
    await insertTask(h, { title: 'Задача Марии', assigneeUserId: maria.id, status: 'open' });

    await h.send(dmText(OWNER, '/stats'));

    const [reply] = h.replies(OWNER.id);
    expect(reply).toContain('30 дней');
    expect(reply).toContain('Мария');
  });

  it('shows no rows (just the empty message) when nothing is in the cohort', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);

    await h.send(dmText(OWNER, '/stats'));

    const [reply] = h.replies(OWNER.id);
    expect(reply).toContain(texts.stats.empty);
  });

  it('switching the period via the [7] button recomputes the cohort', async () => {
    const h = await createBotHarness({ clock: '2026-09-25T10:00:00Z' });
    await makeOwner(h, OWNER);
    const maria = await makeMember(h, { id: 300, firstName: 'Мария' });

    // Inside a 30-day window but outside a 7-day one.
    await insertTask(h, {
      title: 'Старая задача',
      assigneeUserId: maria.id,
      status: 'open',
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });

    await h.send(dmText(OWNER, '/stats'));
    const [initial] = h.replies(OWNER.id);
    expect(initial).toContain('Мария');

    const sevenDayData = encodeCallback({ entity: 's', action: 'per', id: 0, arg: '7' });
    await h.send(callback(OWNER, sevenDayData, botKeyboardMessage(OWNER)));

    const edit = lastEditTo(h, OWNER.id);
    expect(edit.text).toContain('7 дней');
    expect(edit.text).toContain(texts.stats.empty);
  });

  it('is forbidden for a Member on the v1:s:per:* callback too', async () => {
    const h = await createBotHarness();
    await makeMember(h, MEMBER);

    const data = encodeCallback({ entity: 's', action: 'per', id: 0, arg: '7' });
    await h.send(callback(MEMBER, data, botKeyboardMessage(MEMBER)));

    expect(fake(h).edits).toHaveLength(0);
  });

  it('falls through v1:s:pg:* (search pagination) rather than handling it as a period switch', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);

    // No `/search` was ever run, so there is no query to recover from the fixture message's empty text —
    // this only asserts that `/stats`'s own `v1:s:per:*` handler does NOT swallow a `pg` action meant for
    // `src/bot/handlers/search.ts`, which registers after it and handles it instead.
    const data = encodeCallback({ entity: 's', action: 'pg', id: 2 });
    await h.send(callback(OWNER, data, botKeyboardMessage(OWNER)));

    const answers = h.calls.filter((c) => c.method === 'answerCallbackQuery');
    const last = answers[answers.length - 1];
    expect(last?.payload.text).toBe(texts.search.expired);
  });
});
