import type { Env } from './config/env.js';
import type { Db } from './db/client.js';
import type { Clock } from './time/clock.js';
import type { Logger } from './ops/logger.js';
import type { ErrorReporter } from './ops/errorReporter.js';
import type { Messenger } from './domain/messenger.js';

/**
 * Forward-declared placeholder for the real `AiProviders` interface (phase 2,
 * plan.md ~line 1635: `export interface AiProviders { extraction:
 * ExtractionProvider; decision: DecisionProvider | null; client:
 * ChatCompletionClient; models: { primary: string; fallback: string | null }
 * }`). `src/ai/**` doesn't exist yet in phase 0, and `deps.ai` is *always*
 * `null` until phase 2 wires up `AI_PREFILTER`/`OPENROUTER_API_KEY` handling,
 * so this placeholder only has to make `ai: AiProviders | null` type-check
 * today. See plan.md decision D32. Delete this interface and import the real
 * one (from `src/ai/providers/index.ts` or wherever phase 2 puts it) once it
 * exists — `AppDeps` below needs no other change, since `AiProviders | null`
 * stays syntactically the same.
 */
export interface AiProviders {
  readonly __placeholder?: never;
}

/**
 * Forward-declared placeholder for the real `TaskHook` interface (phase 2,
 * plan.md ~line 166, `src/domain/tasks/service.ts`): `{ name: string;
 * afterChange(tx: Tx, task: TaskRow | null, change: TaskChange, deps:
 * Pick<AppDeps, 'clock' | 'config'>): Promise<void> }`. `TaskChange` doesn't
 * exist yet either. `deps.taskHooks` is *always* `[]` until phase 2 (tasks
 * service) and phase 5 (Apple Reminders `SyncTarget`) register real hooks, so
 * this placeholder only has to make `taskHooks: TaskHook[]` type-check for an
 * always-empty array today. See plan.md decision D32. Delete this interface
 * and import the real one from `src/domain/tasks/service.ts` once it exists.
 */
export interface TaskHook {
  readonly name: string;
}

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
  /** `null` whenever `OPENROUTER_API_KEY`/`LLM_MODEL_PRIMARY` are unset — AI analysis is then disabled. */
  ai: AiProviders | null;
  /** Filled in by phase 3 (reminders) and phase 5 (`SyncTarget`); always `[]` before that. */
  taskHooks: TaskHook[];
}
