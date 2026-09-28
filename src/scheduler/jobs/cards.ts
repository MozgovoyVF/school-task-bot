import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { MAX_CARDS_PER_BATCH } from '../../config/constants.js';
import type { AppDeps } from '../../deps.js';
import type { DbOrTx } from '../../db/client.js';
import { chats, messages, proposals, tasks } from '../../db/schema/index.js';
import { getOwner, listMembersWithUsers, markDmBlocked } from '../../domain/people/repo.js';
import { getSettings } from '../../domain/workspaces/repo.js';
import { userZone } from '../../time/zones.js';
import { isQuietAt } from '../../time/quiet.js';
import { formatDue } from '../../time/format.js';
import { messageLink } from '../../bot/views/links.js';
import { renderProposalCard, type ProposalCardView } from '../../bot/views/proposalCard.js';
import { encodeCallback } from '../../bot/keyboards/callbackCodec.js';
import { texts } from '../../bot/texts/ru.js';
import { MessengerError, type Buttons } from '../../domain/messenger.js';
import type { Job } from '../ticker.js';
import type { Category } from '../../ai/pipeline/resolve.js';

type ProposalRow = typeof proposals.$inferSelect;
type ChatRow = typeof chats.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

// Mirrors `src/domain/proposals/repo.ts`'s `ProposalPayload` (jsonb, CLAUDE.md §8 — all external/DB-jsonb
// data goes through zod). Every field the payload's TS interface allows is validated here too, even the
// ones this job never reads (`targetProposalId`), so a genuinely malformed row fails `safeParse` instead
// of silently coercing into something this job renders wrong.
const AssigneeSchema = z.union([
  z.object({ type: z.literal('user'), userId: z.number() }),
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('text'), name: z.string() }),
  z.object({ type: z.literal('none') }),
]);
type PayloadAssignee = z.infer<typeof AssigneeSchema>;

const DueSchema = z.object({
  dueAt: z.string().nullable(),
  allDay: z.boolean(),
  tz: z.string().nullable(),
  inPast: z.boolean(),
  invalid: z.boolean(),
});

const PayloadSchema = z.object({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  category: z.enum(['assignment', 'event', 'owner_intent', 'commitment', 'request_to_owner']).optional(),
  assignee: AssigneeSchema.optional(),
  due: DueSchema.nullable().optional(),
  dueText: z.string().nullable().optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  reasoning: z.string(),
  duplicateOf: z.object({ type: z.enum(['task', 'proposal']), id: z.number(), title: z.string() }).optional(),
  changes: z
    .object({ due: DueSchema.optional(), assignee: AssigneeSchema.optional(), title: z.string().optional() })
    .optional(),
  targetProposalId: z.number().optional(),
  origin: z.enum(['ai', 'manual_group', 'manual_dm', 'forward']),
  noReaction: z.boolean().optional(),
  quote: z.string().nullable(),
  quoteAuthorName: z.string().nullable(),
});
type ProposalPayload = z.infer<typeof PayloadSchema>;

/** Per-run caches (this job never mutates `chats`/`messages`/`tasks`, so a plain id→row map is safe) — avoids re-querying the same chat/message/task for every proposal that shares it. */
interface Loaders {
  db: DbOrTx;
  chats: Map<number, ChatRow | null>;
  messages: Map<number, MessageRow | null>;
  tasks: Map<number, TaskRow | null>;
}

function makeLoaders(db: DbOrTx): Loaders {
  return { db, chats: new Map(), messages: new Map(), tasks: new Map() };
}

async function loadChat(l: Loaders, chatId: number): Promise<ChatRow | null> {
  if (l.chats.has(chatId)) return l.chats.get(chatId) ?? null;
  const [row] = await l.db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  l.chats.set(chatId, row ?? null);
  return row ?? null;
}

async function loadMessage(l: Loaders, id: number): Promise<MessageRow | null> {
  if (l.messages.has(id)) return l.messages.get(id) ?? null;
  const [row] = await l.db.select().from(messages).where(eq(messages.id, id)).limit(1);
  l.messages.set(id, row ?? null);
  return row ?? null;
}

