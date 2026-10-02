import type { Env } from './config/env.js';
import type { Db } from './db/client.js';
import type { Clock } from './time/clock.js';
import type { Logger } from './ops/logger.js';
import type { ErrorReporter } from './ops/errorReporter.js';
import type { Messenger } from './domain/messenger.js';
import type { WorkspaceRow } from './domain/workspaces/repo.js';
import type { AiProviders } from './ai/providers/types.js';
import type { TaskHook } from './domain/tasks/service.js';

// plan.md decision D32: the phase-0 placeholder `AiProviders` (`{ readonly
// __placeholder?: never }`) is gone — Task 2.9 is the first consumer that
// actually calls `deps.ai.extraction`/`deps.ai.decision` (its `analyzeJob`),
// so this now re-exports the real interface from `src/ai/providers/types.ts`
// (built in Task 2.4). `AppDeps` below is unchanged: `ai: AiProviders |
// null` still type-checks the same way, and `deps.ai` is still `null`
// whenever `src/app.ts` decides AI analysis is disabled (no
// `OPENROUTER_API_KEY`/`LLM_MODEL_PRIMARY`) — `src/app.ts` does not yet
// construct a real `AiProviders` from env; that wiring is still to come.
export type { AiProviders };

// plan.md decision D32: the phase-0 placeholder `TaskHook` (`{ readonly name:
// string }`) is gone — Task 2.13 is where the real `TaskHook`/`TaskChange`
// contract (`{ name; afterChange(tx, task, change, deps) }`) is built, in
// `src/domain/tasks/service.ts`, so this now re-exports it from there.
// `AppDeps` below is unchanged: `taskHooks: TaskHook[]` still type-checks the
// same way. Phase 3 is done: `src/app.ts` now registers the real reminders
// hook (`taskHooks: [remindersHook]`); phase 5 (Apple Reminders `SyncTarget`)
// still has to add its own hook to that array.
export type { TaskHook };

/**
 * The application's single dependency bag: the composition root
 * (`src/app.ts`) builds exactly one of these and threads it through the bot,
 * scheduler and http layers. See CLAUDE.md §7 for the module boundaries this
 * is meant to enforce (domain/ai/time/scheduler never import grammY; they go
 * through `messenger`/`clock` instead).
 */
export interface AppDeps {
  config: Env;
  db: Db;
  clock: Clock;
  logger: Logger;
  errors: ErrorReporter;
  messenger: Messenger;
  /** The single default workspace (MVP, SPEC §5.2), created by `ensureDefaultWorkspace` in `startApp`. */
  workspace: WorkspaceRow;
  /** `null` whenever `OPENROUTER_API_KEY`/`LLM_MODEL_PRIMARY` are unset — AI analysis is then disabled. */
  ai: AiProviders | null;
  /** Filled in by phase 3 (reminders) and phase 5 (`SyncTarget`); always `[]` before that. */
  taskHooks: TaskHook[];
}
