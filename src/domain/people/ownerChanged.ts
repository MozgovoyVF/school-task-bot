import type { DbOrTx } from '../../db/client.js';
import type { Logger } from '../../ops/logger.js';

/**
 * `afterOwnerChanged`'s dependencies. `db` is unused by this task's
 * log-only body but is threaded through now, since Task 1.6 needs it for
 * `requestPendingApprovals` (re-sending pending-chat approval requests to
 * the new owner) and Task 1.11 for `syncCommands` — both dependency-bearing
 * follow-ups this same function grows into (plan.md's Task 1.5 brief).
 */
export interface OwnerChangedDeps {
  db: DbOrTx;
  logger: Logger;
}

/**
 * Runs after a successful `/claim` (ownership transfer or first bootstrap).
 * This task's body only logs the event — no PII, only the workspace id
 * (CLAUDE.md §8). Task 1.6 adds `requestPendingApprovals` here, Task 1.11
 * adds `syncCommands`, each covered by its own test.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- kept async: this grows real awaits in Tasks 1.6/1.11
export async function afterOwnerChanged(deps: OwnerChangedDeps, workspaceId: number): Promise<void> {
  deps.logger.info({ workspaceId }, 'owner changed');
}