async function loadTask(l: Loaders, id: number): Promise<TaskRow | null> {
  if (l.tasks.has(id)) return l.tasks.get(id) ?? null;
  const [row] = await l.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  l.tasks.set(id, row ?? null);
  return row ?? null;
}

function assigneeView(
  assignee: PayloadAssignee | undefined,
  displayNameByUserId: ReadonlyMap<number, string>,
): { kind: ProposalCardView['assigneeKind']; name: string | null } {
  if (assignee === undefined) return { kind: 'none', name: null };
  switch (assignee.type) {
    case 'all':
      return { kind: 'all', name: null };
    case 'none':
      return { kind: 'none', name: null };
    case 'text':
      return { kind: 'text', name: assignee.name };
    case 'user':
      return { kind: 'user', name: displayNameByUserId.get(assignee.userId) ?? null };
  }
}

/** Plain (not-yet-escaped — `renderProposalCard`'s `renderUpdateBody` escapes it) before/after text for an `update` card's assignee change, reusing the card's own `assigneeAll`/`assigneeNone` wording. */
function assigneeText(v: { kind: ProposalCardView['assigneeKind']; name: string | null }): string {
  if (v.kind === 'all') return texts.proposalCard.assigneeAll;
  if (v.name === null) return texts.proposalCard.assigneeNone;
  return v.name;
}

function dueText(due: { at: Date; allDay: boolean; tz: string | null } | null, viewerZone: string): string {
  return texts.formatDue(formatDue(due, viewerZone));
}

function payloadDueToView(due: z.infer<typeof DueSchema> | null | undefined): ProposalCardView['due'] {
  if (due === null || due === undefined || due.dueAt === null) return null;
  return { at: new Date(due.dueAt), allDay: due.allDay, tz: due.tz };
}

function currentTaskAssignee(task: TaskRow): PayloadAssignee {
  if (task.assigneeAll) return { type: 'all' };
  if (task.assigneeUserId !== null) return { type: 'user', userId: task.assigneeUserId };
  if (task.assigneeNameText !== null) return { type: 'text', name: task.assigneeNameText };
  return { type: 'none' };
}

interface BuildCtx {
  loaders: Loaders;
  displayNameByUserId: ReadonlyMap<number, string>;
  ownerZone: string;
  logger: AppDeps['logger'];
}

interface BuiltCard {
  view: ProposalCardView;
  noReaction: boolean;
}

/**
 * Turns one `proposals` row into a `ProposalCardView` (`src/bot/views/proposalCard.ts`, Task 2.11) ready
 * for `renderProposalCard`. Returns `null` — logging why, id-only (CLAUDE.md §8) — for anything this job
 * cannot safely render: an unparsable payload, or an `update`/`complete`/`cancel` proposal whose target is
 * itself still a pending proposal rather than a task (`payload.targetProposalId`, D44 — an explicitly open
 * business-rule question, not something to guess at here) or whose target task no longer exists. `null`
 * proposals are simply skipped this tick — `notified_at` stays empty, so a future tick retries them once
 * (for D44) the business rule lands, matching CLAUDE.md's "a missed task is worse than a false positive"
 * for every other proposal in the same run.
 */
