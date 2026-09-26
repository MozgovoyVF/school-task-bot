import { texts } from '../texts/ru.js';
import type { Actor } from '../context.js';

export interface HelpView {
  text: string;
}

/** Pure render for `/start` and `/help`: no DB, no I/O (CLAUDE.md §7). */
export function renderHelp(actor: Actor): HelpView {
  return { text: actor.isSuperadmin ? texts.start.superadmin() : texts.start.stranger() };
}
