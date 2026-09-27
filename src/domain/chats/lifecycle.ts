import type { Db, DbOrTx } from '../../db/client.js';
import type { Messenger } from '../messenger.js';
import type { Clock } from '../../time/clock.js';
import type { Logger } from '../../ops/logger.js';
import type { WorkspaceRow } from '../workspaces/repo.js';
import { getSettings } from '../workspaces/repo.js';
import { can, type Actor } from '../people/permissions.js';
import { getOwner, getUserById, getUserByTgId } from '../people/repo.js';
// `domain/` importing `bot/texts` and `bot/views` is a deliberate exception
// here, not a layering slip: `publishNoticeOnce`'s notice text is spec'd as
// `settings.privacyNoticeText ?? texts.privacy.chatNotice` (plan.md's Task
// 1.6 brief, Step 3), and this file is the only place that decides *who*
// gets the approval card and *when* (at add time vs. after `/claim`), so it
// has to build and send that card itself rather than bubble rendering back
// up to a handler — there is no bot-layer caller left to do it for
// `requestPendingApprovals`, which runs from `afterOwnerChanged` with no
// handler in the loop at all. Neither import touches grammY or does any
// I/O of its own (`bot/texts/ru.ts` is plain strings, `chatApproval.ts` is a
// pure render), so CLAUDE.md §7's actual rule ("domain must not depend on
// grammY; send through `Messenger`") still holds.
import { texts } from '../../bot/texts/ru.js';
import { renderChatApprovalCard, type ChatApprovalView } from '../../bot/views/chatApproval.js';
import {
  claimNoticeSlot,
  claimPendingChatForAutoLeave,
  clearNoticeSlot,
  clearPendingSince,
  getChatById,
  getChatByTgId,
  listPendingChatsAwaitingOwner,
  markChatLeft,
  pauseChatRow,
  resumeChatRow,
  setChatActive,
  setPendingSinceIfMissing,
  toggleChatAnalysis,
  toggleChatReactions,
  updateChatOnMigrate,
  upsertChatOnAdd,
  type ChatRow,
} from './repo.js';

export interface ChatLifecycleDeps {
  db: Db;
  messenger: Messenger;
  clock: Clock;
  logger: Logger;
  superadminIds: number[];
  /** The single default workspace (MVP, SPEC §5.2) every chat is attached to. */
  workspace: WorkspaceRow;
}

function dedupeIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

async function sendCard(
  deps: Pick<ChatLifecycleDeps, 'messenger' | 'logger'>,
  recipients: number[],
  card: ChatApprovalView,
): Promise<void> {
  for (const chatId of dedupeIds(recipients)) {
    try {
      await deps.messenger.send(chatId, card.text, { buttons: card.buttons });
    } catch (err) {
      deps.logger.error({ err, chatId }, 'chats/lifecycle: failed to send an approval card');
    }
  }
}

export interface OnBotAddedInput {
  tgChat: { id: number; title: string; type: 'group' | 'supergroup' };
  addedByTgUserId: number;
}

export type OnBotAddedOutcome = 'activated' | 'pending_notified' | 'pending_no_owner';

/**
 * `my_chat_member` "added" transition (SPEC §15.1). The Owner or a
 * workspace-linked superadmin (D14 — MVP's single workspace means every
 * configured superadmin counts) activates the chat immediately and
 * publishes the one-time privacy notice into it; anyone else leaves it
 * `pending` and sends an approval card to whoever can decide
 * (`chat.approve`): the Owner, if one exists yet, plus every superadmin.
 * `pending_since` (the 72h auto-leave clock, D5) only starts once an Owner
 * exists to act on it — `requestPendingApprovals` (called from
 * `afterOwnerChanged`, Task 1.5) starts it later for chats added before
 * `/claim`.
 */