async function buildCardView(ctx: BuildCtx, row: ProposalRow): Promise<BuiltCard | null> {
  const parsed = PayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    ctx.logger.error({ proposalId: row.id }, 'cardsJob: unparsable proposal payload, skipping this tick');
    return null;
  }
  const payload: ProposalPayload = parsed.data;

  const chat = row.chatId !== null ? await loadChat(ctx.loaders, row.chatId) : null;
  const firstSourceId = row.sourceMessageIds[0];
  const firstMessage =
    chat !== null && firstSourceId !== undefined ? await loadMessage(ctx.loaders, firstSourceId) : null;
  const link =
    chat !== null && firstMessage !== null
      ? messageLink({ type: chat.type, tgChatId: chat.tgChatId }, firstMessage.tgMessageId)
      : null;

  const manual = payload.origin !== 'ai';
  const category: Category | 'manual' | null = row.category;
  const noReaction = payload.noReaction === true;

  if (row.kind === 'create') {
    const assignee = assigneeView(payload.assignee, ctx.displayNameByUserId);
    const duplicateOf =
      payload.duplicateOf?.type === 'task'
        ? { taskId: payload.duplicateOf.id, title: payload.duplicateOf.title }
        : null;
    const view: ProposalCardView = {
      id: row.id,
      kind: 'create',
      category,
      confidence: row.confidence,
      manual,
      title: payload.title ?? '',
      assigneeName: assignee.name,
      assigneeKind: assignee.kind,
      due: payloadDueToView(payload.due),
      priority: payload.priority ?? 'normal',
      quote: payload.quote,
      quoteAuthor: payload.quoteAuthorName,
      chatTitle: chat?.title ?? null,
      link,
      dueInPast: payload.due?.inPast ?? false,
      duplicateOf,
      target: null,
    };
    return { view, noReaction };
  }

  // update / complete / cancel all target an existing task.
  if (row.targetTaskId === null) {
    ctx.logger.error(
      { proposalId: row.id, kind: row.kind },
      'cardsJob: proposal targets a pending proposal, not a task (D44) — skipping this tick',
    );
    return null;
  }
  const task = await loadTask(ctx.loaders, row.targetTaskId);
  if (task === null) {
    ctx.logger.error(
      { proposalId: row.id, targetTaskId: row.targetTaskId },
      'cardsJob: target task not found, skipping this tick',
    );
    return null;
  }

  if (row.kind === 'update') {
    const changes = payload.changes ?? {};
    let field: 'due' | 'assignee' | 'title' | null = null;
    let before: string | null = null;
    let after: string | null = null;
    if (changes.due !== undefined) {
      field = 'due';
      before = dueText(
        task.dueAt !== null ? { at: task.dueAt, allDay: task.dueAllDay, tz: task.dueTz } : null,
        ctx.ownerZone,
      );
      after = dueText(payloadDueToView(changes.due), ctx.ownerZone);
    } else if (changes.assignee !== undefined) {
      field = 'assignee';
      before = assigneeText(assigneeView(currentTaskAssignee(task), ctx.displayNameByUserId));
      after = assigneeText(assigneeView(changes.assignee, ctx.displayNameByUserId));
    } else if (changes.title !== undefined) {
      field = 'title';
      before = task.title;
      after = changes.title;
    }
    const view: ProposalCardView = {
      id: row.id,
      kind: 'update',
      category,
      confidence: row.confidence,
      manual,
      title: task.title,
      assigneeName: null,
      assigneeKind: 'none',
      due: null,
      priority: 'normal',
      quote: payload.quote,
      quoteAuthor: payload.quoteAuthorName,
      chatTitle: chat?.title ?? null,
      link,
      dueInPast: false,
      duplicateOf: null,
      target: { taskId: task.id, title: task.title, before, after, field },
    };
    return { view, noReaction };
  }

  const view: ProposalCardView = {
    id: row.id,
    kind: row.kind,
    category,
    confidence: row.confidence,
    manual,
    title: task.title,
    assigneeName: null,
    assigneeKind: 'none',
    due: null,
    priority: 'normal',
    quote: payload.quote,
    quoteAuthor: payload.quoteAuthorName,
    chatTitle: chat?.title ?? null,
    link,
    dueInPast: false,
    duplicateOf: null,
    target: { taskId: task.id, title: task.title, before: null, after: null, field: null },
  };
  return { view, noReaction };
}

type SendResult = { ok: true; messageId: number } | { ok: false; forbidden: boolean };

/** Sends one DM to the Owner, translating a `Messenger` failure into `SendResult` instead of throwing. Either way a failure means "stop sending for this tick, retry later" (the caller sets `blocked`); `forbidden` additionally means the Owner blocked the bot, so the caller also flips `users.dm_blocked` — see {@link handleSendFailure}. */
async function sendToOwner(
  deps: AppDeps,
  ownerTgUserId: number,
  text: string,
  buttons?: Buttons,
): Promise<SendResult> {
  try {
    const { messageId } = await deps.messenger.send(ownerTgUserId, text, buttons ? { buttons } : undefined);
    return { ok: true, messageId };
  } catch (err) {
    if (err instanceof MessengerError) {
      if (err.kind !== 'forbidden') {
        deps.logger.error({ err, kind: err.kind }, 'cardsJob: failed to send a card to the Owner');
      }
      return { ok: false, forbidden: err.kind === 'forbidden' };
    }
    throw err;
  }
}

