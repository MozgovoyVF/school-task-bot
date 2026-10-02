/**
 * `/settings`'s screens (plan.md Task 3.11, SPEC §16): the main menu and every section. Pure functions
 * (CLAUDE.md §7): no DB, no I/O — `src/bot/conversations/settings.ts` resolves every value beforehand and
 * applies every change through `updateSettings`/`setWorkspaceTimezone`.
 */
import type { Buttons } from '../../domain/messenger.js';
import type { Settings } from '../../domain/settings/schema.js';
import { RU_ZONES, zoneLabel } from '../../time/zones.js';
import { texts, RU_WEEKDAYS_SHORT } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';
import { escapeHtml } from './escape.js';

export interface SettingsView {
  text: string;
  buttons: Buttons;
}

/** `/settings` is a workspace-level singleton — there is no row to key `callback_data`'s `id` by, same
 * reasoning as `src/bot/conversations/newTask.ts`'s own `MENU_ID`. */
const MENU_ID = 0;

function btn(text: string, action: string, arg?: string): Buttons[number][number] {
  return {
    text,
    data: encodeCallback({ entity: 'a', action, id: MENU_ID, ...(arg !== undefined ? { arg } : {}) }),
  };
}

export function renderSettingsMenu(): SettingsView {
  return {
    text: texts.settings.menuHeader,
    buttons: [
      [btn(texts.settings.summaryButton, 'osm'), btn(texts.settings.remindersButton, 'orm')],
      [btn(texts.settings.quietButton, 'oqt'), btn(texts.settings.timezoneButton, 'otz')],
      [btn(texts.settings.reactionsButton, 'orc'), btn(texts.settings.noticeButton, 'ont')],
      [btn(texts.settings.closeButton, 'cls')],
    ],
  };
}

export function renderSummarySection(summary: Settings['summary']): SettingsView {
  return {
    text: texts.settings.summaryHeader(summary.enabled, summary.time),
    buttons: [
      [
        summary.enabled
          ? btn(texts.settings.summaryDisableButton, 'sof')
          : btn(texts.settings.summaryEnableButton, 'son'),
      ],
      [btn(texts.settings.summaryTimeButton, 'stm')],
      [btn(texts.settings.backButton, 'sbk')],
    ],
  };
}

export function renderRemindersSection(reminders: Settings['reminders']): SettingsView {
  return {
    text: texts.settings.remindersHeader(
      reminders.preDueTime,
      reminders.allDayDueTime,
      reminders.overdueTime,
      reminders.groupOverdueThreshold,
    ),
    buttons: [
      [btn(texts.settings.remindersPreDueButton, 'rpd')],
      [btn(texts.settings.remindersAllDayButton, 'rad')],
      [btn(texts.settings.remindersOverdueButton, 'rov')],
      [btn(texts.settings.remindersThresholdButton, 'rth')],
      [btn(texts.settings.backButton, 'rbk')],
    ],
  };
}

function formatWeekdays(weekdays: readonly number[]): string {
  return weekdays
    .slice()
    .sort((a, b) => a - b)
    .flatMap((day) => {
      const label = RU_WEEKDAYS_SHORT[day - 1];
      return label === undefined ? [] : [label];
    })
    .join(', ');
}

export function renderQuietSection(quiet: Settings['quiet']): SettingsView {
  const window = quiet.windows[0];
  return {
    text: texts.settings.quietHeader(
      quiet.enabled,
      formatWeekdays(quiet.weekdays),
      window === undefined ? null : `${window.from}-${window.to}`,
      quiet.dateRanges.length,
    ),
    buttons: [
      [
        quiet.enabled
          ? btn(texts.settings.quietDisableButton, 'qof')
          : btn(texts.settings.quietEnableButton, 'qon'),
      ],
      [btn(texts.settings.quietWeekdaysButton, 'qwd')],
      [btn(texts.settings.quietWindowButton, 'qwn')],
      [btn(texts.settings.quietDateRangesButton, 'qdr')],
      [btn(texts.settings.backButton, 'qbk')],
    ],
  };
}

