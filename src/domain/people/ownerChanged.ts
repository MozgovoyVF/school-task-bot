import type { DbOrTx } from '../../db/client.js';
import type { Logger } from '../../ops/logger.js';
import type { Messenger } from '../messenger.js';
import type { Clock } from '../../time/clock.js';
import { requestPendingApprovals } from '../chats/lifecycle.js';
// `domain/` importing from `bot/commands.ts` (not grammY itself — see that
// module's `CommandsApi` doc comment) mirrors the documented exception
// `chats/lifecycle.ts` already takes for `bot/texts`/`bot/views` (CLAUDE.md
// §7): `syncCommands` is the only place that knows how to rebuild every
// `setMyCommands` scope, and there is no bot-layer caller left in the loop
// once `/claim`'s handler has already handed off to this function.
import { syncCommands, type CommandsApi } from '../../bot/commands.js';

/**
 * `afterOwnerChanged`'s dependencies. `messenger`/`clock` were added in
 * Task 1.6 for `requestPendingApprovals` (re-sending pending-chat approval
 * requests to the new owner); `api`/`superadminIds` are Task 1.11's
 * `syncCommands` follow-up — the freshly claimed Owner's DM chat needs its
 * full `setMyCommands` scope (re)published, since Telegram otherwise keeps
 * whatever (or no) chat-scope menu was cached for that chat before the claim.
 */
export interface OwnerChangedDeps {
  db: DbOrTx;
  logger: Logger;
  messenger: Messenger;
  clock: Clock;
  api: CommandsApi;
  superadminIds: number[];
}

/**
 * Runs after a successful `/claim` (ownership transfer or first bootstrap).
 * Logs the event — no PII, only the workspace id (CLAUDE.md §8) — asks
 * `requestPendingApprovals` (`src/domain/chats/lifecycle.ts`, Task 1.6) to
 * send the new Owner approval requests for any chat that was left `pending`
 * with no Owner to ask yet, and (Task 1.11) refreshes every `setMyCommands`
 * scope via `syncCommands` so the new Owner's DM immediately shows their
 * full command menu.
 */
export async function afterOwnerChanged(deps: OwnerChangedDeps, workspaceId: number): Promise<void> {
  deps.logger.info({ workspaceId }, 'owner changed');
  await requestPendingApprovals(deps, workspaceId);
  await syncCommands(
    { db: deps.db, workspace: { id: workspaceId }, superadminIds: deps.superadminIds },
    deps.api,
  );
}
