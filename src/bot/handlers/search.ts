import type { Bot } from 'grammy';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import type { Messenger, Buttons } from '../../domain/messenger.js';
import type { WorkspaceRow } from '../../domain/workspaces/repo.js';
import { can } from '../../domain/people/permissions.js';
import { searchTasks, type SearchTasksResult } from '../../domain/tasks/search.js';
import { PAGE_SIZE } from '../../config/constants.js';
import { userZone } from '../../time/zones.js';
import { decodeCallback, encodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { rowLine, openButton } from '../views/taskList.js';
import { escapeHtml } from '../views/escape.js';
import { texts } from '../texts/ru.js';
import type { BotContext } from '../context.js';

/** The subset of `AppDeps` this handler needs — mirrors `src/bot/handlers/lists.ts`'s own
 * `ListHandlersDeps` precedent. */
export interface SearchHandlersDeps {
  db: Db;
  clock: Clock;
  messenger: Messenger;
  workspace: WorkspaceRow;
}

interface SearchRender {
  text: string;
  buttons: Buttons;
}

/** Regex-escapes every character `new RegExp` would otherwise treat specially — used below to turn
 * `texts.search.header`'s own (Russian, CLAUDE.md §8) surrounding text into a safe pattern fragment
 * without this file ever spelling out that Cyrillic text itself. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The literal text `texts.search.header` always wraps a query in — derived once, at module load, by
 * rendering the header around a sentinel that can never appear in real HTML-escaped input and splitting on
 * it, rather than this file hardcoding a second copy of `texts.search.header`'s own (Russian) wording. */
function headerQuerySentinel(): { prefix: string; suffix: string } {
  const sentinel = '\u0000';
  const rendered = texts.search.header(sentinel);
  const at = rendered.indexOf(sentinel);
  return { prefix: rendered.slice(0, at), suffix: rendered.slice(at + sentinel.length) };
}

const HEADER_QUERY_RE = (() => {
  const { prefix, suffix } = headerQuerySentinel();
  return new RegExp(`^${escapeRegExp(prefix)}([\\s\\S]*?)${escapeRegExp(suffix)}`);
})();

/**
 * Recovers the raw (un-escaped) search query from a `/search` message's own text, for `v1:s:pg:*`'s
 * pagination (plan.md Task 3.8). `callback_data`'s charset (`encodeCallback`'s `ENCODE_ARG_CHARSET_RE`,
 * `src/bot/keyboards/callbackCodec.ts`) is `[A-Za-z0-9_.-]+` only — it cannot carry arbitrary free text,
 * spaces, or Cyrillic, so the query can't travel in the "▶️ next page" button's own `callback_data` the way
 * `src/bot/handlers/lists.ts`'s filter kind/page does. Instead it's parsed back out of the message
 * `texts.search.header` itself rendered (via {@link HEADER_QUERY_RE}) — the one piece of state this
 * feature needs that already lives somewhere durable and trustworthy: `ctx.callbackQuery.message` is
 * Telegram's own record of what this bot last sent to this exact chat, which only this bot can ever edit
 * (a DM recipient cannot edit a message the bot sent), so it survives a process restart the same way a DB
 * row would, with no new table and no in-memory session needed. Returns `null` if the header can't be
 * found (a very old or hand-crafted keyboard) — the caller then shows `texts.search.expired` rather than
 * guessing.
 */
function extractQuery(messageText: string | undefined): string | null {
  if (messageText === undefined) return null;
  const match = HEADER_QUERY_RE.exec(messageText);
  if (match?.[1] === undefined) return null;
  // Reverses `src/bot/texts/ru.ts`'s own `escapeHtml` (`&`/`<`/`>` only) — `&` last, so a literal `&lt;`
  // typed by the Owner isn't itself re-unescaped into `<`.
  return match[1].replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}

/** Builds `/search`'s own result screen: `texts.search.header`'s `«query»` (load-bearing for
 * {@link extractQuery}, see its own doc comment), each row (reusing `src/bot/views/taskList.ts`'s
 * `rowLine`/`openButton` — the exact same row convention `/tasks`'s own lists use), and a prev/next row
 * under the `'s'`/`'pg'` entity/action (only the sides that have another page). */
function buildView(
  result: SearchTasksResult,
  query: string,
  page: number,
  now: Date,
  zone: string,
): SearchRender {
  const header = texts.search.header(escapeHtml(query));
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const viewPage = Math.min(Math.max(1, page), pages);

  if (result.items.length === 0) {
    return { text: [header, texts.search.empty].join('\n'), buttons: [] };
  }

  const text = [
    header,
    '',
    ...result.items.map((item) => rowLine(item, now, zone)),
    '',
    texts.taskList.pageFooter(viewPage, pages),
  ].join('\n');

  const rowButtons: Buttons = result.items.map((item) => [openButton(item, now, zone)]);
  const navRow: Buttons[number] = [];
  if (viewPage > 1) {
    navRow.push({
      text: texts.taskList.prevButton,
      data: encodeCallback({ entity: 's', action: 'pg', id: viewPage - 1 }),
    });
  }
  if (viewPage < pages) {
    navRow.push({
      text: texts.taskList.nextButton,
      data: encodeCallback({ entity: 's', action: 'pg', id: viewPage + 1 }),
    });
  }

  return { text, buttons: [...rowButtons, ...(navRow.length > 0 ? [navRow] : [])] };
}

/**
 * Registers `/search <query text>` (plan.md Task 3.8, SPEC §12.2, Owner only — D40, `task.viewAll`) and its own
 * `v1:s:pg:*` pagination callback (entity `'s'`, shared with `src/bot/handlers/stats.ts`'s `v1:s:per:*`
 * period-switch callback — told apart by `action`; each handler ignores the other's action and calls
 * `next()`, same multi-action-per-entity convention `src/bot/handlers/lists.ts` already uses). DM-only,
 * same reasoning as `/tasks` — search results would otherwise leak task titles into a group chat.
 */
export function registerSearchHandlers(bot: Bot<BotContext>, deps: SearchHandlersDeps): void {
  bot.command('search', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!can(ctx.state.actor, 'task.viewAll')) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const user = ctx.state.user;
    const workspace = ctx.state.workspace;
    if (user === null || workspace === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    const query = ctx.match.trim();
    if (query === '') {
      await ctx.reply(texts.search.usage, { parse_mode: 'HTML' });
      return;
    }

    const zone = userZone(user, workspace);
    const now = deps.clock.now();
    const result = await searchTasks(deps.db, { workspaceId: deps.workspace.id, query, page: 1 });
    const view = buildView(result, query, 1, now, zone);
    await ctx.reply(view.text, {
      parse_mode: 'HTML',
      ...(view.buttons.length > 0 ? { reply_markup: toInlineKeyboard(view.buttons) } : {}),
    });
  });

  bot.callbackQuery(/^v1:s:/, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded || decoded.action !== 'pg') {
      await next();
      return;
    }

    if (!can(ctx.state.actor, 'task.viewAll')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }
    const user = ctx.state.user;
    const workspace = ctx.state.workspace;
    if (user === null || workspace === null) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }

    const query = extractQuery(ctx.callbackQuery.message?.text);
    if (query === null) {
      await ctx.answerCallbackQuery({ text: texts.search.expired });
      return;
    }

    const zone = userZone(user, workspace);
    const now = deps.clock.now();
    const result = await searchTasks(deps.db, { workspaceId: deps.workspace.id, query, page: decoded.id });
    const view = buildView(result, query, decoded.id, now, zone);
    await ctx.answerCallbackQuery();

    const msg = ctx.callbackQuery.message;
    if (!msg) return;
    await deps.messenger.edit(msg.chat.id, msg.message_id, view.text, { buttons: view.buttons });
  });
}
