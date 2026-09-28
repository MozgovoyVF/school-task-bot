import type { BotCommand, BotCommandScope } from 'grammy/types';
import type { DbOrTx } from '../db/client.js';
import { getOwner } from '../domain/people/repo.js';
import { texts } from './texts/ru.js';

/**
 * The minimal surface {@link syncCommands} needs from grammY's `Api`
 * (`api.setMyCommands(commands, { scope })`) — kept as our own structural
 * type, not `import type { Api } from 'grammy'`, purely so this module and
 * its tests don't need a full grammY `Api` instance. `syncCommands` itself
 * stays bot-layer only: `src/domain/people/ownerChanged.ts` never imports
 * this module or this type — it calls `syncCommands` after a successful
 * `/claim` only indirectly, through a plain `() => Promise<void>` callback
 * that `src/bot/handlers/transfer.ts` (bot layer) binds and injects, per
 * CLAUDE.md §7 (`domain/` never imports grammY or does Telegram I/O itself —
 * `syncCommands` does real `setMyCommands` calls, so it can't live behind a
 * domain-held type the way `chats/lifecycle.ts`'s pure `bot/texts`/`bot/views`
 * imports can). Real grammY `Api`/`ctx.api` values satisfy this structurally,
 * with no cast needed at call sites.
 */
export interface CommandsApi {
  setMyCommands(commands: readonly BotCommand[], other?: { scope?: BotCommandScope }): Promise<unknown>;
}

export interface SyncCommandsDeps {
  db: DbOrTx;
  /** The single default workspace (MVP, SPEC §5.2) whose Owner gets the full command scope. */
  workspace: { id: number };
  superadminIds: number[];
}

function cmd(name: string, description: string): BotCommand {
  return { command: name, description };
}

/**
 * Every private chat (SPEC §12.2's "everyone" rows): no `/my` (D40 drops it
 * entirely). Also `/start`/`/help`'s (`src/bot/views/help.ts`) source of
 * truth for a Member's own command list — no chat-scope `setMyCommands` call
 * below gives a Member (as opposed to the Owner or a superadmin) any
 * commands beyond this generic list, so it doubles as "what a Member
 * actually has access to".
 */
export const DM_COMMANDS: BotCommand[] = [
  cmd('start', texts.commands.start),
  cmd('help', texts.commands.help),
  cmd('timezone', texts.commands.timezone),
  cmd('privacy', texts.commands.privacy),
];

/** Every group/supergroup chat: `/task` (manual creation) and `/privacy` (the one command answered with text in a group). */
const GROUP_COMMANDS: BotCommand[] = [
  cmd('task', texts.commands.task),
  cmd('privacy', texts.commands.privacy),
];

/**
 * The Owner's own DM chat (`BotCommandScopeChat`, which *replaces* the
 * `all_private_chats` list for that one chat rather than merging with it —
 * grammY/Telegram's scope-resolution algorithm, confirmed via Context7):
 * SPEC §12.2's full command table, minus `/my` (D40) and the superadmin-only
 * technical commands (`/admin`/`/debug`/`/reanalyze`, added on top for a
 * superadmin's own chat scope below). Also `/start`/`/help`'s
 * (`src/bot/views/help.ts`) source of truth for the Owner's own command
 * list — kept as the single place that list is derived, per the final
 * Phase 1 review's I2 fix, rather than a second hardcoded copy in `texts/ru.ts`.
 */
export const OWNER_COMMANDS: BotCommand[] = [
  cmd('start', texts.commands.start),
  cmd('tasks', texts.commands.tasks),
  cmd('today', texts.commands.today),
  cmd('overdue', texts.commands.overdue),
  cmd('inbox', texts.commands.inbox),
  cmd('new', texts.commands.new),
  cmd('archive', texts.commands.archive),
  cmd('search', texts.commands.search),
  cmd('stats', texts.commands.stats),
  cmd('people', texts.commands.people),
  cmd('chats', texts.commands.chats),
  cmd('settings', texts.commands.settings),
  cmd('transfer', texts.commands.transfer),
  cmd('timezone', texts.commands.timezone),
  cmd('privacy', texts.commands.privacy),
  cmd('help', texts.commands.help),
  cmd('claim', texts.commands.claim),
];

/** A superadmin's own DM chat scope: the Owner's full list plus the technical commands only a superadmin gets. */
const SUPERADMIN_COMMANDS: BotCommand[] = [
  ...OWNER_COMMANDS,
  cmd('admin', texts.commands.admin),
  cmd('debug', texts.commands.debug),
  cmd('reanalyze', texts.commands.reanalyze),
];

function dedupeIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

/**
 * Publishes `setMyCommands` for every scope SPEC §12.2/plan.md's Task 1.11
 * brief lists: all private chats, all group chats, the Owner's own DM chat
 * (if a workspace Owner exists yet), and each superadmin's own DM chat.
 * Called once at startup (`src/app.ts`) and again after every successful
 * `/claim` (`src/domain/people/ownerChanged.ts`'s `afterOwnerChanged`) — a
 * fresh Owner otherwise keeps whatever (or no) chat-scope menu Telegram
 * cached from before the claim.
 */
export async function syncCommands(deps: SyncCommandsDeps, api: CommandsApi): Promise<void> {
  await api.setMyCommands(DM_COMMANDS, { scope: { type: 'all_private_chats' } });
  await api.setMyCommands(GROUP_COMMANDS, { scope: { type: 'all_group_chats' } });

  const owner = await getOwner(deps.db, deps.workspace.id);
  if (owner) {
    await api.setMyCommands(OWNER_COMMANDS, { scope: { type: 'chat', chat_id: owner.user.tgUserId } });
  }

  for (const superadminId of dedupeIds(deps.superadminIds)) {
    await api.setMyCommands(SUPERADMIN_COMMANDS, { scope: { type: 'chat', chat_id: superadminId } });
  }
}
