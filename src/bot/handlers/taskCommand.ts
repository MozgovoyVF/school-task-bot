import type { Message } from 'grammy/types';
import type { AppDeps } from '../../deps.js';
import { TASK_COMMAND_REACTION_EMOJI, QUOTE_MAX_CHARS } from '../../config/constants.js';
import type { ChatRow } from '../../domain/chats/repo.js';
import { getMessageByTgId } from '../../domain/chats/messages.js';
import { ensureMembership, upsertTelegramUser } from '../../domain/people/repo.js';
import { createManualProposal } from '../../domain/proposals/repo.js';
import { extractSingle } from '../../ai/pipeline/extractSingle.js';
import { defaultDisplayName } from './group.js';

export type TaskCommandDeps = Pick<AppDeps, 'db' | 'ai' | 'workspace' | 'clock' | 'logger' | 'messenger'>;

/** Truncates to `QUOTE_MAX_CHARS` *code points*, matching every other quote truncation in this codebase. */
function truncateQuote(text: string): string {
  const chars = Array.from(text);
  return chars.length <= QUOTE_MAX_CHARS ? text : chars.slice(0, QUOTE_MAX_CHARS).join('');
}

interface QuotedSource {
  text: string;
  quoteAuthorName: string | null;
  /** D46: the quote's own author by internal `users.id` — the replied-to message's author for a reply,
   * the invoker themselves for the typed-args fallback (same split `quoteAuthorName` above already makes). */
  quoteAuthorUserId: number | null;
  sourceMessageIds: number[];
}

/**
 * Resolves `/task`'s source text (SPEC §12.1): either the message it replies to, or the text typed after
 * the command itself. A reply to a forum topic's own "topic created" service message doesn't count as a
 * reply at all (D26, same rule `src/bot/handlers/normalize.ts`'s `resolveReply` applies to the AI pipeline).
 * `null` when there is neither a usable reply nor inline text (brief step 5: ignored, debug-logged).
 *
 * When replying to someone else's message, that author is ensured as a workspace member (same
 * first-seen-becomes-a-member rule `src/bot/handlers/group.ts`'s `saveMessage` already applies) so their
 * display name can be quoted and, in principle, resolved as a participant by `extractSingle`. The replied-to
 * message's own internal id is looked up only if it happens to already be saved (`getMessageByTgId`) — it
 * may well not be (a `/task` command message itself is never saved, and a message sent while
 * `analysis_enabled=false` isn't either, D12) — in which case `sourceMessageIds` is simply `[]`.
 */
async function resolveSource(
  deps: TaskCommandDeps,
  chat: ChatRow,
  msg: Message,
  commandArgs: string | null,
  invokerDisplayName: string,
  invokerUserId: number,
): Promise<QuotedSource | null> {
  const original = msg.reply_to_message;
  if (original && !original.forum_topic_created) {
    const text = original.text ?? original.caption ?? null;
    if (text === null) return null;

    let quoteAuthorName: string | null = null;
    let quoteAuthorUserId: number | null = null;
    if (original.from && !original.from.is_bot) {
      const author = await upsertTelegramUser(deps.db, original.from);
      const membership = await ensureMembership(deps.db, {
        workspaceId: deps.workspace.id,
        userId: author.id,
        displayName: defaultDisplayName(original.from.first_name),
      });
      quoteAuthorName = membership.displayName;
      quoteAuthorUserId = author.id;
    }

    const existing = await getMessageByTgId(deps.db, chat.id, original.message_id);
    return { text, quoteAuthorName, quoteAuthorUserId, sourceMessageIds: existing ? [existing.id] : [] };
  }

  if (commandArgs === null) return null;
  return {
    text: commandArgs,
    quoteAuthorName: invokerDisplayName,
    quoteAuthorUserId: invokerUserId,
    sourceMessageIds: [],
  };
}

/**
 * `/task` in a group (plan.md Task 3.10, SPEC §12.1): replying to a message turns that message into a
 * task, `/task <text>` turns the text itself into one — either way through `extractSingle`'s single-
 * message extractor (D19, no confidence threshold) and `createManualProposal` (`category='manual'`,
 * always `policyDecision='shown'`), landing in the exact same outbox (`src/scheduler/jobs/cards.ts`, Task
 * 2.12) every AI-detected proposal does. The bot never replies with text in the group (SPEC §12.1) — the
 * only visible acknowledgement here is the ✍ reaction on the command message itself, best-effort (never
 * blocks proposal creation on a reaction failure, mirrors every other reaction call site in this codebase).
 * Permission-free by design (SPEC §3's `/task` row): Superadmin, Owner and any Member alike all produce the
 * same outcome — a proposal for the Owner (D40) — so there is nothing to gate here; the caller
 * (`src/bot/handlers/group.ts`) has already confirmed the chat itself is `active` (D12).
 */
export async function handleTaskCommand(
  deps: TaskCommandDeps,
  chat: ChatRow,
  msg: Message,
  commandArgs: string | null,
): Promise<void> {
  if (!msg.from) return; // should not happen — `normalizeIncoming` only sets `isTaskCommand` for a human sender
  const invoker = await upsertTelegramUser(deps.db, msg.from);
  const membership = await ensureMembership(deps.db, {
    workspaceId: deps.workspace.id,
    userId: invoker.id,
    displayName: defaultDisplayName(msg.from.first_name),
  });

  const source = await resolveSource(deps, chat, msg, commandArgs, membership.displayName, invoker.id);
  if (source === null) {
    deps.logger.debug(
      { chatId: chat.id },
      'taskCommand: /task with neither a reply nor inline text, ignored',
    );
    return;
  }

  const now = deps.clock.now();
  const action = await extractSingle(deps, {
    text: source.text,
    authorUserId: invoker.id,
    workspaceId: deps.workspace.id,
    now,
  });

  await createManualProposal(deps.db, {
    workspaceId: deps.workspace.id,
    chatId: chat.id,
    action,
    origin: 'manual_group',
    sourceMessageIds: source.sourceMessageIds,
    quote: truncateQuote(source.text),
    quoteAuthorName: source.quoteAuthorName,
    quoteAuthorUserId: source.quoteAuthorUserId,
    createdByUserId: invoker.id,
    now,
  });

  try {
    await deps.messenger.react(chat.tgChatId, msg.message_id, TASK_COMMAND_REACTION_EMOJI);
  } catch (err) {
    deps.logger.error({ err, chatId: chat.id }, 'taskCommand: failed to react to the /task command');
  }
}
