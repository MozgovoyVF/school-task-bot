import { texts } from '../texts/ru.js';
import type { Actor } from '../context.js';

export interface HelpView {
  text: string;
}

/**
 * Pure render for `/start`'s welcome overview: no DB, no I/O (CLAUDE.md §7).
 * Shown whenever `/start` does not need to run the first-run `/timezone`
 * picker (`src/bot/handlers/dm.ts` decides that based on `users.timezone`).
 */
export function renderStart(actor: Actor): HelpView {
  return { text: actor.isSuperadmin ? texts.start.superadmin() : texts.start.stranger() };
}

/**
 * Pure render for `/help`: a role-appropriate reminder of currently
 * available commands, distinct from `/start`'s welcome text (see
 * `texts.help`'s doc comment). No DB, no I/O (CLAUDE.md §7).
 */
export function renderHelp(actor: Actor): HelpView {
  if (actor.isSuperadmin) return { text: texts.help.superadmin() };
  if (actor.role !== null) return { text: texts.help.staff() };
  return { text: texts.help.stranger() };
}
