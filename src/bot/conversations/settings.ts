/**
 * `/settings` (Owner-only, plan.md Task 3.11, SPEC §16) and `/admin`'s "AI settings" button
 * (superadmin-only, same SPEC section: only a superadmin may change `ai.*`/`batch.*`, via `/admin`). Two
 * separate `@grammyjs/conversations` dialogs: `settingsConversation` is the Owner's button-driven menu
 * (`src/bot/views/settings.ts` renders every screen); `adminSettingsConversation` is a free-text
 * `path value` REPL, ended by `/done`. Both apply every change immediately through
 * `updateSettings`/`setWorkspaceTimezone` (`src/domain/workspaces/repo.ts`) — there is no separate "save"
 * step, and every value is validated through `SettingsSchema` (`mergeSettings`'s own zod parse) before the
 * reply confirms it, so an invalid value never reaches the DB (CLAUDE.md §8).
 */
import type { Bot } from 'grammy';
import { createConversation, type Conversation } from '@grammyjs/conversations';
import { ZodError } from 'zod';
import type { AppDeps } from '../../deps.js';
import { can } from '../../domain/people/permissions.js';
import {
  getSettings,
  getWorkspace,
  setSettings,
  setWorkspaceTimezone,
  updateSettings,
} from '../../domain/workspaces/repo.js';
import { mergeSettings, type DeepPartial, type Settings } from '../../domain/settings/schema.js';
import { parseDateRange, parseTimeWindow } from '../../time/parseRanges.js';
import { RU_ZONES, parseZoneInput, zoneLabel } from '../../time/zones.js';
import { CONVERSATION_TIMEOUT_MS, TELEGRAM_TEXT_LIMIT } from '../../config/constants.js';
import { texts } from '../texts/ru.js';
import { decodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import {
  renderNoticeSection,
  renderQuietDateRangesSection,
  renderQuietSection,
  renderQuietWeekdaysSection,
  renderReactionsSection,
  renderRemindersSection,
  renderSettingsMenu,
  renderSummarySection,
  renderTimezoneSection,
} from '../views/settings.js';
import { privateOnly } from '../middleware/privateOnly.js';
import type { BotContext } from '../context.js';

export const SETTINGS_CONVERSATION_ID = 'settings';
export const ADMIN_SETTINGS_CONVERSATION_ID = 'adminSettings';

type SettingsConversation = Conversation<BotContext, BotContext>;

export type SettingsDeps = Pick<AppDeps, 'db' | 'workspace'>;

const CALLBACK_RE = /^v1:a:/;

const DEFAULT_DETECT_EMOJI = '👀';
const DEFAULT_ACCEPT_EMOJI = '✍';

const MAIN_MENU_ACTIONS = new Set(['osm', 'orm', 'oqt', 'otz', 'orc', 'ont', 'cls']);
const SUMMARY_ACTIONS = new Set(['son', 'sof', 'stm', 'sbk']);
const REMINDERS_ACTIONS = new Set(['rpd', 'rad', 'rov', 'rth', 'rbk']);
const QUIET_ACTIONS = new Set(['qon', 'qof', 'qwd', 'qwn', 'qdr', 'qbk']);
const QUIET_WEEKDAY_ACTIONS = new Set(['wtg', 'wbk']);
const QUIET_RANGE_ACTIONS = new Set(['dad', 'ddl', 'dbk']);
const TIMEZONE_ACTIONS = new Set(['tzs', 'tzm', 'tzb']);
const REACTIONS_ACTIONS = new Set(['eon', 'eof', 'aon', 'aof', 'ebk']);
const NOTICE_ACTIONS = new Set(['ted', 'trs', 'ntb']);

/** Waits for a `v1:a:<action>:0[:<arg>]` press whose `action` is in `allowed` — mirrors
 * `editTask.ts`'s own `waitForMenuAction` (this dialog has a single, fixed `id`, same reasoning as
 * `newTask.ts`'s `MENU_ID`). */
async function waitForMenuAction(
  conversation: SettingsConversation,
  allowed: ReadonlySet<string>,
): Promise<{ action: string; arg?: string } | null> {
  const pick = await conversation.waitForCallbackQuery(CALLBACK_RE, {
    otherwise: (otherCtx) => otherCtx.reply(texts.settings.pickButtonHint, { parse_mode: 'HTML' }),
  });
  await pick.answerCallbackQuery();
  const decoded = decodeCallback(pick.callbackQuery.data);
  if (!decoded || !allowed.has(decoded.action)) return null;
  return { action: decoded.action, arg: decoded.arg };
}

async function askText(conversation: SettingsConversation, ctx: BotContext, prompt: string): Promise<string> {
  await ctx.reply(prompt, { parse_mode: 'HTML' });
  const textCtx = await conversation.waitFor(':text', {
    otherwise: (otherCtx) => otherCtx.reply(texts.settings.textHint, { parse_mode: 'HTML' }),
  });
  return textCtx.msg.text.trim();
}

/**
 * Validates `patch` against the current settings (via the pure, synchronous `mergeSettings` — called
 * directly, *not* inside `conversation.external`, per `updateSettings`'s own doc comment:
 * `@grammyjs/conversations` does not guarantee a thrown error keeps its original prototype once
 * `conversation.external` has touched it, so an `instanceof ZodError` check must happen outside it) and,
 * if valid, persists it (`setSettings`, which *is* wrapped in `external` — it is the actual DB write).
 * Returns `false` without writing anything on a validation error; rethrows anything else.
 */
async function applyValidatedPatch(
  conversation: SettingsConversation,
  deps: SettingsDeps,
  patch: DeepPartial<Settings>,
): Promise<boolean> {
  const current = await conversation.external(() => getSettings(deps.db, deps.workspace.id));
  let next: Settings;
  try {
    next = mergeSettings(current, patch);
  } catch (err) {
    if (!(err instanceof ZodError)) throw err;
    return false;
  }
  await conversation.external(() => setSettings(deps.db, deps.workspace.id, next));
  return true;
}

async function runSummarySection(conversation: SettingsConversation, ctx: BotContext, deps: SettingsDeps) {
  for (;;) {
    const settings = await conversation.external(() => getSettings(deps.db, deps.workspace.id));
    const view = renderSummarySection(settings.summary);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, SUMMARY_ACTIONS);
    if (picked === null) continue;
    if (picked.action === 'sbk') return;

    if (picked.action === 'son' || picked.action === 'sof') {
      const enabled = picked.action === 'son';
      await conversation.external(() => updateSettings(deps.db, deps.workspace.id, { summary: { enabled } }));
      continue;
    }

    // 'stm'
    for (;;) {
      const input = await askText(conversation, ctx, texts.settings.summaryTimePrompt);
      const ok = await applyValidatedPatch(conversation, deps, { summary: { time: input } });
      if (ok) break;
      await ctx.reply(texts.settings.timeInvalid, { parse_mode: 'HTML' });
    }
  }
}

