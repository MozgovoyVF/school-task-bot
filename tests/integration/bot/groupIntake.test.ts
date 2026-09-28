import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { groupText, editedGroupText } from '../../helpers/updates.js';
import { createLogger } from '../../../src/ops/logger.js';
import { chats, memberships, messages, users } from '../../../src/db/schema/index.js';
import type { ChatRow } from '../../../src/domain/chats/repo.js';

const GROUP = { id: -1002222, type: 'supergroup' as const, title: 'Учительская' };
const MEMBER = { id: 210, firstName: 'Мария Иванова' };
const BOT_SENDER = { id: 999, firstName: 'Другой бот', isBot: true };
/** `id` matches `botHarness.ts`'s `DEFAULT_SUPERADMIN_IDS[0]` — a fresh row, `users.timezone` unset. */
const SUPERADMIN = { id: 900000001, firstName: 'Анна Директор' };
const OTHER_MEMBER = { id: 211, firstName: 'Пётр Сидоров' };

/** Directly inserts a `chats` row (bypassing `onBotAdded`) so a test can pick its exact `status`/`analysis_enabled`. */
async function makeChat(
  harness: BotHarness,
  overrides?: {
    tgChatId?: number;
    status?: 'pending' | 'active' | 'paused' | 'left';
    analysisEnabled?: boolean;
  },
): Promise<ChatRow> {
  const [row] = await harness.db
    .insert(chats)
    .values({
      tgChatId: overrides?.tgChatId ?? GROUP.id,
      workspaceId: harness.deps.workspace.id,
      title: GROUP.title,
      type: 'supergroup',
      status: overrides?.status ?? 'active',
      analysisEnabled: overrides?.analysisEnabled ?? true,
    })
    .returning();
  if (!row) throw new Error('makeChat: insert returned no row');
  return row;
}

async function getMessageRow(harness: BotHarness, chatId: number, tgMessageId: number) {
  const [row] = await harness.db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.tgMessageId, tgMessageId)));
  return row;
}

async function listMessages(harness: BotHarness, chatId: number) {
  return harness.db.select().from(messages).where(eq(messages.chatId, chatId));
}

async function getUserByTgId(harness: BotHarness, tgUserId: number) {
  const [row] = await harness.db.select().from(users).where(eq(users.tgUserId, tgUserId));
  return row;
}

async function getMembership(harness: BotHarness, workspaceId: number, userId: number) {
  const [row] = await harness.db
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  return row;
}

/** A logger that writes its lines into an in-memory array (mirrors `errorReporter.test.ts`'s helper). */
function capturingLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: unknown, _enc, cb: () => void) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, logger: createLogger({ level: 'debug', destination }) };
}