export function renderQuietWeekdaysSection(weekdays: readonly number[]): SettingsView {
  const active = new Set(weekdays);
  const dayButtons = RU_WEEKDAYS_SHORT.map((short, idx) => {
    const day = idx + 1;
    return btn(texts.settings.quietWeekdayLabel(short, active.has(day)), 'wtg', String(day));
  });
  const rows: Buttons = [];
  for (let i = 0; i < dayButtons.length; i += 2) rows.push(dayButtons.slice(i, i + 2));
  rows.push([btn(texts.settings.backButton, 'wbk')]);
  return { text: texts.settings.quietWeekdaysHeader, buttons: rows };
}

export function renderQuietDateRangesSection(
  dateRanges: ReadonlyArray<{ from: string; to: string; label?: string }>,
): SettingsView {
  const rangeRows: Buttons = dateRanges.map((range, index) => [
    btn(texts.settings.quietDateRangeRemoveButton(range.from, range.to), 'ddl', String(index)),
  ]);
  return {
    text:
      dateRanges.length === 0 ? texts.settings.quietDateRangesEmpty : texts.settings.quietDateRangesHeader,
    buttons: [
      ...rangeRows,
      [btn(texts.settings.quietDateRangeAddButton, 'dad')],
      [btn(texts.settings.backButton, 'dbk')],
    ],
  };
}

export function renderTimezoneSection(workspaceZone: string, at: Date): SettingsView {
  const grid = RU_ZONES.map((zone, id) => ({ zone, id }));
  const gridButtons = grid.map(({ zone, id }) =>
    btn(texts.timezone.zoneButtonLabel(zone, zoneLabel(zone, at)), 'tzs', String(id)),
  );
  const rows: Buttons = [];
  for (let i = 0; i < gridButtons.length; i += 2) rows.push(gridButtons.slice(i, i + 2));
  rows.push([btn(texts.timezone.manualButton, 'tzm')]);
  rows.push([btn(texts.settings.backButton, 'tzb')]);
  return {
    text: texts.settings.timezoneHeader(
      texts.timezone.zoneButtonLabel(workspaceZone, zoneLabel(workspaceZone, at)),
    ),
    buttons: rows,
  };
}

export function renderReactionsSection(reactions: Settings['reactions']): SettingsView {
  const onDetect = reactions.onDetect !== null;
  const onAccept = reactions.onAccept !== null;
  return {
    text: texts.settings.reactionsHeader(onDetect, onAccept),
    buttons: [
      [
        onDetect
          ? btn(texts.settings.reactionsDetectDisableButton, 'eof')
          : btn(texts.settings.reactionsDetectEnableButton, 'eon'),
      ],
      [
        onAccept
          ? btn(texts.settings.reactionsAcceptDisableButton, 'aof')
          : btn(texts.settings.reactionsAcceptEnableButton, 'aon'),
      ],
      [btn(texts.settings.backButton, 'ebk')],
    ],
  };
}

/**
 * The single-button keyboard `/admin`'s panel offers a superadmin, entering `adminSettings` (`v1:a:ais:0`,
 * Task 3.11) — mirrors `src/bot/views/transfer.ts`'s own `renderAdminOwnerCodeButton` for the owner-code
 * button on the same panel.
 */
export function renderAdminAiSettingsButton(): Buttons {
  return [[btn(texts.admin.aiSettingsButton, 'ais')]];
}

/**
 * `current` is the Owner's own free-text override (`settings.privacyNoticeText`, untrusted — CLAUDE.md §8:
 * every message goes through `parse_mode: 'HTML'`, so raw user text must be escaped first, same convention
 * `proposalCard.ts`/every other `bot/views/*` file uses). `defaultText` (`texts.privacy.chatNotice`) is a
 * trusted literal from `ru.ts` and is never escaped, same as everywhere else it's rendered.
 */
export function renderNoticeSection(current: string | null, defaultText: string): SettingsView {
  const buttons: Buttons = [[btn(texts.settings.noticeEditButton, 'ted')]];
  if (current !== null) buttons.push([btn(texts.settings.noticeResetButton, 'trs')]);
  buttons.push([btn(texts.settings.backButton, 'ntb')]);
  return {
    text: texts.settings.noticeHeader(current !== null, current !== null ? escapeHtml(current) : defaultText),
    buttons,
  };
}