export async function onBotAdded(
  deps: ChatLifecycleDeps,
  input: OnBotAddedInput,
): Promise<{ chat: ChatRow; outcome: OnBotAddedOutcome }> {
  const now = deps.clock.now();
  const owner = await getOwner(deps.db, deps.workspace.id);
  const adder = await getUserByTgId(deps.db, input.addedByTgUserId);
  const addedByUserId = adder?.id ?? null;

  const isOwner = owner !== null && owner.user.tgUserId === input.addedByTgUserId;
  const isSuperadmin = deps.superadminIds.includes(input.addedByTgUserId);

  if (isOwner || isSuperadmin) {
    const chat = await upsertChatOnAdd(deps.db, {
      tgChatId: input.tgChat.id,
      title: input.tgChat.title,
      type: input.tgChat.type,
      workspaceId: deps.workspace.id,
      addedByUserId,
      status: 'active',
      pendingSince: null,
      now,
    });
    await publishNoticeOnce(deps, chat);
    return { chat, outcome: 'activated' };
  }

  const chat = await upsertChatOnAdd(deps.db, {
    tgChatId: input.tgChat.id,
    title: input.tgChat.title,
    type: input.tgChat.type,
    workspaceId: deps.workspace.id,
    addedByUserId,
    status: 'pending',
    pendingSince: owner ? now : null,
    now,
  });

  const addedByName = adder?.firstName ?? texts.chats.unknownAdder;
  const card = renderChatApprovalCard(chat, addedByName);
  const recipients = owner ? [owner.user.tgUserId, ...deps.superadminIds] : deps.superadminIds;
  await sendCard(deps, recipients, card);

  return { chat, outcome: owner ? 'pending_notified' : 'pending_no_owner' };
}

export type ApproveChatResult =
  { ok: true; chat: ChatRow } | { ok: false; reason: 'forbidden' | 'not_pending' };

/**
 * `texts.chats.approveButton`. Permission-checked (`chat.approve` — Owner or
 * superadmin) and idempotent: a double click (or a forged callback replayed
 * against an already-active chat) hits `setChatActive`'s `WHERE
 * status='pending'` and returns `not_pending` without touching anything.
 */
export async function approveChat(
  deps: ChatLifecycleDeps,
  chatId: number,
  actor: Actor,
): Promise<ApproveChatResult> {
  if (!can(actor, 'chat.approve')) return { ok: false, reason: 'forbidden' };

  const chat = await setChatActive(deps.db, chatId, deps.clock.now());
  if (!chat) return { ok: false, reason: 'not_pending' };

  await publishNoticeOnce(deps, chat);
  return { ok: true, chat };
}

export type RejectChatResult =
  { ok: true; chat: ChatRow } | { ok: false; reason: 'forbidden' | 'not_pending' };

/**
 * `texts.chats.leaveButton` on a *pending* chat's approval card. Shares its
 * "tell Telegram to leave, mark the row `left`" side effect with the Owner-initiated
 * `/chats` leave button Task 1.9 adds (`leaveChatInternal` below) — see
 * plan.md's Task 1.6 preflight note. Only ever acts on a chat that is still
 * `pending`; an already-decided chat (active/paused/left) is left alone —
 * that is Task 1.9's `leaveChat`'s job, not this button's.
 */
export async function rejectChat(
  deps: ChatLifecycleDeps,
  chatId: number,
  actor: Actor,
): Promise<RejectChatResult> {
  if (!can(actor, 'chat.approve')) return { ok: false, reason: 'forbidden' };

  const chat = await getChatById(deps.db, chatId);
  if (!chat || chat.status !== 'pending') return { ok: false, reason: 'not_pending' };

  const updated = await leaveChatInternal(deps, chatId);
  if (!updated) return { ok: false, reason: 'not_pending' };
  return { ok: true, chat: updated };
}

/**
 * Shared "leave a chat the bot is still in" side effect: tells Telegram to
 * leave, then applies `markChatLeft`'s DB side effects (`repo.ts`). Used by
 * `rejectChat` above and by the auto-leave scheduler job
 * (`src/scheduler/jobs/pendingChats.ts`); Task 1.9's owner-initiated
 * `leaveChat` (`/chats`'s leave button) is expected to reuse it too,
 * instead of duplicating the messenger-leave + status-update logic. Not
 * used by `onBotRemoved` below — there, Telegram has already removed the
 * bot, so calling `messenger.leaveChat` again would just fail.
 */
