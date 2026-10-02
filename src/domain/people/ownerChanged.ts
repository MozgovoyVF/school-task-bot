import type { Db } from '../../db/client.js';
import type { Logger } from '../../ops/logger.js';
import type { Messenger } from '../messenger.js';
import type { Clock } from '../../time/clock.js';
import type { Env } from '../../config/env.js';
import { requestPendingApprovals } from '../chats/lifecycle.js';
import { getOpenTasksByWorkspace } from '../tasks/repo.js';
import { remindersHook } from '../notifications/schedule.js';

/**
 * `afterOwnerChanged`'s dependencies. `messenger`/`clock` were added in
 * Task 1.6 for `requestPendingApprovals` (re-sending pending-chat approval
 * requests to the new owner). `syncCommands` is Task 1.11's follow-up: the
 * freshly claimed Owner's DM chat needs its full `setMyCommands` scope
 * (re)published, since Telegram otherwise keeps whatever (or no) chat-scope
 * menu was cached for that chat before the claim. It is injected as a plain
 * no-arg callback rather than imported from `src/bot/commands.ts` directly —
 * that module performs real Telegram I/O (`api.setMyCommands(...)`), which
 * `domain/` must never do itself (CLAUDE.md §7: `domain/`, `ai/`, `time/`,
 * `scheduler/` never import grammY; Telegram sends go through `Messenger`).
 * The bot-layer caller (`src/bot/handlers/transfer.ts`'s `/claim` handler)
 * binds the real `syncCommands` (with `ctx.api`, the db and superadmin ids
 * already baked in) before calling `afterOwnerChanged` — the same
 * dependency-injection shape `messenger`/`clock` already use here. `config` is Task I3's own addition
 * (review round 2): `remindersHook.afterChange`'s own `deps` parameter is typed `Pick<AppDeps, 'clock' |
 * 'config'>` (`src/domain/tasks/service.ts`'s `TaskHook`), so calling it from here needs a real `Env`, not
 * just the `Pick<Env, 'SUPERADMIN_TG_IDS'>` `src/bot/handlers/transfer.ts` used to narrow it to — that
 * caller now passes its own full `Env` through unchanged (it already had one; only the declared type was
 * narrower). `db` is narrowed from `DbOrTx` to `Db`: every current and historical caller of
 * `afterOwnerChanged` passes a top-level `Db`, never a `Tx` (nothing wraps the `/claim` flow in one), and
 * this function now needs to open its own transaction below.
 */
export interface OwnerChangedDeps {
  db: Db;
  logger: Logger;
  messenger: Messenger;
  clock: Clock;
  config: Env;
  syncCommands: () => Promise<void>;
}

/**
 * Runs after a successful `/claim` (ownership transfer or first bootstrap).
 * Logs the event — no PII, only the workspace id (CLAUDE.md §8) — asks
 * `requestPendingApprovals` (`src/domain/chats/lifecycle.ts`, Task 1.6) to
 * send the new Owner approval requests for any chat that was left `pending`
 * with no Owner to ask yet; replans reminders for every open task so the
 * new Owner actually receives them without waiting for each task to be
 * individually edited first (D40 — every notification goes to the Owner,
 * always; review round 2, I3 part 2: `resolveNotification`'s own safety net
 * in `src/scheduler/jobs/notify.ts` only catches a *stale* row already
 * pointing at a former Owner, it can't conjure up a *new* one for the
 * incoming Owner); and (Task 1.11) calls `deps.syncCommands()` so the new
 * Owner's DM immediately shows their full command menu.
 *
 * The replan runs in its own transaction, separate from whatever already
 * committed `/claim` itself (`redeemClaimCode`) — all-open-tasks-replanned
 * or none, rather than partially replanned if interrupted mid-loop.
 * `remindersHook.afterChange` cancels each task's `scheduled` rows and
 * re-plans from `resolveRecipients`, which resolves to the *current* Owner
 * fresh every time — no special-casing for "old" vs "new" owner needed here.
 */
export async function afterOwnerChanged(deps: OwnerChangedDeps, workspaceId: number): Promise<void> {
  deps.logger.info({ workspaceId }, 'owner changed');
  await requestPendingApprovals(deps, workspaceId);

  await deps.db.transaction(async (tx) => {
    const openTasks = await getOpenTasksByWorkspace(tx, workspaceId);
    for (const task of openTasks) {
      await remindersHook.afterChange(
        tx,
        task,
        { type: 'updated', diff: {} },
        { clock: deps.clock, config: deps.config },
      );
    }
  });

  await deps.syncCommands();
}
