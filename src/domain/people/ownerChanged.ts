import type { DbOrTx } from '../../db/client.js';
import type { Logger } from '../../ops/logger.js';
import type { Messenger } from '../messenger.js';
import type { Clock } from '../../time/clock.js';
import { requestPendingApprovals } from '../chats/lifecycle.js';

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
 * dependency-injection shape `messenger`/`clock` already use here.
 */
export interface OwnerChangedDeps {
  db: DbOrTx;
  logger: Logger;
  messenger: Messenger;
  clock: Clock;
  syncCommands: () => Promise<void>;
}

/**
 * Runs after a successful `/claim` (ownership transfer or first bootstrap).
 * Logs the event — no PII, only the workspace id (CLAUDE.md §8) — asks
 * `requestPendingApprovals` (`src/domain/chats/lifecycle.ts`, Task 1.6) to
 * send the new Owner approval requests for any chat that was left `pending`
 * with no Owner to ask yet, and (Task 1.11) calls `deps.syncCommands()` so
 * the new Owner's DM immediately shows their full command menu.
 */
export async function afterOwnerChanged(deps: OwnerChangedDeps, workspaceId: number): Promise<void> {
  deps.logger.info({ workspaceId }, 'owner changed');
  await requestPendingApprovals(deps, workspaceId);
  await deps.syncCommands();
}