describe('group message intake (SPEC §7.2, plan.md Task 1.8)', () => {
  it('an active chat stores a plain-text message as pending, upserting the author with a first-word display name (D28)', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);

    const update = groupText(GROUP, MEMBER, 'Маша, подготовь расписание');
    await harness.send(update);

    const tgMessageId = update.message?.message_id;
    if (tgMessageId === undefined) throw new Error('expected a message_id on the built update');
    const row = await getMessageRow(harness, chat.id, tgMessageId);
    expect(row?.analysisStatus).toBe('pending');
    expect(row?.text).toBe('Маша, подготовь расписание');

    const author = await getUserByTgId(harness, MEMBER.id);
    expect(author).toBeDefined();
    if (!author) throw new Error('expected author to exist');
    expect(row?.authorUserId).toBe(author.id);

    const membership = await getMembership(harness, harness.deps.workspace.id, author.id);
    expect(membership?.displayName).toBe('Мария');
    expect(membership?.role).toBe('member');
  });

  it('a stop-list message ("ок") is stored as skipped', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);

    const update = groupText(GROUP, MEMBER, 'ок');
    await harness.send(update);

    const tgMessageId = update.message?.message_id;
    if (tgMessageId === undefined) throw new Error('expected a message_id');
    const row = await getMessageRow(harness, chat.id, tgMessageId);
    expect(row?.analysisStatus).toBe('skipped');
  });

  it('messages from other bots are not saved', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);

    const update = groupText(GROUP, BOT_SENDER, 'Не сохранится');
    await harness.send(update);

    expect(await listMessages(harness, chat.id)).toHaveLength(0);
  });

  it('a pending, paused or analysis-disabled chat saves nothing', async () => {
    const harness = await createBotHarness();
    const pendingChat = await makeChat(harness, { tgChatId: -1002001, status: 'pending' });
    const pausedChat = await makeChat(harness, { tgChatId: -1002002, status: 'paused' });
    const disabledChat = await makeChat(harness, { tgChatId: -1002003, analysisEnabled: false });

    await harness.send(groupText({ id: pendingChat.tgChatId, type: 'supergroup' }, MEMBER, 'Привет'));
    await harness.send(groupText({ id: pausedChat.tgChatId, type: 'supergroup' }, MEMBER, 'Привет'));
    await harness.send(groupText({ id: disabledChat.tgChatId, type: 'supergroup' }, MEMBER, 'Привет'));

    expect(await listMessages(harness, pendingChat.id)).toHaveLength(0);
    expect(await listMessages(harness, pausedChat.id)).toHaveLength(0);
    expect(await listMessages(harness, disabledChat.id)).toHaveLength(0);

    // `createContextMiddleware` always upserts `ctx.from` into `users` regardless of chat status (it runs
    // ahead of any handler), so the absence check that matters here is `memberships` — that row is only
    // ever created by this handler's own `ensureMembership` call, which none of these three chats reach.
    const author = await getUserByTgId(harness, MEMBER.id);
    if (!author) throw new Error('expected the context middleware to have upserted the sender');
    const membership = await getMembership(harness, harness.deps.workspace.id, author.id);
    expect(membership).toBeUndefined();
  });

  it('a photo with a caption is saved as "[фото] <caption>"', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);

    const update = groupText(GROUP, MEMBER, 'счёт', {
      photo: [{ file_id: 'p1', file_unique_id: 'p1u', width: 90, height: 90 }],
      caption: 'счёт',
    });
    await harness.send(update);

    const tgMessageId = update.message?.message_id;
    if (tgMessageId === undefined) throw new Error('expected a message_id');
    const row = await getMessageRow(harness, chat.id, tgMessageId);
    expect(row?.text).toBe('[фото] счёт');
  });

  it('a forwarded message is saved with is_forward=true and forward_origin_name filled', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);

    const update = groupText(GROUP, MEMBER, 'Пересланное сообщение', {
      forward_origin: { type: 'hidden_user', date: 1_699_999_000, sender_user_name: 'Скрытый отправитель' },
    });
    await harness.send(update);

    const tgMessageId = update.message?.message_id;
    if (tgMessageId === undefined) throw new Error('expected a message_id');
    const row = await getMessageRow(harness, chat.id, tgMessageId);
    expect(row?.isForward).toBe(true);
    expect(row?.forwardOriginName).toBe('Скрытый отправитель');
  });

  it('a reply to a message that is not in the DB stores a short quote of it', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);

    const original = {
      message_id: 42424,
      date: 1_700_000_000,
      chat: { id: GROUP.id, type: 'supergroup' as const, title: GROUP.title },
      text: 'Оригинал, которого нет в БД',
      // grammY's `ReplyMessage` type (the shape of `reply_to_message`) requires this key present, if `undefined`
      // (a reply's original message can't itself carry a further nested `reply_to_message`).
      reply_to_message: undefined,
    };
    const update = groupText(GROUP, MEMBER, 'Согласна', { reply_to_message: original });
    await harness.send(update);

    const tgMessageId = update.message?.message_id;
    if (tgMessageId === undefined) throw new Error('expected a message_id');
    const row = await getMessageRow(harness, chat.id, tgMessageId);
    expect(row?.replyToTgMessageId).toBe(42424);
    expect(row?.replyToQuote).toBe('Оригинал, которого нет в БД');
  });

  it('the same update delivered twice results in exactly one row', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);

    const update = groupText(GROUP, MEMBER, 'Дубликат апдейта');
    await harness.send(update);
    await harness.send(update);

    expect(await listMessages(harness, chat.id)).toHaveLength(1);
  });

  it('a 5000-character message is stored in full', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);

    const longText = 'а'.repeat(5000);
    const update = groupText(GROUP, MEMBER, longText);
    await harness.send(update);

    const tgMessageId = update.message?.message_id;
    if (tgMessageId === undefined) throw new Error('expected a message_id');
    const row = await getMessageRow(harness, chat.id, tgMessageId);
    expect(row?.text).toHaveLength(5000);
    expect(row?.text).toBe(longText);
  });

  it('edited_message on a still-pending message updates the text and leaves edited_at empty', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);

    const original = groupText(GROUP, MEMBER, 'Нужно подготовить документы');
    await harness.send(original);
    const tgMessageId = original.message?.message_id;
    if (tgMessageId === undefined) throw new Error('expected a message_id');

    const edited = editedGroupText(GROUP, MEMBER, 'Нужно подготовить документы к среде', {
      message_id: tgMessageId,
    });
    await harness.send(edited);

    const row = await getMessageRow(harness, chat.id, tgMessageId);
    expect(row?.text).toBe('Нужно подготовить документы к среде');
    expect(row?.editedAt).toBeNull();
    expect(row?.analysisStatus).toBe('pending');
  });

  it('edited_message on an already-analyzed message updates text, stamps edited_at, and logs a debug line', async () => {
    const { logger, lines } = capturingLogger();
    const harness = await createBotHarness({ logger });
    const chat = await makeChat(harness);

    const original = groupText(GROUP, MEMBER, 'Нужно подготовить документы');
    await harness.send(original);
    const tgMessageId = original.message?.message_id;
    if (tgMessageId === undefined) throw new Error('expected a message_id');

    await harness.db
      .update(messages)
      .set({ analysisStatus: 'analyzed' })
      .where(and(eq(messages.chatId, chat.id), eq(messages.tgMessageId, tgMessageId)));

    const edited = editedGroupText(GROUP, MEMBER, 'Нужно подготовить документы к среде', {
      message_id: tgMessageId,
    });
    await harness.send(edited);

    const row = await getMessageRow(harness, chat.id, tgMessageId);
    expect(row?.text).toBe('Нужно подготовить документы к среде');
    expect(row?.editedAt).not.toBeNull();
    expect(row?.analysisStatus).toBe('analyzed');
    expect(lines.some((line) => line.includes('edited an already-analyzed message'))).toBe(true);
  });

  it('/task is not saved by this handler (stub logs and returns); other commands are silently ignored', async () => {
    const { logger, lines } = capturingLogger();
    const harness = await createBotHarness({ logger });
    const chat = await makeChat(harness);

    const taskUpdate = groupText(GROUP, MEMBER, '/task купить бумагу');
    await harness.send(taskUpdate);

    // A command other than /task (and other than /privacy, which Task 1.11 gives its own
    // group-answering handler — see tests/integration/bot/privacy.test.ts) is still silently ignored.
    const otherUpdate = groupText(GROUP, MEMBER, '/foobar');
    await harness.send(otherUpdate);

    expect(await listMessages(harness, chat.id)).toHaveLength(0);
    expect(lines.some((line) => line.includes('/task received'))).toBe(true);
    expect(harness.replies(GROUP.id)).toEqual([]);
  });
});