export async function leaveChatInternal(
  deps: Pick<ChatLifecycleDeps, 'db' | 'messenger' | 'clock'>,
  chatId: number,
): Promise<ChatRow | null> {
  const chat = await getChatById(deps.db, chatId);
  if (!chat) return null;

  await deps.messenger.leaveChat(chat.tgChatId);
  return markChatLeft(deps.db, chatId, deps.clock.now());
}

/**
 * Auto-leave path for `pendingChatsJob` (`src/scheduler/jobs/pendingChats.ts`,
 * SPEC §15.1's 72h rule). Deliberately *not* `leaveChatInternal`: that
 * function's `markChatLeft` accepts any non-`left` status, which is correct
 * for `rejectChat` (an immediate precheck already confirmed `pending`
 * moments earlier) but unsafe here — the job lists expired chats and then
 * makes one live `messenger.leaveChat` call per chat in a loop, with no
 * serialization against the bot's own callback-query handling in the same
 * process. `claimPendingChatForAutoLeave` claims the row atomically first
 * (`status='pending'` only); `messenger.leaveChat` is only called once that
 * claim actually lands, so an Owner's "approve" tap racing the job's per-chat
 * leave can never be silently reversed. Returns `null` (no-op, no error) if
 * the chat was no longer `pending` by the time this ran.
 */
export async function leaveExpiredPendingChat(
  deps: Pick<ChatLifecycleDeps, 'db' | 'messenger' | 'clock'>,
  chatId: number,
): Promise<ChatRow | null> {
  const claimed = await claimPendingChatForAutoLeave(deps.db, chatId, deps.clock.now());
  if (!claimed) return null;

  await deps.messenger.leaveChat(claimed.tgChatId);
  return claimed;
}

/**
 * `my_chat_member` "removed" transition (kicked, or the bot itself leaving —
 * SPEC §15, point 5): the bot is already gone from the chat, so only the DB
 * side effects (`markChatLeft`) run.
 */
export async function onBotRemoved(
  deps: Pick<ChatLifecycleDeps, 'db' | 'clock' | 'logger'>,
  tgChatId: number,
): Promise<void> {
  const chat = await getChatByTgId(deps.db, tgChatId);
  if (!chat) {
    deps.logger.warn({ tgChatId }, 'onBotRemoved: no matching chat row');
    return;
  }
  await markChatLeft(deps.db, chat.id, deps.clock.now());
}

/** `migrate_to_chat_id` (group → supergroup upgrade, CLAUDE.md §12): same row, new `tg_chat_id`/`type`. */
export async function migrateChat(db: Db, oldTgChatId: number, newTgChatId: number): Promise<ChatRow | null> {
  return updateChatOnMigrate(db, oldTgChatId, newTgChatId);
}

export type SetAnalysisResult =
  { ok: true; chat: ChatRow } | { ok: false; reason: 'forbidden' | 'not_found' };

/**
 * `/chats`' analysis toggle button (SPEC §15.4, Task 1.9,
 * `texts.chats.analysisButton`): flips `analysis_enabled` in place —
 * permission-checked (`chat.approve`, the same gate `approveChat`/
 * `rejectChat`/the rest of `/chats`' actions use, since SPEC §3's
 * permission table has no separate row for chat *management* and a
 * superadmin already decides whether the bot may run in a chat at all).
 * `reason: 'not_found'` covers both "no such chat" and "chat is `left`"
 * (`toggleChatAnalysis`'s guard) — a forged callback against either case is
 * a no-op, not an error.
 */