async function runRemindersSection(conversation: SettingsConversation, ctx: BotContext, deps: SettingsDeps) {
  for (;;) {
    const settings = await conversation.external(() => getSettings(deps.db, deps.workspace.id));
    const view = renderRemindersSection(settings.reminders);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, REMINDERS_ACTIONS);
    if (picked === null) continue;
    if (picked.action === 'rbk') return;

    if (picked.action === 'rth') {
      for (;;) {
        const input = await askText(conversation, ctx, texts.settings.remindersThresholdPrompt);
        const threshold = Number(input);
        if (!Number.isInteger(threshold) || threshold < 1) {
          await ctx.reply(texts.settings.thresholdInvalid, { parse_mode: 'HTML' });
          continue;
        }
        const ok = await applyValidatedPatch(conversation, deps, {
          reminders: { groupOverdueThreshold: threshold },
        });
        if (ok) break;
        await ctx.reply(texts.settings.thresholdInvalid, { parse_mode: 'HTML' });
      }
      continue;
    }

    const REMINDER_FIELD_BY_ACTION = {
      rpd: 'preDueTime',
      rad: 'allDayDueTime',
      rov: 'overdueTime',
    } as const;
    const field = REMINDER_FIELD_BY_ACTION[picked.action as keyof typeof REMINDER_FIELD_BY_ACTION];
    for (;;) {
      const input = await askText(conversation, ctx, texts.settings.remindersTimePrompt);
      const ok = await applyValidatedPatch(conversation, deps, { reminders: { [field]: input } });
      if (ok) break;
      await ctx.reply(texts.settings.timeInvalid, { parse_mode: 'HTML' });
    }
  }
}

