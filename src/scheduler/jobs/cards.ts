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
import { MessengerError, type Buttons, type MessengerErrorKind } from '../../domain/messenger.js';
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

/**
 * Whether `row` is flagged `noReaction` (Task 2.10's `/reanalyze` flag) — used on its own, independent of
 * `buildCardView`, because reactions (I2, fix round 1) run for every eligible proposal up front, before
 * this job decides whether/when to send its *card*, not just for the ones that get one. An unparsable
 * payload defaults to `false` (react anyway) rather than blocking the reaction on a card-rendering concern
 * that has nothing to do with whether the source message should get its 👀.
 */
function parseNoReaction(row: ProposalRow): boolean {
  const parsed = PayloadSchema.safeParse(row.payload);
  return parsed.success && parsed.data.noReaction === true;
}

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

/**
 * Turns one `proposals` row into a `ProposalCardView` (`src/bot/views/proposalCard.ts`, Task 2.11) ready
 * for `renderProposalCard`. Returns `null` — logging why (CLAUDE.md §8: id-only, never message text) —
 * for anything this job cannot safely render: an unparsable payload, or an `update`/`complete`/`cancel`
 * proposal whose target is itself still a pending proposal rather than a task (`payload.targetProposalId`,
 * D44 — an explicitly open business-rule question, not something to guess at here — logged at `warn`, not
 * `error`: it is an expected, recurring state until D44 is decided, not a bug) or whose target task no
 * longer exists (genuinely unexpected — logged at `error`). `null` proposals are simply skipped this tick —
 * `notified_at` stays empty, so a future tick retries them once (for D44) the business rule lands, matching
 * CLAUDE.md's "a missed task is worse than a false positive" for every other proposal in the same run.
 */
async function buildCardView(ctx: BuildCtx, row: ProposalRow): Promise<ProposalCardView | null> {
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
    return view;
  }

  // update / complete / cancel all target an existing task. `targetTaskId === null` normally means D44
  // (the action's real target is `payload.targetProposalId`, a still-pending proposal — checked explicitly
  // rather than inferred from `targetTaskId` alone, so a genuinely malformed row with neither id logs as
  // the distinct, actually-unexpected case below instead of being silently mislabeled as D44).
  if (row.targetTaskId === null) {
    if (payload.targetProposalId !== undefined) {
      ctx.logger.warn(
        { proposalId: row.id, kind: row.kind },
        'cardsJob: proposal targets a pending proposal, not a task (D44) — skipping this tick',
      );
    } else {
      ctx.logger.error(
        { proposalId: row.id, kind: row.kind },
        'cardsJob: non-create proposal has neither a target task nor a target proposal, skipping this tick',
      );
    }
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
    return view;
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
  return view;
}

type SendResult = { ok: true; messageId: number } | { ok: false; kind: MessengerErrorKind };

/** Sends one DM to the Owner, translating a `Messenger` failure into `SendResult` instead of throwing — never logs itself, so every call site can react to `result.kind` its own way (a single card's `bad_request` is not the same situation as a whole group's). */
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
    if (err instanceof MessengerError) return { ok: false, kind: err.kind };
    throw err;
  }
}

/**
 * The shared "stop sending for this group, retry later" reaction to a failed {@link sendToOwner} call
 * (used for the quiet-hours summary and the per-batch overflow message — a single card's `bad_request` is
 * handled separately inline, by `run`'s per-card loop, since that one is allowed to `continue` past it —
 * fix round 1, I1): `forbidden` means the Owner blocked the bot, so `users.dm_blocked` is flipped *and*
 * superadmin is alerted (throttled hourly, same pattern as the "Owner never started a DM" gate — fix round
 * 1, M4, previously missing); anything else is just logged.
 */