export async function setAnalysis(
  deps: Pick<ChatLifecycleDeps, 'db' | 'clock'>,
  chatId: number,
  actor: Actor,
): Promise<SetAnalysisResult> {
  if (!can(actor, 'chat.approve')) return { ok: false, reason: 'forbidden' };

  const chat = await toggleChatAnalysis(deps.db, chatId, deps.clock.now());
  if (!chat) return { ok: false, reason: 'not_found' };
  return { ok: true, chat };
}

export type SetReactionsResult =
  { ok: true; chat: ChatRow } | { ok: false; reason: 'forbidden' | 'not_found' };

/** `/chats`' reactions toggle button (Task 1.9, `texts.chats.reactionsButton`) — same shape as {@link setAnalysis}, flips `reactions_enabled`. */
export async function setReactions(
  deps: Pick<ChatLifecycleDeps, 'db' | 'clock'>,
  chatId: number,
  actor: Actor,
): Promise<SetReactionsResult> {
  if (!can(actor, 'chat.approve')) return { ok: false, reason: 'forbidden' };

  const chat = await toggleChatReactions(deps.db, chatId, deps.clock.now());
  if (!chat) return { ok: false, reason: 'not_found' };
  return { ok: true, chat };
}

export type PauseChatResult = { ok: true; chat: ChatRow } | { ok: false; reason: 'forbidden' | 'not_active' };

/**
 * `/chats`' pause button (SPEC §15.4, `texts.chats.pauseButton`): `active`
 * → `paused` (messages stop being saved — SPEC §15's `paused` semantics
 * live in the intake path, not here). Idempotent: a double-tap, or a
 * forged callback against a chat that is already `paused`/`pending`/`left`,
 * hits `pauseChatRow`'s `WHERE status='active'` and returns `not_active`
 * without touching anything, same as `approveChat`'s `not_pending`.
 */
export async function pauseChat(
  deps: Pick<ChatLifecycleDeps, 'db' | 'clock'>,
  chatId: number,
  actor: Actor,
): Promise<PauseChatResult> {
  if (!can(actor, 'chat.approve')) return { ok: false, reason: 'forbidden' };

  const chat = await pauseChatRow(deps.db, chatId, deps.clock.now());
  if (!chat) return { ok: false, reason: 'not_active' };
  return { ok: true, chat };
}

export type ResumeChatResult =
  { ok: true; chat: ChatRow } | { ok: false; reason: 'forbidden' | 'not_paused' };

/** `/chats`' resume button (Task 1.9, `texts.chats.resumeButton`): `paused` → `active` — the inverse of {@link pauseChat}. */
export async function resumeChat(
  deps: Pick<ChatLifecycleDeps, 'db' | 'clock'>,
  chatId: number,
  actor: Actor,
): Promise<ResumeChatResult> {
  if (!can(actor, 'chat.approve')) return { ok: false, reason: 'forbidden' };

  const chat = await resumeChatRow(deps.db, chatId, deps.clock.now());
  if (!chat) return { ok: false, reason: 'not_paused' };
  return { ok: true, chat };
}

export type LeaveChatResult = { ok: true; chat: ChatRow } | { ok: false; reason: 'forbidden' | 'not_found' };

/**
 * `/chats`' leave button (SPEC §15.4, Task 1.9, `texts.chats.manageLeaveButton`),
 * taken after the confirmation prompt (`bot/views/chats.ts`'s
 * `renderLeaveConfirm`) — unlike
 * `rejectChat` (only ever acts on a still-`pending` chat, from that chat's
 * own approval card), this is the Owner deciding to leave a chat the bot is
 * *already active in* (or `paused`). Shares its "tell Telegram to leave,
 * mark the row `left`" side effect with `rejectChat` via `leaveChatInternal`
 * (`repo.ts`'s `leaveChatRow`, Task 1.6's preflight note) rather than
 * duplicating it. The `status === 'left'` precheck here — on top of
 * `leaveChatInternal`'s own `markChatLeft` guard — stops a double-tap (or a
 * forged callback replayed after the chat already left) from calling
 * `messenger.leaveChat` a second time on a chat Telegram already removed
 * the bot from.
 */