async function runQuietWeekdaysSection(
  conversation: SettingsConversation,
  ctx: BotContext,
  deps: SettingsDeps,
) {
  for (;;) {
    const settings = await conversation.external(() => getSettings(deps.db, deps.workspace.id));
    const view = renderQuietWeekdaysSection(settings.quiet.weekdays);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, QUIET_WEEKDAY_ACTIONS);
    if (picked === null) continue;
    if (picked.action === 'wbk') return;

    const day = picked.arg !== undefined ? Number(picked.arg) : NaN;
    if (!Number.isInteger(day) || day < 1 || day > 7) continue;
    const next = settings.quiet.weekdays.includes(day)
      ? settings.quiet.weekdays.filter((d) => d !== day)
      : [...settings.quiet.weekdays, day];
    await conversation.external(() =>
      updateSettings(deps.db, deps.workspace.id, { quiet: { weekdays: next } }),
    );
  }
}

async function runQuietDateRangesSection(
  conversation: SettingsConversation,
  ctx: BotContext,
  deps: SettingsDeps,
) {
  for (;;) {
    const settings = await conversation.external(() => getSettings(deps.db, deps.workspace.id));
    const view = renderQuietDateRangesSection(settings.quiet.dateRanges);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, QUIET_RANGE_ACTIONS);
    if (picked === null) continue;
    if (picked.action === 'dbk') return;

    if (picked.action === 'ddl') {
      const index = picked.arg !== undefined ? Number(picked.arg) : NaN;
      if (!Number.isInteger(index)) continue;
      const next = settings.quiet.dateRanges.filter((_, i) => i !== index);
      await conversation.external(() =>
        updateSettings(deps.db, deps.workspace.id, { quiet: { dateRanges: next } }),
      );
      continue;
    }

    // 'dad'
    for (;;) {
      const input = await askText(conversation, ctx, texts.settings.quietDateRangePrompt);
      const workspace = await conversation.external(() => getWorkspace(deps.db, deps.workspace.id));
      const zone = workspace?.timezone ?? deps.workspace.timezone;
      const now = new Date(await conversation.now());
      const parsed = parseDateRange(input, now, zone);
      if (parsed === null) {
        await ctx.reply(texts.settings.quietDateRangeInvalid, { parse_mode: 'HTML' });
        continue;
      }
      const fresh = await conversation.external(() => getSettings(deps.db, deps.workspace.id));
      const ok = await applyValidatedPatch(conversation, deps, {
        quiet: { dateRanges: [...fresh.quiet.dateRanges, parsed] },
      });
      if (ok) break;
      await ctx.reply(texts.settings.quietDateRangeInvalid, { parse_mode: 'HTML' });
    }
  }
}

