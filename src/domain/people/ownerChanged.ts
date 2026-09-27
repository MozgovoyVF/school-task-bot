import type { DbOrTx } from '../../db/client.js';
import type { Logger } from '../../ops/logger.js';
import type { Messenger } from '../messenger.js';
import type { Clock } from '../../time/clock.js';
import { requestPendingApprovals } from '../chats/lifecycle.js';

/**
 * `afterOwnerChanged`'s dependencies. `messenger`/`clock` were added in
 * Task 1.6 for `requestPendingApprovals` (re-sending pending-chat approval
 * requests to the new owner); Task 1.11's `syncCommands` follow-up
 * (plan.md's Task 1.5 brief) may need further fields of its own.
 */
export interface OwnerChangedDeps {
  db: DbOrTx;
  logger: Logger;
  messenger: Messenger;
  clock: Clock;
}

/**
 * Runs after a successful `/claim` (ownership transfer or first bootstrap).
 * Logs the event — no PII, only the workspace id (CLAUDE.md §8) — and asks
 * `requestPendingApprovals` (`src/domain/chats/lifecycle.ts`, Task 1.6) to
 * send the new Owner approval requests for any chat that was left `pending`
 * with no Owner to ask yet. Task 1.11 adds `syncCommands` here too.
 */
export async function afterOwnerChanged(deps: OwnerChangedDeps, workspaceId: number): Promise<void> {
  deps.logger.info({ workspaceId }, 'owner changed');
  await requestPendingApprovals(deps, workspaceId);
}
