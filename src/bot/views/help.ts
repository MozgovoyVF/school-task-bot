import type { BotCommand } from 'grammy/types';
import { texts } from '../texts/ru.js';
import { DM_COMMANDS, OWNER_COMMANDS } from '../commands.js';
import type { Actor } from '../context.js';

export interface HelpView {
  text: string;
}

/**
 * Renders a `BotCommand[]` (`src/bot/commands.ts`'s `OWNER_COMMANDS`/
 * `DM_COMMANDS`) as one `/command — description` line per row, joined with
 * `\n` — the same source of truth Task 1.11's `syncCommands` uses for each
 * role's actual Telegram command menu, so `/start`/`/help`'s text can never
 * list a command the role doesn't really have, or omit one it does (final
 * Phase 1 review's I2 fix).
 */
function formatCommandList(commands: readonly BotCommand[]): string {
  return commands.map((c) => `/${c.command} — ${c.description}`).join('\n');
}

/**
 * Pure render for `/start`'s welcome overview: no DB, no I/O (CLAUDE.md §7).
 * Shown whenever `/start` does not need to run the first-run `/timezone`
 * picker (`src/bot/handlers/dm.ts` decides that based on `users.timezone`).
 */
export function renderStart(actor: Actor): HelpView {
  if (actor.isSuperadmin) return { text: texts.start.superadmin() };
  if (actor.role === 'owner') return { text: texts.start.owner(formatCommandList(OWNER_COMMANDS)) };
  if (actor.role === 'member') return { text: texts.start.member(formatCommandList(DM_COMMANDS)) };
  return { text: texts.start.stranger() };
}

/**
 * Pure render for `/help`: a role-appropriate reminder of currently
 * available commands, distinct from `/start`'s welcome text (see
 * `texts.help`'s doc comment). No DB, no I/O (CLAUDE.md §7).
 *
 * Superadmin, Owner, Member and stranger each get their own text (final
 * Phase 1 review's I2 fix) — an Owner or Member is never told to "contact
 * the Owner" for access they already have, and the Owner's list reflects
 * every command this phase added (`/people`, `/chats`, `/transfer`,
 * `/privacy`, …), not just `/timezone`/`/help`. `texts.claim.success` sends a
 * freshly-claimed Owner here, so this list is also their first real
 * introduction to what they can now do.
 */
export function renderHelp(actor: Actor): HelpView {
  if (actor.isSuperadmin) return { text: texts.help.superadmin() };
  if (actor.role === 'owner') return { text: texts.help.owner(formatCommandList(OWNER_COMMANDS)) };
  if (actor.role === 'member') return { text: texts.help.member(formatCommandList(DM_COMMANDS)) };
  return { text: texts.help.stranger() };
}