async function runQuietSection(conversation: SettingsConversation, ctx: BotContext, deps: SettingsDeps) {
  for (;;) {
    const settings = await conversation.external(() => getSettings(deps.db, deps.workspace.id));
    const view = renderQuietSection(settings.quiet);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, QUIET_ACTIONS);
    if (picked === null) continue;
    if (picked.action === 'qbk') return;

    if (picked.action === 'qon' || picked.action === 'qof') {
      const enabled = picked.action === 'qon';
      await conversation.external(() => updateSettings(deps.db, deps.workspace.id, { quiet: { enabled } }));
      continue;
    }
    if (picked.action === 'qwd') {
      await runQuietWeekdaysSection(conversation, ctx, deps);
      continue;
    }
    if (picked.action === 'qdr') {
      await runQuietDateRangesSection(conversation, ctx, deps);
      continue;
    }

    // 'qwn'
    for (;;) {
      const input = await askText(conversation, ctx, texts.settings.quietWindowPrompt);
      const parsed = parseTimeWindow(input);
      if (parsed === null) {
        await ctx.reply(texts.settings.quietWindowInvalid, { parse_mode: 'HTML' });
        continue;
      }
      const ok = await applyValidatedPatch(conversation, deps, { quiet: { windows: [parsed] } });
      if (ok) break;
      await ctx.reply(texts.settings.quietWindowInvalid, { parse_mode: 'HTML' });
    }
  }
}

/** Resolves a `tzs`/`tzm` pick to an IANA/fixed-offset zone string, looping on invalid manual input
 * (mirrors `src/bot/conversations/timezone.ts`'s own `readManualZone`). `null` only for a stale `tzs` grid
 * index (should not happen; `RU_ZONES` is fixed). */
async function resolveTimezoneChoice(
  conversation: SettingsConversation,
  ctx: BotContext,
  action: string,
  arg: string | undefined,
): Promise<string | null> {
  if (action === 'tzs') {
    const id = arg !== undefined ? Number(arg) : NaN;
    return RU_ZONES[id] ?? null;
  }
  for (;;) {
    const input = await askText(conversation, ctx, texts.timezone.manualPrompt);
    const parsed = parseZoneInput(input);
    if (parsed !== null) return parsed;
    await ctx.reply(texts.timezone.invalid, { parse_mode: 'HTML' });
  }
}

async function runTimezoneSection(conversation: SettingsConversation, ctx: BotContext, deps: SettingsDeps) {
  for (;;) {
    const workspace = await conversation.external(() => getWorkspace(deps.db, deps.workspace.id));
    const zone = workspace?.timezone ?? deps.workspace.timezone;
    const at = new Date(await conversation.now());
    const view = renderTimezoneSection(zone, at);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, TIMEZONE_ACTIONS);
    if (picked === null) continue;
    if (picked.action === 'tzb') return;

    const resolved = await resolveTimezoneChoice(conversation, ctx, picked.action, picked.arg);
    if (resolved === null) continue;
    await conversation.external(() => setWorkspaceTimezone(deps.db, deps.workspace.id, resolved));
    const label = texts.timezone.zoneButtonLabel(resolved, zoneLabel(resolved, at));
    await ctx.reply(texts.settings.timezoneSaved(label), { parse_mode: 'HTML' });
  }
}

async function runReactionsSection(conversation: SettingsConversation, ctx: BotContext, deps: SettingsDeps) {
  for (;;) {
    const settings = await conversation.external(() => getSettings(deps.db, deps.workspace.id));
    const view = renderReactionsSection(settings.reactions);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, REACTIONS_ACTIONS);
    if (picked === null) continue;
    if (picked.action === 'ebk') return;

    if (picked.action === 'eon') {
      await conversation.external(() =>
        updateSettings(deps.db, deps.workspace.id, { reactions: { onDetect: DEFAULT_DETECT_EMOJI } }),
      );
    } else if (picked.action === 'eof') {
      await conversation.external(() =>
        updateSettings(deps.db, deps.workspace.id, { reactions: { onDetect: null } }),
      );
    } else if (picked.action === 'aon') {
      await conversation.external(() =>
        updateSettings(deps.db, deps.workspace.id, { reactions: { onAccept: DEFAULT_ACCEPT_EMOJI } }),
      );
    } else {
      await conversation.external(() =>
        updateSettings(deps.db, deps.workspace.id, { reactions: { onAccept: null } }),
      );
    }
  }
}