/** Applies the one side effect a failed {@link sendToOwner} call needs — `users.dm_blocked=true` when the failure was `forbidden` — so every call site handles a failure the same way. */
async function handleSendFailure(
  deps: AppDeps,
  ownerId: number,
  result: Extract<SendResult, { ok: false }>,
): Promise<void> {
  if (result.forbidden) await markDmBlocked(deps.db, ownerId, true);
}

async function markCardSent(
  db: AppDeps['db'],
  proposalId: number,
  now: Date,
  messageId: number,
): Promise<void> {
  await db
    .update(proposals)
    .set({ notifiedAt: now, ownerDmMessageId: messageId })
    .where(and(eq(proposals.id, proposalId), eq(proposals.status, 'pending'), isNull(proposals.notifiedAt)));
}

async function markNotifiedOnly(db: AppDeps['db'], ids: number[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(proposals)
    .set({ notifiedAt: now })
    .where(and(inArray(proposals.id, ids), eq(proposals.status, 'pending'), isNull(proposals.notifiedAt)));
}

/**
 * SPEC §11.1/D-table: 👀 on the first source message of a freshly-carded, group-chat proposal — gated on
 * the chat's own `reactions_enabled`, the workspace's `reactions.onDetect` emoji being configured, and the
 * proposal not being flagged `noReaction` (Task 2.10's `/reanalyze` flag). Best-effort only: any failure —
 * `bad_request` or otherwise — is logged and swallowed, never undoing the card delivery that already
 * happened before this is called.
 */
async function reactToSource(
  deps: AppDeps,
  loaders: Loaders,
  row: ProposalRow,
  noReaction: boolean,
  onDetectEmoji: string | null,
): Promise<void> {
  if (onDetectEmoji === null || noReaction || row.chatId === null) return;
  const chat = await loadChat(loaders, row.chatId);
  if (chat === null || !chat.reactionsEnabled) return;
  const firstSourceId = row.sourceMessageIds[0];
  if (firstSourceId === undefined) return;
  const message = await loadMessage(loaders, firstSourceId);
  if (message === null) return;
  try {
    await deps.messenger.react(chat.tgChatId, message.tgMessageId, onDetectEmoji);
  } catch (err) {
    deps.logger.error({ err, proposalId: row.id }, 'cardsJob: failed to react to the source message');
  }
}

/**
 * The card outbox (plan.md Task 2.12, SPEC §11.1/§13.5, D10/D40): delivers every `shown`, still-`pending`,
 * not-yet-`notified_at` proposal to the Owner's DM — the only recipient (D40) — as individual cards
 * (`renderProposalCard`), capped at `MAX_CARDS_PER_BATCH` per `batch_id` group with one overflow message
 * for the rest, plus a 👀 reaction on each card's first source message. `notified_at` is set only *after*
 * a successful send (at-least-once delivery, brief step 3): a crash between sending and this update means
 * the next tick sends that card again rather than silently dropping it.
 *
 * Three gates run before any of that, in order:
 * 1. No Owner at all → superadmin alerted (`ErrorReporter.alert`'s own hourly throttle), nothing sent.
 * 2. The Owner has a membership but has never opened a DM (`users.dm_started_at IS NULL`, no `/start` yet)
 *    → same throttled alert, nothing sent (a real Telegram send would fail anyway — Telegram requires the
 *    user to have started the bot first).
 * 3. It is currently quiet hours in the Owner's own zone (`isQuietAt`, D10) → nothing sent at all this
 *    tick, not even proposals created outside quiet hours; they simply wait for a later, non-quiet tick.
 *
 * Once past those gates, eligible proposals split into two independent groups, each by their own
 * `created_at` (not "now" — D10's "cards created during the quiet period"): any whose `created_at` itself
 * fell inside quiet hours become one grouped "found while you were away" summary (any count, no per-batch
 * cap, no individual cards or reactions — SPEC §13.5); the rest go through the normal per-batch card flow.
 * A `forbidden` from `messenger.send` (the Owner blocked the bot) flips `users.dm_blocked` and stops the
 * rest of this tick's sends (their `notified_at` stays empty, retried later); any other send failure just
 * stops this tick's sends without touching `dm_blocked`.
 */
export const cardsJob: Job = {
  name: 'cards',
  async run(deps) {
    const now = deps.clock.now();

    const owner = await getOwner(deps.db, deps.workspace.id);
    if (!owner) {
      await deps.errors.alert('cards:no-owner', texts.cards.noOwner);
      return;
    }
    if (owner.user.dmStartedAt === null) {
      await deps.errors.alert('cards:owner-not-started', texts.cards.ownerNotStarted);
      return;
    }

    const settings = await getSettings(deps.db, deps.workspace.id);
    const zone = userZone(owner.user, deps.workspace);

    if (isQuietAt(now, zone, settings.quiet)) return;

    const eligible = await deps.db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.workspaceId, deps.workspace.id),
          eq(proposals.policyDecision, 'shown'),
          eq(proposals.status, 'pending'),
          isNull(proposals.notifiedAt),
        ),
      )
      .orderBy(asc(proposals.createdAt), asc(proposals.id));
    if (eligible.length === 0) return;

    const quietGroup: ProposalRow[] = [];
    const freshGroup: ProposalRow[] = [];
    for (const p of eligible) {
      (isQuietAt(p.createdAt, zone, settings.quiet) ? quietGroup : freshGroup).push(p);
    }

    const members = await listMembersWithUsers(deps.db, deps.workspace.id);
    const displayNameByUserId = new Map(members.map((m) => [m.user.id, m.membership.displayName]));
    const loaders = makeLoaders(deps.db);
    const buildCtx: BuildCtx = { loaders, displayNameByUserId, ownerZone: zone, logger: deps.logger };

    let blocked = false;

    if (quietGroup.length > 0) {
      const buttons: Buttons = [
        [{ text: texts.cards.openInboxButton, data: encodeCallback({ entity: 'p', action: 'nbx', id: 0 }) }],
      ];
      const result = await sendToOwner(
        deps,
        owner.user.tgUserId,
        texts.cards.quietBatch(quietGroup.length),
        buttons,
      );
      if (!result.ok) {
        await handleSendFailure(deps, owner.user.id, result);
        blocked = true;
      } else {
        await markNotifiedOnly(
          deps.db,
          quietGroup.map((p) => p.id),
          now,
        );
      }
    }

    if (!blocked && freshGroup.length > 0) {
      const groups = new Map<number | null, ProposalRow[]>();
      for (const p of freshGroup) {
        const key = p.batchId;
        const list = groups.get(key);
        if (list) list.push(p);
        else groups.set(key, [p]);
      }

      outer: for (const group of groups.values()) {
        const cardBatch = group.slice(0, MAX_CARDS_PER_BATCH);
        const overflow = group.slice(MAX_CARDS_PER_BATCH);

        for (const p of cardBatch) {
          const built = await buildCardView(buildCtx, p);
          if (built === null) continue;
          const { text, buttons } = renderProposalCard(built.view, zone);
          const result = await sendToOwner(deps, owner.user.tgUserId, text, buttons);
          if (!result.ok) {
            await handleSendFailure(deps, owner.user.id, result);
            break outer;
          }
          await markCardSent(deps.db, p.id, now, result.messageId);
          await reactToSource(deps, loaders, p, built.noReaction, settings.reactions.onDetect);
        }

        if (overflow.length > 0) {
          const result = await sendToOwner(
            deps,
            owner.user.tgUserId,
            texts.cards.moreProposals(overflow.length),
          );
          if (!result.ok) {
            await handleSendFailure(deps, owner.user.id, result);
            break outer;
          }
          await markNotifiedOnly(
            deps.db,
            overflow.map((p) => p.id),
            now,
          );
        }
      }
    }
  },
};
