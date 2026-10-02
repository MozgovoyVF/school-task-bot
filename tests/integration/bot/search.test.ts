import { describe, it, expect } from 'vitest';
import type { Message } from 'grammy/types';
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

function lastAnswerText(harness: BotHarness): string | undefined {
  const calls = harness.calls.filter((c) => c.method === 'answerCallbackQuery');
  const last = calls[calls.length - 1];
  return typeof last?.payload.text === 'string' ? last.payload.text : undefined;
}

/** A synthetic "this is the message the search result keyboard is attached to" fixture, carrying the
 * exact `text` the search handler rendered — `v1:s:pg:*`'s own callback handler parses the query back out
 * of this (`src/bot/handlers/search.ts`'s `extractQuery`), so the fixture's `text` is what makes the
 * pagination test meaningful (unlike `botKeyboardMessage`'s empty-text stand-in, used elsewhere only to
 * carry a valid `chat`/`message_id`). */
function searchResultMessage(chatId: number, text: string): Message {
  return {
    message_id: 777,
    date: 1_700_000_000,
    chat: { id: chatId, type: 'private', first_name: 'Anna' },
    text,
  };
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

describe('/search', () => {
  it('is forbidden for a Member', async () => {
    const h = await createBotHarness();
    await makeMember(h, MEMBER);

    await h.send(dmText(MEMBER, '/search расписание'));

    expect(h.replies(MEMBER.id)).toEqual([texts.common.forbidden]);
  });

  it('with no query shows the usage hint', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);

    await h.send(dmText(OWNER, '/search'));

    expect(h.replies(OWNER.id)).toEqual([texts.search.usage]);
  });

  it('finds a matching task and not an unrelated one', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);
    const match = await insertTask(h, { title: 'Подготовить расписание' });
    await insertTask(h, { title: 'Купить мел' });

    await h.send(dmText(OWNER, '/search расписан'));

    const [reply] = h.replies(OWNER.id);
    expect(reply).toContain(`T${String(match.id)}`);
    expect(reply).not.toContain('Купить мел');
  });

  it('reports nothing found', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);

    await h.send(dmText(OWNER, '/search нигденет'));

    const [reply] = h.replies(OWNER.id);
    expect(reply).toContain(texts.search.empty);
  });

  it('"▶️" pagination recovers the query from the message it is attached to and shows page 2', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);
    const titles: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const title = `Расписание ${String(i)}`;
      titles.push(title);
      await insertTask(h, { title });
    }

    await h.send(dmText(OWNER, '/search расписание'));
    const [page1Text] = h.replies(OWNER.id);
    expect(page1Text).toBeDefined();
    expect(page1Text).toContain('стр 1/2');

    const nextData = encodeCallback({ entity: 's', action: 'pg', id: 2 });
    await h.send(callback(OWNER, nextData, searchResultMessage(OWNER.id, page1Text!)));

    const edit = lastEditTo(h, OWNER.id);
    expect(edit.text).toContain('стр 2/2');
    // Together, both pages cover every matching task exactly once.
    const combinedText = `${page1Text!}\n${edit.text}`;
    for (const title of titles) {
      expect(combinedText).toContain(title);
    }
  });

  it('pagination on a message with no recoverable query answers with "expired" rather than guessing', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);

    const data = encodeCallback({ entity: 's', action: 'pg', id: 2 });
    await h.send(callback(OWNER, data, botKeyboardMessage(OWNER)));

    expect(lastAnswerText(h)).toBe(texts.search.expired);
    expect(fake(h).edits).toHaveLength(0);
  });

  it('a stale "_" query (escaped) does not match an unrelated task via re-parsing a weird header', async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);
    const withUnderscore = await insertTask(h, { title: 'Задача A_B' });
    await insertTask(h, { title: 'Купить мел' });

    await h.send(dmText(OWNER, '/search _'));

    const [reply] = h.replies(OWNER.id);
    expect(reply).toContain(`T${String(withUnderscore.id)}`);
    expect(reply).not.toContain('Купить мел');
  });

  it("tapping a result row's own button opens that task's card (reuses the v1:l:opn callback)", async () => {
    const h = await createBotHarness();
    await makeOwner(h, OWNER);
    const task = await insertTask(h, { title: 'Подготовить расписание' });

    await h.send(dmText(OWNER, '/search расписание'));
    const openData = encodeCallback({ entity: 'l', action: 'opn', id: task.id });

    await h.send(callback(OWNER, openData, botKeyboardMessage(OWNER)));

    const edit = lastEditTo(h, OWNER.id);
    expect(edit.text).toContain(`T${String(task.id)}`);
    expect(edit.buttons?.flat().some((b) => b.text === texts.taskCard.doneButton)).toBe(true);
  });
});
