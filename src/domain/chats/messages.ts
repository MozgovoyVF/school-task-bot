import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { messages } from '../../db/schema/index.js';
import type { IncomingMessage } from '../../bot/handlers/normalize.js';
import type { ChatRow } from './repo.js';

export type MessageRow = typeof messages.$inferSelect;

export interface SaveIncomingMessageInput {
  chat: ChatRow;
  incoming: IncomingMessage;
  authorUserId: number;
  status: 'pending' | 'skipped';
}

/**
 * Persists one group message (SPEC §7.2, plan.md Task 1.8). Only chats
 * `status='active'` and `analysis_enabled=true` ever get a row written —
 * the caller (`src/bot/handlers/group.ts`) is expected to have already
 * filtered on this, but the check is repeated here too (same
 * belt-and-braces pattern as `setChatActive`'s `WHERE status='pending'` in
 * `src/domain/chats/repo.ts`), so this function is safe to call on its own.
 *
 * `ON CONFLICT (chat_id, tg_message_id) DO NOTHING` makes a duplicate
 * delivery of the same Telegram update a no-op: the first call inserts and
 * returns the row, a repeat matches the existing row and `.returning()`
 * yields nothing, so this returns `null` without touching anything — an
 * existing row's `analysis_status` must only ever change via the batch
 * pipeline or {@link applyEdit}, never by a re-save.
 */
export async function saveIncomingMessage(
  db: DbOrTx,
  input: SaveIncomingMessageInput,
): Promise<MessageRow | null> {
  if (input.chat.status !== 'active' || !input.chat.analysisEnabled) return null;

  const [row] = await db
    .insert(messages)
    .values({
      chatId: input.chat.id,
      tgMessageId: input.incoming.tgMessageId,
      authorUserId: input.authorUserId,
      sentAt: input.incoming.sentAt,
      text: input.incoming.text,
      replyToTgMessageId: input.incoming.replyToTgMessageId,
      replyToQuote: input.incoming.replyQuote,
      forwardOriginName: input.incoming.forwardOriginName,
      isForward: input.incoming.isForward,
      analysisStatus: input.status,
    })
    .onConflictDoNothing({ target: [messages.chatId, messages.tgMessageId] })
    .returning();

  return row ?? null;
}

/**
 * Looks up a saved message by its Telegram id within one chat (plan.md Task 3.10's `/task`-replying-to-a-
 * message case: resolving the replied-to message's internal id for `proposals.source_message_ids`/the
 * card's deep link, when that message happens to already be saved). `null` when it was never saved at all
 * — a `/task` command message itself is never saved (`src/bot/handlers/group.ts`), and a message sent while
 * `analysis_enabled=false` (D12) isn't either — callers must treat that as "no source message", not an
 * error.
 */
export async function getMessageByTgId(
  db: DbOrTx,
  chatId: number,
  tgMessageId: number,
): Promise<MessageRow | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.tgMessageId, tgMessageId)))
    .limit(1);
  return row ?? null;
}

export interface ApplyEditInput {
  chatId: number;
  tgMessageId: number;
  text: string;
  editedAt: Date;
}

export type ApplyEditResult = 'updated_pending' | 'updated_analyzed' | 'not_found';

/**
 * `edited_message` (SPEC §7.2): refreshes the stored text of an existing
 * row. A message that has already reached `analysis_status='analyzed'`
 * additionally gets `edited_at` stamped — MVP does not re-run analysis on
 * an edit, it is only logged (by the caller, `src/bot/handlers/group.ts` —
 * this function takes no `Logger`, matching plan.md Task 1.8's brief
 * signature exactly). Any other status (`pending`, `skipped`,
 * `context_only`) is treated as "not yet analyzed": the text is updated in
 * place and the (still upcoming, or in `skipped`'s case never-run) analysis
 * will see the edited text whenever it does run. Returns `'not_found'` when
 * no row matches `chatId`/`tgMessageId` at all (e.g. the original message
 * was never saved — a `/task` command, or a chat that was ineligible at the
 * time).
 */
export async function applyEdit(db: DbOrTx, input: ApplyEditInput): Promise<ApplyEditResult> {
  const [existing] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, input.chatId), eq(messages.tgMessageId, input.tgMessageId)))
    .limit(1);
  if (!existing) return 'not_found';

  if (existing.analysisStatus === 'analyzed') {
    await db
      .update(messages)
      .set({ text: input.text, editedAt: input.editedAt })
      .where(eq(messages.id, existing.id));
    return 'updated_analyzed';
  }

  await db.update(messages).set({ text: input.text }).where(eq(messages.id, existing.id));
  return 'updated_pending';
}