export async function leaveChat(
  deps: Pick<ChatLifecycleDeps, 'db' | 'messenger' | 'clock'>,
  chatId: number,
  actor: Actor,
): Promise<LeaveChatResult> {
  if (!can(actor, 'chat.approve')) return { ok: false, reason: 'forbidden' };

  const chat = await getChatById(deps.db, chatId);
  if (!chat || chat.status === 'left') return { ok: false, reason: 'not_found' };

  const updated = await leaveChatInternal(deps, chatId);
  if (!updated) return { ok: false, reason: 'not_found' };
  return { ok: true, chat: updated };
}

/**
 * Publishes SPEC §15.2's one-time privacy notice into `chat` (brief Step 3):
 * `claimNoticeSlot` "stakes" the send first (`UPDATE ... WHERE
 * notice_sent_at IS NULL`), so two racing callers (e.g. a duplicate
 * `my_chat_member` update and a manual `approveChat`) can never both
 * publish; a failed send resets the slot so a later call can retry. Never
 * throws — a notice-send failure shouldn't block whatever activated the
 * chat.
 */
export async function publishNoticeOnce(deps: ChatLifecycleDeps, chat: ChatRow): Promise<void> {
  const claimed = await claimNoticeSlot(deps.db, chat.id, deps.clock.now());
  if (!claimed) return;

  const settings = chat.workspaceId != null ? await getSettings(deps.db, chat.workspaceId) : null;
  const noticeText = settings?.privacyNoticeText ?? texts.privacy.chatNotice;

  try {
    await deps.messenger.send(chat.tgChatId, noticeText);
  } catch (err) {
    await clearNoticeSlot(deps.db, chat.id);
    deps.logger.error({ err, chatId: chat.id }, 'publishNoticeOnce: failed to send the chat privacy notice');
  }
}

export interface RequestPendingApprovalsDeps {
  db: DbOrTx;
  messenger: Messenger;
  clock: Clock;
  logger: Logger;
}

/**
 * Called from `afterOwnerChanged` (Task 1.5, `src/domain/people/ownerChanged.ts`)
 * after a successful `/claim`: chats added while the workspace had no Owner
 * yet (`status='pending'`, `pending_since=null`) now get their approval
 * request sent to the freshly-claimed Owner, and `pending_since` starts
 * their 72h auto-leave clock (D5). Superadmins already got their card at
 * add time (`onBotAdded`) — this only notifies the Owner. A no-op if the
 * workspace somehow still has no Owner.
 */
export async function requestPendingApprovals(
  deps: RequestPendingApprovalsDeps,
  workspaceId: number,
): Promise<void> {
  const owner = await getOwner(deps.db, workspaceId);
  if (!owner) return;

  const now = deps.clock.now();
  const pending = await listPendingChatsAwaitingOwner(deps.db, workspaceId);

  for (const chat of pending) {
    const stamped = await setPendingSinceIfMissing(deps.db, chat.id, now);
    if (!stamped) continue;

    const adder = stamped.addedByUserId != null ? await getUserById(deps.db, stamped.addedByUserId) : null;
    const addedByName = adder?.firstName ?? texts.chats.unknownAdder;
    const card = renderChatApprovalCard(stamped, addedByName);

    try {
      await deps.messenger.send(owner.user.tgUserId, card.text, { buttons: card.buttons });
    } catch (err) {
      // Mirrors publishNoticeOnce's claim/clearNoticeSlot shape: setPendingSinceIfMissing above already
      // "claimed" this chat (so a concurrent call can't double-process it), but the 72h auto-leave clock
      // must not run on a chat the Owner was never actually told about — roll the stamp back so a later
      // call (e.g. the next /claim, or a retry) can still reach them.
      await clearPendingSince(deps.db, chat.id);
      deps.logger.error(
        { err, chatId: chat.id },
        'requestPendingApprovals: failed to send the approval card',
      );
    }
  }
}