async function handleSendFailure(
  deps: AppDeps,
  ownerId: number,
  result: Extract<SendResult, { ok: false }>,
): Promise<void> {
  if (result.kind === 'forbidden') {
    await markDmBlocked(deps.db, ownerId, true);
    await deps.errors.alert('cards:owner-blocked', texts.cards.ownerBlocked);
  } else {
    deps.logger.error({ kind: result.kind }, 'cardsJob: failed to send to the Owner');
  }
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
 * SPEC §9/§11.1: 👀 on the first source message of a group-chat proposal — gated only on the chat's own
 * `reactions_enabled`, the workspace's `reactions.onDetect` emoji being configured, and the proposal not
 * being flagged `noReaction` (Task 2.10's `/reanalyze` flag). Deliberately *not* gated on quiet hours (fix
 * round 1, I2): SPEC §13.5's quiet-hours suppression list is summary/`pre_due`/`overdue`/proposal cards —
 * reactions aren't on it, and `run` below calls this for every eligible proposal up front, independent of
 * whether that proposal's *card* is delayed by quiet hours or fails to send. Best-effort only: any
 * failure — `bad_request` or otherwise — is logged and swallowed, never blocking anything else in this run.
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
 * The card outbox (plan.md Task 2.12, SPEC §9/§11.1/§13.5, D10/D40): delivers every `shown`, still-
 * `pending`, not-yet-`notified_at` proposal to the Owner's DM — the only recipient (D40) — as individual
 * cards (`renderProposalCard`), capped at `MAX_CARDS_PER_BATCH` per `batch_id` group with one overflow
 * message for the rest, plus a best-effort 👀 reaction on each proposal's first source message
 * (independent of card delivery — see `reactToSource`, fix round 1 I2). `notified_at` is set only *after*
 * a successful send (at-least-once delivery, brief step 3): a crash between sending and this update means
 * the next tick sends that card again rather than silently dropping it.
 *
 * Two gates run first: no Owner at all, or an Owner who has a membership but has never opened a DM
 * (`users.dm_started_at IS NULL`, no `/start` yet) both alert superadmin (`ErrorReporter.alert`'s own
 * hourly throttle) and send nothing at all, not even reactions (there is no card outbox to speak of yet).
 *
 * Past those, every eligible proposal gets its reaction attempt regardless of anything else — quiet hours,
 * batch grouping, or whether its own card ever sends. Only *card* delivery is gated on quiet hours
 * (`isQuietAt(now, …)`, D10): while it is currently quiet in the Owner's zone, no card or summary is sent
 * this tick (they simply wait). Once past that, eligible proposals split into two groups by their own
 * `created_at` (not "now" — D10's "cards created during the quiet period"): any whose `created_at` itself
 * fell inside quiet hours become one grouped "found while you were away" summary (any count, no per-batch
 * cap, no individual cards — SPEC §13.5); the rest go through the normal per-batch card flow.
 *
 * Send failures: `forbidden` (the Owner blocked the bot) flips `users.dm_blocked`, alerts superadmin
 * (throttled, fix round 1 M4) and stops the rest of this tick's sends. For the per-card loop specifically,
 * `bad_request` on one card (fix round 1, I1 — e.g. Telegram rejecting its HTML or an oversized keyboard)
 * is reported (`errors.report`, deduped/throttled by its own fingerprint) and that one card is skipped —
 * `notified_at` stays empty for a future retry — without blocking every other card behind it in the queue.
 * Any other failure (`rate_limited`/`network`/`other`) stops the tick's sends, same as `forbidden` minus the
 * `dm_blocked` flip.
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

    const loaders = makeLoaders(deps.db);

    // Reactions run for every eligible proposal up front — before the quiet-hours gate below, and even for
    // ones whose card will end up delayed or skipped — since SPEC gates 👀 only on the chat's own
    // `reactions_enabled`, never on quiet hours or card-delivery outcome (fix round 1, I2). Re-attempted
    // each tick until the proposal's card finally sends (there is no separate "already reacted" column to
    // dedupe against); Telegram's reaction API is idempotent for the same emoji, so this is wasted calls at
    // worst, never a duplicate user-visible effect.
    for (const p of eligible) {
      await reactToSource(deps, loaders, p, parseNoReaction(p), settings.reactions.onDetect);
    }

    if (isQuietAt(now, zone, settings.quiet)) return;

    const quietGroup: ProposalRow[] = [];
    const freshGroup: ProposalRow[] = [];
    for (const p of eligible) {
      (isQuietAt(p.createdAt, zone, settings.quiet) ? quietGroup : freshGroup).push(p);
    }

    const members = await listMembersWithUsers(deps.db, deps.workspace.id);
    const displayNameByUserId = new Map(members.map((m) => [m.user.id, m.membership.displayName]));
    const buildCtx: BuildCtx = { loaders, displayNameByUserId, ownerZone: zone, logger: deps.logger };

    let blocked = false;

    if (quietGroup.length > 0) {
      const buttons: Buttons = [
        [
          {
            // No handler for `nbx` exists yet — a forward reference to Task 2.15's `/inbox`, which is
            // expected to add it. Not a bug: the button is simply inert until then.
            text: texts.cards.openInboxButton,
            data: encodeCallback({ entity: 'p', action: 'nbx', id: 0 }),
          },
        ],
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
          const view = await buildCardView(buildCtx, p);
          if (view === null) continue;
          const { text, buttons } = renderProposalCard(view, zone);
          const result = await sendToOwner(deps, owner.user.tgUserId, text, buttons);
          if (!result.ok) {
            if (result.kind === 'bad_request') {
              deps.logger.error(
                { proposalId: p.id },
                'cardsJob: Telegram rejected this card (bad_request) — skipping it, not blocking the rest of the tick',
              );
              await deps.errors.report(new Error('cardsJob: bad_request sending a proposal card'), {
                proposalId: p.id,
              });
              continue;
            }
            await handleSendFailure(deps, owner.user.id, result);
            break outer;
          }
          await markCardSent(deps.db, p.id, now, result.messageId);
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