async function runNoticeSection(conversation: SettingsConversation, ctx: BotContext, deps: SettingsDeps) {
  for (;;) {
    const settings = await conversation.external(() => getSettings(deps.db, deps.workspace.id));
    const view = renderNoticeSection(settings.privacyNoticeText, texts.privacy.chatNotice);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, NOTICE_ACTIONS);
    if (picked === null) continue;
    if (picked.action === 'ntb') return;

    if (picked.action === 'trs') {
      await conversation.external(() =>
        updateSettings(deps.db, deps.workspace.id, { privacyNoticeText: null }),
      );
      await ctx.reply(texts.settings.noticeReset, { parse_mode: 'HTML' });
      continue;
    }

    // 'ted'
    for (;;) {
      const input = await askText(conversation, ctx, texts.settings.noticeEditPrompt);
      if (input.length === 0) {
        await ctx.reply(texts.settings.textHint, { parse_mode: 'HTML' });
        continue;
      }
      if (input.length > TELEGRAM_TEXT_LIMIT) {
        await ctx.reply(texts.settings.noticeTooLong(TELEGRAM_TEXT_LIMIT), { parse_mode: 'HTML' });
        continue;
      }
      await conversation.external(() =>
        updateSettings(deps.db, deps.workspace.id, { privacyNoticeText: input }),
      );
      await ctx.reply(texts.settings.noticeSaved, { parse_mode: 'HTML' });
      break;
    }
  }
}

function buildSettingsConversation(deps: SettingsDeps) {
  return async function settingsConversation(
    conversation: SettingsConversation,
    ctx: BotContext,
  ): Promise<void> {
    // `ctx.state` is unavailable on the context objects a conversation builder receives directly — only on
    // the live "outside" context `conversation.external`'s callback is given (same pre-verified fact every
    // other conversation in this codebase documents).
    const actor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
    if (!can(actor, 'settings.manage')) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    for (;;) {
      const view = renderSettingsMenu();
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
      const picked = await waitForMenuAction(conversation, MAIN_MENU_ACTIONS);
      if (picked === null) continue;

      if (picked.action === 'cls') {
        await ctx.reply(texts.settings.closed, { parse_mode: 'HTML' });
        return;
      }
      if (picked.action === 'osm') await runSummarySection(conversation, ctx, deps);
      else if (picked.action === 'orm') await runRemindersSection(conversation, ctx, deps);
      else if (picked.action === 'oqt') await runQuietSection(conversation, ctx, deps);
      else if (picked.action === 'otz') await runTimezoneSection(conversation, ctx, deps);
      else if (picked.action === 'orc') await runReactionsSection(conversation, ctx, deps);
      else await runNoticeSection(conversation, ctx, deps);
    }
  };
}

const ADMIN_SETTING_PATH_RE = /^[a-zA-Z]+(?:\.[a-zA-Z]+)*$/;

function parseAdminSettingValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/**
 * Parses `/admin`'s "AI settings" free-text `path value` lines (e.g. `ai.thresholds.low 0.3`): the first
 * whitespace run splits the dotted `path` from the raw value, which is then read as a boolean
 * (`true`/`false`), a number, or left as a string. Returns `null` if there is no path/value split, or the
 * path isn't a dotted run of letters.
 */
export function parseAdminSetting(input: string): { path: string; value: unknown } | null {
  const trimmed = input.trim();
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) return null;
  const path = trimmed.slice(0, spaceIdx).trim();
  const rawValue = trimmed.slice(spaceIdx + 1).trim();
  if (path === '' || rawValue === '' || !ADMIN_SETTING_PATH_RE.test(path)) return null;
  return { path, value: parseAdminSettingValue(rawValue) };
}