/**
 * Final Phase 1 review's C1 fix: `/start`/`/help`/`/timezone`/`/admin` are
 * DM-only commands (SPEC §12.2: only `/privacy` may post text in a group).
 * Before the fix, `/start`/`/timezone` in an active group would enter the
 * `timezone` conversation *scoped to that group chat* — every later message
 * in the group, from anyone, would then be swallowed by the conversation's
 * resume handler ("Пожалуйста, нажмите одну из кнопок ниже") instead of
 * reaching `registerGroupHandlers`' intake, for up to
 * `CONVERSATION_TIMEOUT_MS`. Each case below asserts both halves: nothing
 * was posted into the group by the command itself, and an ordinary message
 * sent right after — from a *different* member — is still saved normally.
 */
describe('/start, /help, /timezone, /admin have no effect in a group (final Phase 1 review’s C1 fix)', () => {
  async function expectGroupUnaffectedAfter(harness: BotHarness, chat: ChatRow, commandText: string) {
    await harness.send(groupText(GROUP, SUPERADMIN, commandText));
    expect(harness.replies(GROUP.id)).toEqual([]);

    const update = groupText(GROUP, OTHER_MEMBER, 'Обычное сообщение после команды');
    await harness.send(update);

    const tgMessageId = update.message?.message_id;
    if (tgMessageId === undefined) throw new Error('expected a message_id');
    const row = await getMessageRow(harness, chat.id, tgMessageId);
    expect(row?.text).toBe('Обычное сообщение после команды');
    expect(harness.replies(GROUP.id)).toEqual([]);
  }

  it('/start (first run, would otherwise enter the timezone conversation) has no effect in a group', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);
    await expectGroupUnaffectedAfter(harness, chat, '/start');
  });

  it('/help has no effect in a group', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);
    await expectGroupUnaffectedAfter(harness, chat, '/help');
  });

  it('/timezone (would otherwise enter the timezone conversation) has no effect in a group', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);
    await expectGroupUnaffectedAfter(harness, chat, '/timezone');
  });

  it('/admin has no effect in a group', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness);
    await expectGroupUnaffectedAfter(harness, chat, '/admin');
  });
});
