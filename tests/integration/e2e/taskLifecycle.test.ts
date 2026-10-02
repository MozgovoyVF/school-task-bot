import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, groupText, callback, botKeyboardMessage } from '../../helpers/updates.js';
import { encodeCallback, decodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import {
  upsertTelegramUser,
  setUserTimezone,
  listMembersWithUsers,
} from '../../../src/domain/people/repo.js';
import { upsertChatOnAdd } from '../../../src/domain/chats/repo.js';
import { memberships, tasks, proposals, notifications } from '../../../src/db/schema/index.js';
import type { FakeMessenger } from '../../helpers/fakeMessenger.js';
import { createTicker } from '../../../src/scheduler/ticker.js';
import { pendingChatsJob } from '../../../src/scheduler/jobs/pendingChats.js';
import { analyzeJob } from '../../../src/scheduler/jobs/analyze.js';
import { cardsJob } from '../../../src/scheduler/jobs/cards.js';
import { notifyJob } from '../../../src/scheduler/jobs/notify.js';
import { ensureSummariesJob } from '../../../src/scheduler/jobs/summary.js';
import { expireProposalsJob } from '../../../src/scheduler/jobs/expireProposals.js';
import { retentionJob } from '../../../src/scheduler/jobs/retention.js';
import { remindersHook } from '../../../src/domain/notifications/schedule.js';
import { LlmExtractionProvider } from '../../../src/ai/pipeline/extract.js';
import { FixtureClient } from '../../../src/ai/providers/fixture.js';
import type { AiProviders, CompletionResponse } from '../../../src/ai/providers/types.js';

// plan.md Task 3.14: the phase's own acceptance scenario — a single task's life from a group message to
// `/archive`, driven entirely through the real bot (`createBotHarness`) and the real scheduler (`createTicker`
// built from the same jobs `src/app.ts` registers), never by poking domain functions directly. Every
// LLM call is a scripted `FixtureClient` response (CLAUDE.md — no real LLM calls in tests); every other step
// is the actual Telegram update a real client would send. D40 (notifications only ever reach the Owner) is
// the scenario's own spine, not a side assertion: Мария's DM inbox is checked to stay exactly as it was
// right after her own `/start`, for the whole run.

const OWNER = { id: 100, firstName: 'Анна' };
const MARIA = { id: 200, firstName: 'Мария' };
const GROUP = { id: -1009999, type: 'supergroup' as const, title: 'Учительская' };

function fake(harness: BotHarness): FakeMessenger {
  return harness.deps.messenger as FakeMessenger;
}

/** `v1:n:*` (reminder DM buttons, Task 3.4). */
function n(action: string, taskId: number): string {
  return encodeCallback({ entity: 'n', action, id: taskId });
}

/** `v1:p:*` (proposal decision buttons, Task 2.13). */
function p(action: string, proposalId: number): string {
  return encodeCallback({ entity: 'p', action, id: proposalId });
}

function response(content: string): CompletionResponse {
  return {
    content,
    usage: { inputTokens: 40, outputTokens: 20, costUsd: 0.0002 },
    model: 'fixture/primary',
    raw: {},
  };
}

function extractorFrom(script: ReadonlyArray<CompletionResponse | Error>): AiProviders['extraction'] {
  return new LlmExtractionProvider(new FixtureClient(script), {
    primary: 'fixture/primary',
    fallback: null,
    jsonSchema: null,
  });
}

async function makeMember(
  harness: BotHarness,
  tgUser: { id: number; firstName: string },
  role: 'owner' | 'member',
) {
  const user = await upsertTelegramUser(harness.db, { id: tgUser.id, first_name: tgUser.firstName });
  await harness.db.insert(memberships).values({
    workspaceId: harness.deps.workspace.id,
    userId: user.id,
    role,
    displayName: tgUser.firstName,
  });
  return user;
}

/** The scenario only ever has at most one `pending` proposal of a given `kind` alive at a time. */
async function pendingProposal(harness: BotHarness, kind: 'create' | 'complete') {
  const rows = await harness.db.select().from(proposals).where(eq(proposals.status, 'pending'));
  const match = rows.find((r) => r.kind === kind);
  if (!match) throw new Error(`no pending '${kind}' proposal found (${String(rows.length)} pending total)`);
  return match;
}

async function taskNotifications(harness: BotHarness, taskId: number) {
  return harness.db.select().from(notifications).where(eq(notifications.taskId, taskId));
}

interface RenderedButton {
  text: string;
  callback_data?: string;
}

/** `/start`'s first-run `/timezone` picker (Task 1.4) is a conversation that swallows every update from
 * that user until it gets a `v1:z:*` button press — this clicks "Оставить: <workspace default>" so the
 * rest of the scenario's updates from `tgUser` reach their real handlers instead of the picker's
 * "нажмите одну из кнопок" fallback (mirrors `tests/integration/bot/timezone.test.ts`'s own helpers). */
async function finishFirstRunTimezone(harness: BotHarness, tgUser: { id: number; firstName: string }) {
  const sendCalls = harness.calls.filter(
    (c) => c.method === 'sendMessage' && c.payload.chat_id === tgUser.id,
  );
  const last = sendCalls[sendCalls.length - 1];
  const markup = last?.payload.reply_markup as { inline_keyboard?: RenderedButton[][] } | undefined;
  const keepDefaultButton = markup?.inline_keyboard?.[0]?.[0];
  if (!keepDefaultButton?.callback_data) throw new Error(`no zone picker keyboard for ${String(tgUser.id)}`);
  const decoded = decodeCallback(keepDefaultButton.callback_data);
  if (decoded?.action !== 'def')
    throw new Error(`expected the "keep default" zone button for ${String(tgUser.id)}`);
  await harness.send(callback(tgUser, keepDefaultButton.callback_data, botKeyboardMessage(tgUser)));
}

describe('task lifecycle acceptance scenario (plan.md Task 3.14, SPEC §12/§13, D6/D7/D40)', () => {
  it(
    'a group assignment survives card accept, pre_due+snooze, due, a review-complete card, and ' +
      'closing — with Мария never receiving a single DM, and the Owner’s summary only firing at her own ' +
      'local 09:00',
    async () => {
      // Wed 2026-09-23, 12:00 MSK (the harness's own default clock — also a Wednesday, so "к пятнице
      // 18:00" lands on 2026-09-25, exactly plan.md's own worked example).
      const harness = await createBotHarness();
      const ticker = createTicker(harness.deps, [
        pendingChatsJob,
        analyzeJob,
        cardsJob,
        notifyJob,
        ensureSummariesJob,
        expireProposalsJob,
        retentionJob,
      ]);
      // `tests/helpers/botHarness.ts` always builds `taskHooks: []` — this scenario needs the real
      // reminders hook (Task 3.2) wired in, exactly as `src/app.ts` does, for `acceptProposal`'s
      // `TaskService.create` to actually schedule `pre_due`/`due`/`overdue`. `deps.taskHooks` is read
      // fresh off this same array by every handler on every call (never snapshotted at bot-construction
      // time), so pushing onto it here reaches every handler already registered.
      harness.deps.taskHooks.push(remindersHook);

      const owner = await makeMember(harness, OWNER, 'owner');
      const maria = await makeMember(harness, MARIA, 'member');
      await upsertChatOnAdd(harness.db, {
        tgChatId: GROUP.id,
        title: GROUP.title,
        type: 'supergroup',
        workspaceId: harness.deps.workspace.id,
        addedByUserId: owner.id,
        status: 'active',
        pendingSince: null,
        now: harness.clock.now(),
      });

      const members = await listMembersWithUsers(harness.db, harness.deps.workspace.id);
      const mariaCode = `P${String(members.findIndex((m) => m.user.id === maria.id) + 1)}`;

      // Both Owner and Мария already use the bot in DM (D40's own precondition — nothing sent to Мария
      // is never explained by "the bot can't reach her").
      await harness.send(dmText(OWNER, '/start'));
      await finishFirstRunTimezone(harness, OWNER);
      await harness.send(dmText(MARIA, '/start'));
      await finishFirstRunTimezone(harness, MARIA);
      const mariaSentBaseline = fake(harness).sent.filter((m) => m.chatId === MARIA.id).length;
      const mariaEditsBaseline = fake(harness).edits.filter((m) => m.chatId === MARIA.id).length;
      const mariaApiBaseline = harness.calls.filter(
        (c) =>
          (c.method === 'sendMessage' || c.method === 'editMessageText') && c.payload.chat_id === MARIA.id,
      ).length;

      // Checked after every task-related step: Мария's DM (both `deps.messenger` — reminders/cards/summary
      // all go through it — and, belt-and-braces, raw `bot.api`/`ctx.reply` calls) never grows past
      // whatever her own `/start` produced (D40).
      function assertMariaInboxUnchanged(step: string): void {
        expect(
          fake(harness).sent.filter((m) => m.chatId === MARIA.id),
          step,
        ).toHaveLength(mariaSentBaseline);
        expect(
          fake(harness).edits.filter((m) => m.chatId === MARIA.id),
          step,
        ).toHaveLength(mariaEditsBaseline);
        expect(
          harness.calls.filter(
            (c) =>
              (c.method === 'sendMessage' || c.method === 'editMessageText') &&
              c.payload.chat_id === MARIA.id,
          ),
          step,
        ).toHaveLength(mariaApiBaseline);
      }

      // --- Step 1: the Owner assigns Мария a task in the group, Среда 12:00 МСК ---
      harness.deps.ai = {
        extraction: extractorFrom([
          response(
            JSON.stringify({
              actions: [
                {
                  type: 'create',
                  category: 'assignment',
                  title: 'Подготовить расписание',
                  description: null,
                  assignee_ref: mariaCode,
                  assignee_name_text: null,
                  due: { due_local: '2026-09-25T18:00', time_hint: 'none', due_text: 'к пятнице 18:00' },
                  priority: 'normal',
                  target_ref: null,
                  source_message_ids: ['M1'],
                  confidence: 0.9,
                  reasoning: 'поручение Маше с дедлайном в пятницу 18:00',
                },
              ],
            }),
          ),
        ]),
        decision: null,
        client: {
          complete: () => Promise.reject(new Error('client.complete should not be called directly')),
        },
        models: { primary: 'fixture/primary', fallback: null },
      };

      await harness.send(groupText(GROUP, OWNER, 'Маша, подготовь расписание к пятнице 18:00'));

      // Advance past the 180s quiet period (SPEC §8) and tick: analyzeJob batches + extracts, cardsJob
      // delivers the resulting card to the Owner's DM.
      harness.clock.set('2026-09-23T12:03:01+03:00');
      await ticker.tickOnce();

      const createProposal = await pendingProposal(harness, 'create');
      expect(createProposal.chatId).not.toBeNull();

      await harness.send(callback(OWNER, p('acc', createProposal.id), botKeyboardMessage(OWNER)));

      const [task] = await harness.db
        .select()
        .from(tasks)
        .where(eq(tasks.workspaceId, harness.deps.workspace.id));
      if (!task) throw new Error('expected the accepted proposal to have created a task');
      expect(task.status).toBe('open');
      expect(task.assigneeUserId).toBe(maria.id);
      expect(task.dueAt?.toISOString()).toBe(new Date('2026-09-25T15:00:00Z').toISOString()); // Fri 18:00 MSK
      expect(task.dueAllDay).toBe(false);

      // D6/D7: pre_due (Thu 10:00 MSK), due (Fri 18:00 MSK) and overdue (Sat 10:00 MSK) are all planned,
      // all for the Owner only.
      const plannedAtCreate = await taskNotifications(harness, task.id);
      expect(plannedAtCreate.map((n_) => n_.kind).sort()).toEqual(['due', 'overdue', 'pre_due']);
      for (const row of plannedAtCreate) expect(row.recipientUserId).toBe(owner.id);
      const preDueAtCreate = plannedAtCreate.find((n_) => n_.kind === 'pre_due');
      expect(preDueAtCreate?.fireAt.toISOString()).toBe(new Date('2026-09-24T07:00:00Z').toISOString());
      const overdueAtCreate = plannedAtCreate.find((n_) => n_.kind === 'overdue');
      expect(overdueAtCreate?.fireAt.toISOString()).toBe(new Date('2026-09-26T07:00:00Z').toISOString());

      // --- Step 2: Мария (DM started) receives nothing — no assignment DM, nothing at all yet ---
      assertMariaInboxUnchanged('right after task creation');

      // --- Step 3: Четверг 10:00 МСК — pre_due reaches the Owner ---
      harness.clock.set('2026-09-24T10:00:00+03:00');
      await ticker.tickOnce();

      const afterPreDue = await taskNotifications(harness, task.id);
      const preDueRow = afterPreDue.find((n_) => n_.kind === 'pre_due');
      expect(preDueRow?.status).toBe('sent');
      assertMariaInboxUnchanged('after pre_due');

      // --- Step 4: Owner taps "⏰ +1 час" — a snooze fires at 11:00 МСК ---
      await harness.send(callback(OWNER, n('hour', task.id), botKeyboardMessage(OWNER)));
      const afterSnoozeCreated = await taskNotifications(harness, task.id);
      const snoozeRow = afterSnoozeCreated.find((n_) => n_.kind === 'snooze');
      expect(snoozeRow?.status).toBe('scheduled');
      expect(snoozeRow?.recipientUserId).toBe(owner.id);
      expect(snoozeRow?.fireAt.toISOString()).toBe(new Date('2026-09-24T08:00:00Z').toISOString()); // 11:00 MSK

      harness.clock.set('2026-09-24T11:00:00+03:00');
      await ticker.tickOnce();
      const afterSnoozeSent = await taskNotifications(harness, task.id);
      expect(afterSnoozeSent.find((n_) => n_.kind === 'snooze')?.status).toBe('sent');
      assertMariaInboxUnchanged('after the snooze reminder');

      // --- Step 5: Пятница 18:00 МСК — due reaches the Owner ---
      harness.clock.set('2026-09-25T18:00:00+03:00');
      await ticker.tickOnce();
      const afterDue = await taskNotifications(harness, task.id);
      expect(afterDue.find((n_) => n_.kind === 'due')?.status).toBe('sent');
      assertMariaInboxUnchanged('after due');

      // --- Step 6: Мария replies "сделала" in the group — the Owner gets a close-task proposal ---
      harness.deps.ai = {
        extraction: extractorFrom([
          response(
            JSON.stringify({
              actions: [
                {
                  type: 'complete',
                  target_ref: `T${String(task.id)}`,
                  source_message_ids: ['M1'],
                  confidence: 0.9,
                  reasoning: 'Мария отчиталась о выполнении в ответ на поручение',
                },
              ],
            }),
          ),
        ]),
        decision: null,
        client: {
          complete: () => Promise.reject(new Error('client.complete should not be called directly')),
        },
        models: { primary: 'fixture/primary', fallback: null },
      };

      harness.clock.set('2026-09-25T18:05:00+03:00');
      await harness.send(groupText(GROUP, MARIA, 'сделала'));

      harness.clock.set('2026-09-25T18:08:01+03:00');
      await ticker.tickOnce();

      const completeProposal = await pendingProposal(harness, 'complete');
      expect(completeProposal.targetTaskId).toBe(task.id);

      // --- Step 7: Owner taps "✅ Закрыть задачу" — the task closes and its own overdue is cancelled ---
      await harness.send(callback(OWNER, p('apl', completeProposal.id), botKeyboardMessage(OWNER)));

      const [closedTask] = await harness.db.select().from(tasks).where(eq(tasks.id, task.id));
      expect(closedTask?.status).toBe('done');
      expect(closedTask?.completedByUserId).toBe(owner.id);

      const afterClose = await taskNotifications(harness, task.id);
      for (const row of afterClose) {
        if (row.status === 'sent') continue; // pre_due/snooze/due already delivered, left as-is
        expect(row.status).toBe('cancelled');
      }
      const stillScheduled = afterClose.filter((row) => row.status === 'scheduled');
      expect(stillScheduled).toHaveLength(0);

      // Саб 10:00 МСК — the overdue chain's own original fire time — nothing is sent for this task.
      harness.clock.set('2026-09-26T10:00:00+03:00');
      await ticker.tickOnce();
      const afterSaturday = await taskNotifications(harness, task.id);
      expect(afterSaturday.filter((row) => row.status === 'sent')).toHaveLength(3); // pre_due, snooze, due only

      assertMariaInboxUnchanged('after closing the task');

      // The task is visible in /archive.
      await harness.send(dmText(OWNER, '/archive'));
      const archiveReply = harness.replies(OWNER.id).at(-1);
      expect(archiveReply).toContain(`T${String(task.id)}`);

      // --- Step 8: the Owner's own summary fires at her *local* 09:00 (Asia/Yekaterinburg = 04:00Z) ---
      // `ensureSummariesJob` has already been self-healing a daily 09:00-MSK summary since Wednesday (it
      // runs every tick, like the real ticker) — by now there are already several `sent` rows from those
      // earlier Europe/Moscow mornings, so the assertions below track one specific row (the first one
      // `ensureSummariesJob` schedules for the Owner's *new* zone), not "any summary row ever".
      await setUserTimezone(harness.db, owner.id, 'Asia/Yekaterinburg');
      harness.clock.set('2026-09-26T10:00:01+03:00');
      await ticker.tickOnce(); // lets ensureSummariesJob notice the zone change and reschedule

      const expectedFireAt = new Date('2026-09-27T04:00:00Z'); // next 09:00 Asia/Yekaterinburg after the reschedule
      const rescheduled = (
        await harness.db.select().from(notifications).where(eq(notifications.kind, 'summary'))
      ).find((row) => row.status === 'scheduled' && row.fireAt.getTime() === expectedFireAt.getTime());
      if (!rescheduled)
        throw new Error('expected ensureSummariesJob to reschedule for Asia/Yekaterinburg 09:00');

      harness.clock.set('2026-09-27T03:59:00Z');
      await ticker.tickOnce();
      const [beforeTime] = await harness.db
        .select()
        .from(notifications)
        .where(eq(notifications.id, rescheduled.id));
      expect(beforeTime?.status).toBe('scheduled');

      harness.clock.set('2026-09-27T04:00:00Z');
      await ticker.tickOnce();
      const [atTime] = await harness.db
        .select()
        .from(notifications)
        .where(eq(notifications.id, rescheduled.id));
      expect(atTime?.status).toBe('sent');
      expect(atTime?.recipientUserId).toBe(owner.id);
      expect(atTime?.fireAt.toISOString()).toBe(expectedFireAt.toISOString());

      assertMariaInboxUnchanged('at the very end of the scenario, including the Owner’s own summary');
    },
  );
});