/**
 * Builds a `DeepPartial<Settings>`-shaped single-key patch for `path` (e.g. `ai.thresholds.low` →
 * `{ ai: { thresholds: { low: value } } }`), but only if every segment already exists on `current` —
 * otherwise `null`. This is what keeps a typo'd or unknown key (`ai.thresholds.lowx`) from silently
 * no-op'ing: `mergeSettings`'s own zod parse drops unknown object keys rather than rejecting them, so
 * without this check a typo'd key would get a cheerful "saved" reply and change nothing.
 */
function buildPatchFromPath(current: unknown, segments: readonly string[]): Record<string, unknown> | null;
function buildPatchFromPath(
  current: unknown,
  segments: readonly string[],
  value: unknown,
): Record<string, unknown> | null;
function buildPatchFromPath(
  current: unknown,
  segments: readonly string[],
  value?: unknown,
): Record<string, unknown> | null {
  const [head, ...rest] = segments;
  if (head === undefined || typeof current !== 'object' || current === null || Array.isArray(current)) {
    return null;
  }
  const currentObj = current as Record<string, unknown>;
  if (!(head in currentObj)) return null;
  if (rest.length === 0) return { [head]: value };
  const nested = buildPatchFromPath(currentObj[head], rest, value);
  if (nested === null) return null;
  return { [head]: nested };
}

function buildAdminSettingsConversation(deps: SettingsDeps) {
  return async function adminSettingsConversation(
    conversation: SettingsConversation,
    ctx: BotContext,
  ): Promise<void> {
    const actor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
    if (!actor.isSuperadmin) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    await ctx.reply(texts.adminSettings.intro, { parse_mode: 'HTML' });

    for (;;) {
      const textCtx = await conversation.waitFor(':text', {
        otherwise: (otherCtx) => otherCtx.reply(texts.adminSettings.textHint, { parse_mode: 'HTML' }),
      });
      const line = textCtx.msg.text.trim();
      if (line === '/done') {
        await textCtx.reply(texts.adminSettings.done, { parse_mode: 'HTML' });
        return;
      }

      const parsed = parseAdminSetting(line);
      if (parsed === null) {
        await textCtx.reply(texts.adminSettings.invalidFormat, { parse_mode: 'HTML' });
        continue;
      }

      const current = await conversation.external(() => getSettings(deps.db, deps.workspace.id));
      const patch = buildPatchFromPath(current, parsed.path.split('.'), parsed.value);
      if (patch === null) {
        await textCtx.reply(texts.adminSettings.unknownKey(parsed.path), { parse_mode: 'HTML' });
        continue;
      }

      const ok = await applyValidatedPatch(conversation, deps, patch);
      if (ok) {
        await textCtx.reply(texts.adminSettings.saved(parsed.path, String(parsed.value)), {
          parse_mode: 'HTML',
        });
      } else {
        await textCtx.reply(texts.adminSettings.rejected(parsed.path), { parse_mode: 'HTML' });
      }
    }
  };
}

/**
 * Registers both conversations (DM-only, same `privateOnly` belt-and-suspenders every
 * `createConversation(...)` registration in this codebase uses). Entry points
 * (`/settings`, and the `v1:a:ais:0` button on `/admin`'s panel) live in `src/bot/handlers/settings.ts`.
 */
export function registerSettingsConversations(bot: Bot<BotContext>, deps: SettingsDeps): void {
  bot.use(
    privateOnly(
      createConversation(buildSettingsConversation(deps), {
        id: SETTINGS_CONVERSATION_ID,
        maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS,
      }),
    ),
  );
  bot.use(
    privateOnly(
      createConversation(buildAdminSettingsConversation(deps), {
        id: ADMIN_SETTINGS_CONVERSATION_ID,
        maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS,
      }),
    ),
  );
}
