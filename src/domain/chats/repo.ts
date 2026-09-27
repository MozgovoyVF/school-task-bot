import { and, eq, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { chats, messages } from '../../db/schema/index.js';

export type ChatRow = typeof chats.$inferSelect;

/** Looks up a `chats` row by its Telegram chat id. */
export async function getChatByTgId(db: DbOrTx, tgChatId: number): Promise<ChatRow | null> {
  const [row] = await db.select().from(chats).where(eq(chats.tgChatId, tgChatId)).limit(1);
  return row ?? null;
}

/** Looks up a `chats` row by its internal id. */
export async function getChatById(db: DbOrTx, id: number): Promise<ChatRow | null> {
  const [row] = await db.select().from(chats).where(eq(chats.id, id)).limit(1);
  return row ?? null;
}

export interface UpsertChatOnAddInput {
  tgChatId: number;
  title: string;
  type: 'group' | 'supergroup';
  workspaceId: number;
  addedByUserId: number | null;
  status: 'active' | 'pending';
  pendingSince: Date | null;
  now: Date;
}

/**
 * Inserts the `chats` row for a fresh `my_chat_member` "added" transition
 * (`src/domain/chats/lifecycle.ts`'s `onBotAdded`). `tg_chat_id` is unique,
 * so re-adding the bot to a chat it previously left (`status='left'`)
 * updates that same row instead of erroring — `notice_sent_at` is
 * deliberately left out of `set`, since it is either already `null` (a new
 * row, or one `markChatLeft` reset when the bot left — D25) or, on the rare
 * double-`my_chat_member` case, still correctly marks a notice already sent.
 */
export async function upsertChatOnAdd(db: DbOrTx, input: UpsertChatOnAddInput): Promise<ChatRow> {
  const [row] = await db
    .insert(chats)
    .values({
      tgChatId: input.tgChatId,
      title: input.title,
      type: input.type,
      workspaceId: input.workspaceId,
      addedByUserId: input.addedByUserId,
      status: input.status,
      pendingSince: input.pendingSince,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: chats.tgChatId,
      set: {
        title: input.title,
        type: input.type,
        workspaceId: input.workspaceId,
        addedByUserId: input.addedByUserId,
        status: input.status,
        pendingSince: input.pendingSince,
        updatedAt: input.now,
      },
    })
    .returning();
  if (!row) throw new Error('upsertChatOnAdd: insert/update returned no row');
  return row;
}

/** Idempotent activation (`texts.chats.approveButton`): only takes effect on a chat that is still `pending` (double-click safe). */
export async function setChatActive(db: DbOrTx, chatId: number, now: Date): Promise<ChatRow | null> {
  const [row] = await db
    .update(chats)
    .set({ status: 'active', pendingSince: null, updatedAt: now })
    .where(and(eq(chats.id, chatId), eq(chats.status, 'pending')))
    .returning();
  return row ?? null;
}

/** Pending chats in `workspaceId` still waiting on an Owner to exist before their approval request could be sent. */
export async function listPendingChatsAwaitingOwner(db: DbOrTx, workspaceId: number): Promise<ChatRow[]> {
  return db
    .select()
    .from(chats)
    .where(and(eq(chats.workspaceId, workspaceId), eq(chats.status, 'pending'), isNull(chats.pendingSince)))
    .orderBy(chats.id);
}

/** Stamps `pending_since`, but only once (idempotent — a racing second call is a no-op, returns `null`). */
export async function setPendingSinceIfMissing(db: DbOrTx, chatId: number, now: Date): Promise<ChatRow | null> {
  const [row] = await db
    .update(chats)
    .set({ pendingSince: now, updatedAt: now })
    .where(and(eq(chats.id, chatId), eq(chats.status, 'pending'), isNull(chats.pendingSince)))
    .returning();
  return row ?? null;
}

/** Pending chats whose 72h approval window (SPEC §15.1, D5) has elapsed as of `cutoff`. */
export async function listExpiredPendingChats(db: DbOrTx, cutoff: Date): Promise<ChatRow[]> {
  return db
    .select()
    .from(chats)
    .where(and(eq(chats.status, 'pending'), isNotNull(chats.pendingSince), lte(chats.pendingSince, cutoff)))
    .orderBy(chats.id);
}

/**
 * "Bot is no longer in the chat" DB side effect (SPEC §15, point 5 / §15.4
 * point 4): `status='left'`, `notice_sent_at` reset to `null` (D25 — a later
 * re-add publishes the notice again), and any not-yet-analyzed `messages`
 * rows (`analysis_status='pending'`) deleted, since they will now never be
 * analyzed. `tasks` are untouched (SPEC §15's tasks-stay-put rule). Idempotent: a
 * chat already `left` matches no row and this returns `null`. Requires `Db`
 * (owns its own transaction — same pattern as `redeemClaimCode`, plan.md's
 * Task 1.5 — for a function that must run more than one statement
 * atomically).
 */
export async function markChatLeft(db: Db, chatId: number, now: Date): Promise<ChatRow | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(chats)
      .set({ status: 'left', noticeSentAt: null, updatedAt: now })
      .where(and(eq(chats.id, chatId), ne(chats.status, 'left')))
      .returning();
    if (!row) return null;

    await tx.delete(messages).where(and(eq(messages.chatId, chatId), eq(messages.analysisStatus, 'pending')));

    return row;
  });
}

/** "Stakes" a notice send (brief Step 3): only the first caller (per chat) gets `true` back. */
export async function claimNoticeSlot(db: DbOrTx, chatId: number, now: Date): Promise<boolean> {
  const [row] = await db
    .update(chats)
    .set({ noticeSentAt: now })
    .where(and(eq(chats.id, chatId), isNull(chats.noticeSentAt)))
    .returning({ id: chats.id });
  return row !== undefined;
}

/** Resets a claimed notice slot after a failed send, so a later `publishNoticeOnce` call can retry. */
export async function clearNoticeSlot(db: DbOrTx, chatId: number): Promise<void> {
  await db.update(chats).set({ noticeSentAt: null }).where(eq(chats.id, chatId));
}

/** `migrate_to_chat_id` (group → supergroup upgrade, CLAUDE.md §12): same row, new `tg_chat_id`/`type`. */
export async function updateChatOnMigrate(
  db: DbOrTx,
  oldTgChatId: number,
  newTgChatId: number,
): Promise<ChatRow | null> {
  const [row] = await db
    .update(chats)
    .set({ tgChatId: newTgChatId, type: 'supergroup' })
    .where(eq(chats.tgChatId, oldTgChatId))
    .returning();
  return row ?? null;
}
