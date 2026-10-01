/**
 * All user-facing (and, for now, superadmin-facing) strings live here
 * (CLAUDE.md §8): this is the only file allowed to contain Cyrillic outside
 * `src/config/constants.ts`. Telegram uses `parse_mode: 'HTML'` everywhere,
 * so any dynamic value interpolated into a string here must be escaped first.
 */
import type { RU_ZONES, ZoneLabel } from '../../time/zones.js';
import { CLAIM_CODE_TTL_HOURS, MAX_ALIASES_PER_PERSON, MAX_ALIAS_LENGTH } from '../../config/constants.js';

/** Minimal HTML escaping for values interpolated into `parse_mode: 'HTML'` messages. */
function escapeHtml(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** "1 раз" / "2 раза" / "5 раз" — standard Russian count agreement. */
function pluralizeRaz(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'раз';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'раза';
  return 'раз';
}

/** "1 предложение" / "2 предложения" / "5 предложений" — used by `texts.cards`' outbox summary messages. */
function pluralizePredlozhenie(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'предложение';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'предложения';
  return 'предложений';
}

function formatContext(context: Record<string, unknown>): string {
  const entries = Object.entries(context);
  if (entries.length === 0) return '—';
  return entries.map(([key, value]) => `${escapeHtml(key)}=${escapeHtml(String(value))}`).join(', ');
}

/** "1 час" / "2 часа" / "5 часов" — standard Russian count agreement, used by `texts.transfer.code`. */
function pluralizeChas(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'час';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'часа';
  return 'часов';
}

/** `/admin`'s precision line and other "nothing decided yet" ratios (SPEC §11.2's "н/д" — zero denominator). */
const NO_DATA_LABEL = 'н/д';

/**
 * A USD amount for display (SPEC §9.2's budget alert, `/admin`'s cost lines): two decimal places for
 * anything a whole cent or larger, same as a plain `toFixed(2)` always gave — but a flat `toFixed(2)` also
 * silently rounds a genuinely nonzero small value (e.g. `LLM_DAILY_BUDGET_USD=0.0001`) down to `"0.00"`,
 * which is exactly the dev-acceptance bug this fixes (`texts.errors.budgetPaused` showing «из 0.00 $» for a
 * real, nonzero budget). Below one cent, shows up to 4 decimal places instead, trimmed of trailing zeros
 * (`0.0001` stays `0.0001`, `0.0050` becomes `0.005`) so the value stays visibly nonzero without padding it
 * with meaningless precision. `0` itself (a real zero, not a rounded-away one) still prints `0.00`, matching
 * every other amount's two-decimal shape. Below `0.0001` itself (review round 1, M7 — the original
 * 4-decimal rounding still printed a genuinely nonzero value like `1e-6` as a bare `"0.0000"`, the exact
 * class of bug this function exists to avoid), prints the Russian «менее 0.0001» instead of a misleadingly
 * precise-looking zero — **not** `<0.0001` (re-review finding, Important): every call site sends with
 * `parse_mode: 'HTML'`, and a raw `<` outside a tag makes Telegram reject the whole message ("can't parse
 * entities"), silently losing `/admin`'s panel and leaving the budget alert marked sent but never
 * delivered to the Owner.
 */
export function formatUsd(amount: number): string {
  const abs = Math.abs(amount);
  if (abs === 0 || abs >= 0.01) return amount.toFixed(2);
  if (abs < 0.0001) return 'менее 0.0001';
  return amount.toFixed(4).replace(/0+$/, '');
}

/** "1ч 02мин 03с" — a short, fixed-order duration for `/admin`'s uptime line. */
function formatUptime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}ч`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}мин`);
  parts.push(`${secs}с`);
  return parts.join(' ');
}

/** `+2`/`−1`/`+5:30` — the signed part of a zone label, using U+2212 MINUS SIGN (not a hyphen) for negatives. */
function formatSignedOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '−' : '+';
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return minutes === 0
    ? `${sign}${String(hours)}`
    : `${sign}${String(hours)}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Renders a {@link ZoneLabel} (`src/time/zones.ts`, kept Cyrillic-free per
 * CLAUDE.md §8) as `МСК`, `МСК+2`, `МСК−1` for RU zones (D17) or `UTC+2` for
 * everything else.
 */
export function formatZoneLabel(label: ZoneLabel): string {
  if (label.kind === 'msk') {
    return label.offsetMinutes === 0 ? 'МСК' : `МСК${formatSignedOffset(label.offsetMinutes)}`;
  }
  return `UTC${formatSignedOffset(label.offsetMinutes)}`;
}

/** Russian city names for `RU_ZONES`' `/timezone` quick-pick buttons, keyed by IANA zone name. */
const ZONE_CITY_LABELS: Record<(typeof RU_ZONES)[number], string> = {
  'Europe/Kaliningrad': 'Калининград',
  'Europe/Moscow': 'Москва',
  'Europe/Samara': 'Самара',
  'Asia/Yekaterinburg': 'Екатеринбург',
  'Asia/Omsk': 'Омск',
  'Asia/Novosibirsk': 'Новосибирск',
  'Asia/Krasnoyarsk': 'Красноярск',
  'Asia/Irkutsk': 'Иркутск',
  'Asia/Yakutsk': 'Якутск',
  'Asia/Vladivostok': 'Владивосток',
  'Asia/Magadan': 'Магадан',
  'Asia/Kamchatka': 'Камчатка',
};

/**
 * Short weekday/month names for `formatDue` below and `src/time/format.ts`'s
 * `formatDue` (D17): own arrays rather than `Intl`/ICU, no trailing dot.
 * Indexed 0-based (`RU_WEEKDAYS_SHORT[luxon's dt.weekday - 1]`, Monday
 * first; `RU_MONTHS_SHORT[dt.month - 1]`, January first).
 */
export const RU_WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const;
export const RU_MONTHS_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
] as const;

export const texts = {
  errors: {
    /**
     * A report card sent to superadmins for a fresh (or hourly-repeated)
     * error. `context` must only ever hold non-PII scalars (entity IDs and
     * the like, per CLAUDE.md §8) — this text never carries user message
     * text. `repeatCount`, when given and positive, notes how many times the
     * error repeated since the previous notification.
     */
    report(
      fingerprint: string,
      name: string,
      message: string,
      context: Record<string, unknown>,
      repeatCount?: number,
    ): string {
      const lines = [
        '⚠️ Ошибка в боте',
        `Тип: <b>${escapeHtml(name)}</b>`,
        `Сообщение: <code>${escapeHtml(message)}</code>`,
        `Отпечаток: <code>${escapeHtml(fingerprint)}</code>`,
        `Контекст: ${formatContext(context)}`,
      ];
      if (repeatCount !== undefined && repeatCount > 0) {
        lines.push(`Повторилось ${repeatCount} ${pluralizeRaz(repeatCount)}.`);
      }
      return lines.join('\n');
    },
    /** A short, apologetic reply to the user whose action triggered an error the bot has already reported. */
    userFacing: 'Что-то пошло не так. Мы уже разбираемся, попробуйте, пожалуйста, ещё раз чуть позже.',
    /** SPEC §8: sent to superadmin once an `analysis_batches` row gives up after its 5th failed attempt. */
    batchFailed(batchId: number, message: string): string {
      return [
        '⚠️ Анализ сообщений не удался',
        `Пачка: <code>${String(batchId)}</code>`,
        `После 5 попыток анализ остановлен. Сообщения остаются в очереди, повторить можно через /reanalyze.`,
        `Ошибка: <code>${escapeHtml(message)}</code>`,
      ].join('\n');
    },
    /** SPEC §8/§9.2: sent to superadmin after 5 consecutive LLM-call failures across different batches. */
    llmConsecutiveFailures(count: number): string {
      return `⚠️ ${String(count)} ошибок LLM подряд. Проверьте доступность OpenRouter и ключ API.`;
    },
    /** SPEC §9.2: sent to superadmin and Owner once, per calendar day, when the daily LLM budget is exhausted. */
    budgetPaused(spentUsd: number, budgetUsd: number): string {
      return [
        '⚠️ Дневной бюджет на анализ сообщений исчерпан',
        `Потрачено ${formatUsd(spentUsd)} $ из ${formatUsd(budgetUsd)} $.`,
        'Автоматический анализ приостановлен до завтра — новые сообщения сохраняются и будут разобраны, когда бюджет обновится. Ручные команды продолжают работать.',
      ].join('\n');
    },
  },
  common: {
    /** Sent when a user without the required role invokes a restricted command or callback. */
    forbidden: 'У вас нет доступа к этой команде.',
    /** DM-only reply for an `OWNER_COMMANDS` (`src/bot/commands.ts`) menu command Phase 3 hasn't
     * implemented yet (`src/bot/handlers/stubs.ts`) — found silent on dev acceptance of v0.3.0-rc.1
     * (`/tasks` had no handler at all). Kept generic rather than per-command wording: which feature it is
     * doesn't change what the Owner needs to know ("not yet, soon"). */
    comingSoon: 'Эта команда появится в одном из ближайших обновлений.',
  },
  /**
   * Assembles `src/time/format.ts`'s `formatDue` structure (or `null`, "no
   * due date") into the final one-line display string (SPEC §10.9, D29),
   * e.g. `пт, 25 сен, 18:00 (МСК+2)`, or — for an all-day due date, which
   * never gets a time or a zone label (D29) — just `пт, 25 сен`. `due.date`/
   * `due.time` are already built from `RU_WEEKDAYS_SHORT`/`RU_MONTHS_SHORT`
   * above; `due.zone`, when set, is formatted here via `formatZoneLabel`.
   */
  formatDue(due: { date: string; time: string | null; zone: ZoneLabel | null } | null): string {
    if (due === null) return 'без срока';
    const time = due.time === null ? '' : `, ${due.time}`;
    const zone = due.zone === null ? '' : ` (${formatZoneLabel(due.zone)})`;
    return `${due.date}${time}${zone}`;
  },
  start: {
    /**
     * `/start`'s welcome overview for a recognized superadmin. Shown on every
     * `/start` once the user already has a timezone set — Task 1.4's
     * first-run flow (`src/bot/conversations/timezone.ts`) runs the
     * `/timezone` picker instead the very first time, then sends
     * `texts.help.*` (a distinct, command-reference text — see that
     * namespace) once the zone is saved.
     */
    superadmin(): string {
      return [
        '👋 Здравствуйте! Я — Секретарь школы.',
        'Слежу за рабочими группами, нахожу поручения и договорённости и веду список задач.',
        '',
        'Доступные команды:',
        '/admin — панель администратора',
        '/help — эта справка',
      ].join('\n');
    },
    /**
     * `/start`'s welcome overview for the workspace Owner. `commandList` is
     * `src/bot/views/help.ts`'s rendering of `src/bot/commands.ts`'s
     * `OWNER_COMMANDS` (single source of truth for what commands the Owner
     * actually has — final Phase 1 review's I2 fix).
     */
    owner(commandList: string): string {
      return [
        '👋 Здравствуйте! Я — Секретарь школы.',
        'Слежу за рабочими группами, нахожу поручения и договорённости и веду список задач.',
        '',
        'Доступные команды:',
        commandList,
      ].join('\n');
    },
    /**
     * `/start`'s welcome overview for a recognized Member (has a membership,
     * not the Owner). `commandList` is `src/bot/commands.ts`'s `DM_COMMANDS`
     * rendered the same way (final Phase 1 review's I2 fix).
     */
    member(commandList: string): string {
      return [
        '👋 Здравствуйте! Я — Секретарь школы.',
        'Слежу за рабочими группами, нахожу поручения и договорённости и веду список задач.',
        '',
        'Доступные команды:',
        commandList,
      ].join('\n');
    },
    /** `/start`'s welcome overview for anyone the bot does not yet recognize (no membership at all). */
    stranger(): string {
      return (
        'Этот бот работает для сотрудников школы французского языка и настраивается её руководителем. ' +
        'Если вы сотрудник и должны иметь доступ, обратитесь, пожалуйста, к руководителю школы.'
      );
    },
  },
  /**
   * `/help`'s role-appropriate command reference (SPEC §12.2's `/help` row:
   * «Справка по роли»). Deliberately distinct in wording/purpose from
   * `texts.start.*`'s welcome overview: `/start` greets and (on first run)
   * offers timezone selection, `/help` is a short reminder of what's
   * available right now. Also sent once, from
   * `src/bot/conversations/timezone.ts`, right after that first-run zone
   * selection completes (SPEC §10.10: "...краткая справка по роли").
   *
   * `superadmin`/`owner`/`member`/`stranger` are each distinguished (final
   * Phase 1 review's I2 fix — through this fix, Owner and Member shared one
   * `staff` text that told the Owner to "contact the Owner" and listed only
   * `/timezone`/`/help`, missing every command this phase actually added for
   * them). `owner`/`member`'s `commandList` argument is
   * `src/bot/views/help.ts`'s rendering of `src/bot/commands.ts`'s
   * `OWNER_COMMANDS`/`DM_COMMANDS` — the same source of truth Task 1.11's
   * `syncCommands` uses for each role's Telegram command menu, so this text
   * and that menu can never drift apart.
   */
  help: {
    /** `/help` for a superadmin. */
    superadmin(): string {
      return [
        '📋 Доступные команды:',
        '/admin — панель администратора',
        '/timezone — часовой пояс',
        '/help — эта справка',
      ].join('\n');
    },
    /** `/help` for the workspace Owner. */
    owner(commandList: string): string {
      return ['📋 Доступные команды:', commandList].join('\n');
    },
    /** `/help` for a recognized Member (has a membership, not the Owner). */
    member(commandList: string): string {
      return ['📋 Доступные команды:', commandList].join('\n');
    },
    /** `/help` for anyone the bot does not yet recognize. */
    stranger(): string {
      return (
        'Пока вы не привязаны ни к одной школе в этом боте. Если вы сотрудник и должны иметь доступ, ' +
        'обратитесь, пожалуйста, к руководителю школы. Часовой пояс на будущее можно задать командой /timezone.'
      );
    },
  },
  timezone: {
    /** Prompt shown above the `/timezone` quick-pick keyboard (first `/start` and `/timezone`). */
    prompt: 'Выберите часовой пояс:',
    /**
     * The quick-pick keyboard's first, emphasized button: keeps the
     * *workspace's actual configured* default (SPEC §10, point 10: «по
     * умолчанию пояс workspace») — `label` is `zoneButtonLabel`'s output for
     * `workspace.timezone`, not a hardcoded "Москва" (D41's Important fix:
     * `workspace.timezone` only *seeds* as `Europe/Moscow`, an operator can
     * set `DEFAULT_TIMEZONE` to any IANA zone).
     */
    keepDefault(label: string): string {
      return `Оставить: ${label}`;
    },
    /**
     * Button label for a timezone, e.g. "Екатеринбург (МСК+2)" for a
     * `RU_ZONES` member, or just "UTC+4" for any other IANA zone (used both
     * for the quick-pick grid, always a `RU_ZONES` member, and for
     * `keepDefault`'s workspace zone, which is not guaranteed to be one).
     */
    zoneButtonLabel(zone: string, label: ZoneLabel): string {
      const city = (ZONE_CITY_LABELS as Partial<Record<string, string>>)[zone];
      return city === undefined ? formatZoneLabel(label) : `${city} (${formatZoneLabel(label)})`;
    },
    /** Button that switches from the quick-pick keyboard to manual text entry. */
    manualButton: 'Ввести вручную',
    /** Sent after tapping "Ввести вручную", asking for free-form input. */
    manualPrompt:
      'Введите часовой пояс: смещение (например, +5 или UTC+5), название IANA (Europe/Moscow) или «мск».',
    /** Sent when free-form input, or an unexpected update while a button was expected, could not be parsed as a zone. */
    invalid: 'Не удалось распознать часовой пояс. Попробуйте, например: +5, UTC+5, Europe/Moscow или мск.',
    /** Sent when an update arrives that is neither a tap on one of the offered buttons nor (during manual entry) text. */
    pickButtonHint: 'Пожалуйста, нажмите одну из кнопок ниже.',
    /** Confirmation after `users.timezone` is saved; `label` is `formatZoneLabel`'s output (already HTML-safe: only letters/digits/±/МСК/UTC). */
    saved(label: string): string {
      return `Часовой пояс сохранён: <b>${escapeHtml(label)}</b>.`;
    },
  },
  admin: {
    /**
     * `/admin` panel for a superadmin: build version, elapsed process uptime, and (Task 2.15) a short
     * AI-pipeline summary — today's/this month's LLM spend, the last 7 days' shown/suppressed/accepted/
     * rejected proposal counts, and `accepted/(accepted+rejected)` precision (`NO_DATA_LABEL` when that
     * denominator is zero — SPEC §11.2's own "н/д" case, not a bug).
     */
    panel(
      gitSha: string,
      uptimeSec: number,
      ai: {
        costToday: number;
        costMonth: number;
        last7: { shown: number; suppressed: number; accepted: number; rejected: number };
        precision: number | null;
      },
    ): string {
      const precisionLabel =
        ai.precision === null ? NO_DATA_LABEL : `${String(Math.round(ai.precision * 100))}%`;
      return [
        '🛠 Панель администратора',
        `Версия: <code>${escapeHtml(gitSha)}</code>`,
        `Аптайм: ${formatUptime(uptimeSec)}`,
        '',
        '🤖 ИИ-анализ',
        `Стоимость сегодня: ${formatUsd(ai.costToday)} $ · за месяц: ${formatUsd(ai.costMonth)} $`,
        `За 7 дней: показано ${String(ai.last7.shown)}, скрыто ${String(ai.last7.suppressed)}, ` +
          `принято ${String(ai.last7.accepted)}, отклонено ${String(ai.last7.rejected)}`,
        `Точность (принято / принято+отклонено): ${precisionLabel}`,
      ].join('\n');
    },
    /** Button on the `/admin` panel that issues a claim code (Task 1.5, `src/bot/handlers/transfer.ts`). */
    ownerCodeButton: 'Код владельца',
    /**
     * `errors.alert('privacy_mode', ...)`'s text (Task 1.11,
     * `src/bot/startupChecks.ts`'s `checkPrivacyMode`) — sent to every
     * superadmin when `getMe().can_read_all_group_messages === false`: the
     * bot only sees commands/replies in groups, not ordinary conversation,
     * which breaks task detection entirely until privacy mode is turned off
     * *and* the bot is re-added to every group it's already in (Telegram only
     * re-syncs a bot's group visibility on re-add, not retroactively).
     */
    privacyModeOn: [
      '⚠️ У бота включён privacy mode — он не получает обычные сообщения в группах, только команды и упоминания.',
      'Отключите privacy mode у @BotFather (Bot Settings → Group Privacy → Turn off) и ' +
        '<b>заново добавьте бота в группы</b>, где он уже состоит — иначе для уже добавленных чатов ничего не изменится.',
    ].join('\n'),
  },
  /**
   * `/debug [chat]` (SPEC §12.2 row, Task 2.15): superadmin-only diagnostics for the last 10
   * `analysis_batches`, optionally filtered to one chat. `src/bot/views/debug.ts` assembles each batch's
   * block from these line-builders, mirroring `texts.proposalCard`'s split (views build structure, `ru.ts`
   * owns wording); every dynamic string here is escaped by the caller before it arrives (same convention).
   */
  debug: {
    header: '🔍 Диагностика анализа',
    /** No batches at all yet (or none for the given chat). */
    empty: 'Пока нет ни одного batch.',
    /** One batch's heading line — `chatLabel` is already `escapeHtml`'d, or `null` for a batch with no chat (a manual/DM call, D5). */
    batchHeader(id: number, whenLabel: string, chatLabel: string | null): string {
      const chat = chatLabel === null ? 'без чата' : chatLabel;
      return `<b>#${String(id)}</b> · ${whenLabel} · ${chat}`;
    },
    countsLine(messageCount: number, statusLabel: string): string {
      return `Сообщений: ${String(messageCount)} · Статус: ${statusLabel}`;
    },
    /** `reasonsLabel` is `"below_low: 2, commitment_without_due_below_high: 1"`-style, or `''` when nothing was suppressed. */
    decisionLine(shown: number, suppressed: number, reasonsLabel: string): string {
      const reasons = reasonsLabel === '' ? '' : ` (${reasonsLabel})`;
      return `Показано: ${String(shown)} · Скрыто: ${String(suppressed)}${reasons}`;
    },
    /** `modelLabel` is already `escapeHtml`'d, or `null` when the batch never reached the extractor (e.g. prefilter-skipped). */
    costLine(modelLabel: string | null, costUsd: number): string {
      return `Модель: ${modelLabel ?? '—'} · Стоимость: ${costUsd.toFixed(4)} $`;
    },
    /** Only shown for a `failed` batch — `errorLabel` is already `escapeHtml`'d. */
    errorLine(errorLabel: string): string {
      return `Ошибка: <code>${errorLabel}</code>`;
    },
    statusQueued: 'в очереди',
    statusRunning: 'выполняется',
    statusDone: 'готово',
    statusFailed: 'ошибка',
    /** `/debug`'s optional `<chatId>` argument didn't parse as a positive integer. */
    invalidChatArg: 'Не удалось распознать id чата. Использование: /debug [id чата].',
  },
  /**
   * `/reanalyze <chat> [N]` (SPEC §12.2 row, Task 2.15): superadmin-only — re-queues a chat's failed
   * batches (no `N`) or builds a fresh `kind='reanalyze'` batch over its last `N` text messages (SPEC §8:
   * "Сообщения по-прежнему `pending` и доступны для `/reanalyze`"). Both paths only ever *enqueue* work —
   * the actual LLM call still runs on the ticker's own schedule (`analyzeJob`), so these confirm "queued",
   * not "done".
   */
  reanalyze: {
    usage: 'Использование: /reanalyze <id чата> [число последних сообщений].',
    invalidArgs:
      'Не удалось распознать команду. Использование: /reanalyze <id чата> [число последних сообщений].',
    chatNotFound: 'Чат не найден.',
    /** `lastN` path found no text messages in this chat to reanalyze at all. */
    noMessages: 'В этом чате нет сообщений с текстом для повторного анализа.',
    /** No `N` given: `batchCount` failed batches had their messages' `batch_id` cleared. */
    requeued(batchCount: number, messageCount: number): string {
      if (batchCount === 0) return 'Неудачных batch для этого чата не найдено — нечего возвращать в очередь.';
      return (
        `Возвращено в очередь: batch — ${String(batchCount)}, сообщений — ${String(messageCount)}. ` +
        'Будут повторно проанализированы в общем порядке.'
      );
    },
    /** `N` given: a fresh `kind='reanalyze'` batch was queued over the chat's last `messageCount` text messages. */
    created(messageCount: number): string {
      return (
        `Создан batch на переанализ: сообщений — ${String(messageCount)}. ` +
        'Дубликаты будут помечены автоматически, реакции на исходные сообщения не ставятся.'
      );
    },
  },
  transfer: {
    /** Prompt shown above `/transfer`'s two-button choice. */
    prompt: 'Как поступить с текущим владельцем после того, как код будет использован?',
    /** Button: the current owner keeps their membership, demoted to a regular member. */
    demoteButton: 'Станет участником',
    /** Button: the current owner's membership is removed entirely. */
    removeButton: 'Будет исключён',
    /**
     * Sent after a claim code is generated (`/transfer`'s choice, or `/admin`'s
     * "Код владельца" button). `code` is HTML-escaped, though in practice it
     * only ever contains `CLAIM_ALPHABET` characters.
     */
    code(code: string): string {
      const safeCode = escapeHtml(code);
      return [
        `Код передачи владения: <code>${safeCode}</code>`,
        '',
        `Отправьте его новому владельцу — в личном сообщении боту он должен ввести <code>/claim ${safeCode}</code>.`,
        `Код действует ${String(CLAIM_CODE_TTL_HOURS)} ${pluralizeChas(CLAIM_CODE_TTL_HOURS)} и может быть использован только один раз.`,
      ].join('\n');
    },
  },
  chats: {
    /**
     * Approval card sent to the Owner and every superadmin (SPEC §15.1) when
     * `my_chat_member` adds the bot to a chat that isn't auto-activated
     * (`src/domain/chats/lifecycle.ts`'s `onBotAdded`/`requestPendingApprovals`).
     */
    addedNotice(title: string, addedByName: string): string {
      return `Бота добавили в „${escapeHtml(title)}“ (добавил: ${escapeHtml(addedByName)}).`;
    },
    /** Fallback for `addedNotice`'s title, on the off chance a chat has none. */
    untitledChat: 'без названия',
    /** Fallback for `addedNotice`'s "добавил: …", when the adder has no known name. */
    unknownAdder: 'неизвестно',
    approveButton: '✅ Разрешить',
    leaveButton: '🚪 Покинуть чат',
    /** `/chats`' list header (Task 1.9). */
    listHeader: '💬 Чаты',
    /** Shown instead of a list when the bot is in no chats at all. */
    listEmpty: 'Бот пока не состоит ни в одном чате.',
    statusActive: '🟢 активен',
    statusPaused: '⏸ пауза',
    statusPending: '⏳ ждёт разрешения',
    statusLeft: '🚪 покинут',
    /** One line of `/chats`' list, e.g. "🟢 активен — Учителя французского". */
    listLine(title: string, statusLabel: string): string {
      return `${statusLabel} — ${escapeHtml(title)}`;
    },
    /** `/chats`' per-chat card heading. */
    cardTitle(title: string): string {
      return `💬 ${escapeHtml(title)}`;
    },
    cardStatusLine(statusLabel: string): string {
      return `Статус: ${statusLabel}`;
    },
    /** Shown on a `pending` chat's card instead of manage buttons — it is decided from the approval card, not here. */
    pendingCardHint:
      'Решение ещё не принято — используйте карточку с кнопками «Разрешить»/«Покинуть чат», присланную ранее.',
    /** Shown on a `left` chat's card — nothing left to manage. */
    leftCardHint: 'Бота больше нет в этом чате.',
    analysisButton(enabled: boolean): string {
      return `Анализ: ${enabled ? 'вкл' : 'выкл'}`;
    },
    reactionsButton(enabled: boolean): string {
      return `Реакции: ${enabled ? 'вкл' : 'выкл'}`;
    },
    pauseButton: '⏸ Пауза',
    resumeButton: '▶️ Возобновить',
    /** `/chats`' per-chat card leave button — deliberately distinct wording from `leaveButton` above (the pending-approval card's reject button). */
    manageLeaveButton: '🚪 Покинуть',
    backButton: '◀️ Назад',
    /** `«Точно покинуть „…“?»` — the confirmation prompt before `leaveChat` actually runs. */
    leaveConfirmPrompt(title: string): string {
      return `Точно покинуть „${escapeHtml(title)}“?`;
    },
    leaveConfirmYes: '✅ Да, покинуть',
    leaveConfirmNo: '❌ Отмена',
  },
  /** `/people` — list/edit member names and aliases (Task 1.10). Deliberately no notification toggle (D40). */
  people: {
    listHeader: '👥 Участники',
    /** Shown instead of a list when the workspace has no members at all. */
    listEmpty: 'В школе пока нет ни одного участника.',
    /** One line of `/people`'s list, e.g. "Мария (Маша, Машенька) — МСК+2". `name` and `aliases` are user-entered (Owner-editable via `editPerson.ts`) and are escaped here; `zone` is `formatZoneLabel`'s output, already HTML-safe. */
    listLine(name: string, aliases: string, zone: string): string {
      return `${escapeHtml(name)} (${escapeHtml(aliases)}) — ${zone}`;
    },
    /** Placeholder shown instead of an empty alias list (both the list line and the card). */
    noAliases: 'без алиасов',
    /** `/people`'s per-member card heading. */
    cardTitle(name: string): string {
      return `👤 ${escapeHtml(name)}`;
    },
    cardAliasesLine(aliases: string): string {
      return `Алиасы: ${escapeHtml(aliases)}`;
    },
    /** `zone` is `formatZoneLabel`'s output (already HTML-safe, same as `texts.timezone.saved`). */
    cardZoneLine(zone: string): string {
      return `Часовой пояс: ${zone}`;
    },
    editButton: '✏️ Изменить',
    backButton: '◀️ Назад',
    /** First step of the edit dialog (`editPerson.ts`): the current name, and how to keep it unchanged. */
    namePrompt(current: string): string {
      return `Текущее имя: <b>${escapeHtml(current)}</b>\nВведите новое имя или отправьте «-», чтобы оставить как есть.`;
    },
    /** Second step: the current aliases, the input format, and the limits `parseAliases` enforces. */
    aliasesPrompt(current: string): string {
      return (
        `Текущие алиасы: <b>${escapeHtml(current)}</b>\n` +
        `Введите алиасы через запятую (не более ${String(MAX_ALIASES_PER_PERSON)}, каждый до ${String(MAX_ALIAS_LENGTH)} символов) ` +
        'или отправьте «-», чтобы оставить как есть.'
      );
    },
    /** `AliasValidationError('too_many')` — re-prompts within the same dialog step. */
    aliasesTooMany(): string {
      return `Слишком много алиасов — не более ${String(MAX_ALIASES_PER_PERSON)}. Попробуйте ещё раз.`;
    },
    /** `AliasValidationError('too_long')` — re-prompts within the same dialog step. */
    aliasesTooLong(): string {
      return `Каждый алиас должен быть не длиннее ${String(MAX_ALIAS_LENGTH)} символов. Попробуйте ещё раз.`;
    },
    /** Shown when an update other than a text message arrives while the dialog expects one. */
    textHint: 'Пожалуйста, отправьте текстовое сообщение.',
    /** Both steps were skipped («-» twice) — nothing was written to the DB. */
    nothingChanged: 'Изменений не было — данные оставлены как есть.',
    /** At least one field was saved. */
    saved: 'Данные участника сохранены.',
  },
  privacy: {
    /**
     * SPEC §15.2 — published once per chat by `publishNoticeOnce`
     * (`src/domain/chats/lifecycle.ts`), unless overridden by
     * `settings.privacyNoticeText`.
     */
    chatNotice:
      '👋 Я — бот-секретарь школы. Я читаю сообщения этого чата, чтобы находить задачи и договорённости и ' +
      'напоминать о них руководителю. Текст сообщений хранится не дольше 30 дней, затем удаляется; сохраняются ' +
      'только подтверждённые задачи. Для анализа текст передаётся сервису обработки (ИИ) без фамилий, @имён и ' +
      'контактов. Подробнее: /privacy. Вопросы — к руководителю.',
    /**
     * `/privacy`'s full answer (Task 1.11, SPEC §12.2's `/privacy` row and
     * §19.5's `privacy_full.md`) — sent in both a group and a DM, identically
     * (SPEC §12.2: `/privacy` is the one command the bot answers with text in
     * a group). Its substantive copy lives in `docs/legal/privacy_full.md`
     * (marked "проверить юристу", CLAUDE.md §... /SPEC §19.5) — keep both in
     * sync. Explicitly notes SPEC §19.3 point 2: third parties' names (e.g.
     * students) are *not* pseudonymized in free text in the MVP.
     */
    full(): string {
      return [
        '🔒 Что я делаю с данными',
        '',
        'Я читаю сообщения рабочих групп, куда меня добавили, чтобы находить задачи и договорённости для ' +
          'руководителя школы.',
        '',
        '<b>Какие данные обрабатываю:</b> Telegram ID, имя и username сотрудников; тексты сообщений рабочих ' +
          'групп — в них могут быть данные третьих лиц (учеников, родителей): имена, телефоны, суммы оплат.',
        '<b>Зачем:</b> чтобы находить задачи, сроки и договорённости и напоминать о них руководителю.',
        '<b>Сроки хранения:</b> текст сообщений хранится не дольше 30 дней и затем удаляется; в задаче остаётся ' +
          'только короткая цитата (до 200 символов) и ссылка на исходное сообщение.',
        '<b>Передача для анализа:</b> текст передаётся стороннему сервису обработки (ИИ). Перед отправкой из ' +
          'него убираются @юзернеймы, телефоны, e-mail, номера карт и счетов, ссылки. <b>Имена третьих лиц ' +
          '(например, учеников) в свободном тексте не заменяются</b> — в MVP это сильно ухудшило бы поиск задач.',
        '<b>Кто видит данные:</b> руководитель школы (карточки задач, сводки) и, по техническим вопросам, ' +
          'разработчик бота.',
        '<b>Удаление данных:</b> обратитесь к руководителю школы — он может удалить участника через /people. ' +
          'Полное удаление данных школы делает технический администратор бота.',
        '',
        'Это не юридическая консультация, а техническое описание. Вопросы — к руководителю школы.',
      ].join('\n');
    },
  },
  /**
   * Proposal cards sent to the Owner's DM (SPEC §11.1, Task 2.11,
   * `src/bot/views/proposalCard.ts`'s `renderProposalCard`). Every parameter
   * that carries user/DB text (titles, quotes, names) arrives here **already
   * HTML-escaped** by the caller (`bot/views/escape.ts`'s `escapeHtml`) —
   * these functions only assemble the Russian wording and punctuation around
   * it, they never escape themselves (mirrors `texts.people.cardZoneLine`'s
   * "already HTML-safe" convention above, just pushed one layer further so
   * escaping stays a `views/` concern rather than a `texts/` one).
   */
  proposalCard: {
    /** `create`-kind header for an AI-found proposal — `percent` is `Math.round(confidence * 100)`. */
    headerAi(percent: number): string {
      return `🆕 Задача · уверенность ${String(percent)}%`;
    },
    /** `create`-kind header for a manually entered proposal (`v.manual`). */
    headerManual: '🆕 Задача · вручную',
    titleLine(title: string): string {
      return `📌 ${title}`;
    },
    metaLine(assignee: string, due: string, priority: string): string {
      return `👤 ${assignee} · 📅 ${due} · ⚡ ${priority}`;
    },
    priorityLow: 'низкий',
    priorityNormal: 'обычный',
    priorityHigh: 'высокий',
    /** `assigneeKind === 'all'`. */
    assigneeAll: 'Всем',
    /** `assigneeKind === 'none'`, or a null `assigneeName` for any other kind. */
    assigneeNone: 'Не назначен',
    /** SPEC §10.8: a resolved due date that has already passed. */
    pastDueWarning: '⚠️ срок в прошлом — проверьте',
    /** SPEC §9.3: a possible duplicate of an existing open task, shown above the quote. */
    duplicateHint(taskId: number, title: string): string {
      return `🔁 Похоже на дубль T${String(taskId)} «${title}»`;
    },
    /**
     * The source quote line. `author`/`chatTitle` are appended only when
     * present — `— <author>, «<chatTitle>»`, `— <author>` alone, or
     * `— «<chatTitle>»` alone when the author isn't known.
     */
    quoteLine(quote: string, author: string | null, chatTitle: string | null): string {
      let suffix = '';
      if (author !== null) {
        suffix = ` — ${author}`;
        if (chatTitle !== null) suffix += `, «${chatTitle}»`;
      } else if (chatTitle !== null) {
        suffix = ` — «${chatTitle}»`;
      }
      return `💬 «${quote}»${suffix}`;
    },
    /** `url` is `bot/views/links.ts`'s `messageLink` output — omitted entirely (SPEC §11.1) when it's `null` (an ordinary, non-super group). */
    linkLine(url: string): string {
      return `🔗 <a href="${url}">Открыть сообщение</a>`;
    },
    acceptButton: '✅ Создать',
    editButton: '✏️ Изменить',
    rejectButton: '❌ Не задача',
    /** Extra button row for a possible duplicate (SPEC §11.1). */
    duplicateButton(taskId: number): string {
      return `🔗 Дубль T${String(taskId)}`;
    },
    updateFieldDue: 'Перенос срока',
    updateFieldAssignee: 'Смена исполнителя',
    updateFieldTitle: 'Изменение названия',
    /** `target.field === null` — a change the three specific labels above don't cover. */
    updateFieldGeneric: 'Изменение',
    /** `update`-kind's single summary line; `before`/`after` are omitted together when either is `null`. */
    updateLine(
      label: string,
      taskId: number,
      title: string,
      before: string | null,
      after: string | null,
    ): string {
      const change = before === null || after === null ? '' : ` · было ${before} → стало ${after}`;
      return `🔄 ${label}: T${String(taskId)} «${title}»${change}`;
    },
    applyButton: '✅ Применить',
    ignoreButton: '❌ Игнорировать',
    /** `complete`-kind's single summary line; the `— «quote» (author)` evidence is omitted when `quote` is `null`. */
    completeLine(taskId: number, title: string, quote: string | null, author: string | null): string {
      const evidence = quote === null ? '' : ` — «${quote}»${author === null ? '' : ` (${author})`}`;
      return `✅ Похоже, выполнено: T${String(taskId)} «${title}»${evidence}`;
    },
    closeTaskButton: '✅ Закрыть задачу',
    /** Shared "decline this suggestion" button label for `update`/`complete`/`cancel` cards (`create`'s own is `rejectButton` above). */
    noButton: '❌ Нет',
    /** `cancel`-kind's single summary line — same shape as `completeLine` (SPEC §11.1: "аналогично"). */
    cancelLine(taskId: number, title: string, quote: string | null, author: string | null): string {
      const evidence = quote === null ? '' : ` — «${quote}»${author === null ? '' : ` (${author})`}`;
      return `🗑 Похоже, отменено: T${String(taskId)} «${title}»${evidence}`;
    },
    cancelTaskButton: '🗑 Отменить задачу',
  },
  /**
   * Outcomes of a proposal decision (SPEC §11.2, Task 2.13,
   * `src/domain/proposals/decide.ts`/`src/bot/handlers/proposalCallbacks.ts`):
   * the card's own text once it is edited in place, plus the
   * `answerCallbackQuery` alerts for a decision that didn't go through.
   * `title` in every `*Card` function arrives already HTML-escaped by the
   * caller (`src/bot/views/taskCreated.ts`), same convention as
   * `texts.proposalCard` above.
   */
  proposalDecide: {
    /** `DecisionResult.reason === 'already_decided'` — the double-accept race (SPEC/CLAUDE.md's atomicity). */
    alreadyDecided: 'Уже обработано.',
    /** `DecisionResult.reason === 'not_found'` — the proposal row itself is gone. */
    notFound: 'Предложение не найдено.',
    /** `DecisionResult.reason === 'target_gone'` — the task the proposal targets no longer exists. */
    targetGone: 'Задача, к которой относится это предложение, больше не существует.',
    /** The reject-reason submenu's own header line (SPEC §11.2: `[Не задача] [Дубль] [Уже сделано] [Другое]`). */
    reasonMenuTitle: 'Причина?',
    reasonNotTask: 'Не задача',
    reasonDuplicate: 'Дубль',
    reasonAlreadyDone: 'Уже сделано',
    reasonOther: 'Другое',
    /** The "🔗 Дубль T12" button's own follow-up submenu (fix round 1, Important A) — offers marking the
     * proposal as a duplicate with or without appending its quote to the existing task's description. */
    duplicateMenuTitle(taskId: number): string {
      return `Дубль T${String(taskId)} — просто пометить, или дописать текст в описание?`;
    },
    duplicateMarkOnlyButton: '🔗 Только пометить',
    duplicateMarkAndAppendButton: '📝 Пометить и дописать',
    /** "✅ Создать" succeeded (SPEC §11.2). */
    createdCard(taskId: number, title: string): string {
      return `✅ Создано: T${String(taskId)} «${title}»`;
    },
    /** "✅ Применить" succeeded on an `update`-kind proposal. */
    appliedCard(taskId: number, title: string): string {
      return `✅ Применено: T${String(taskId)} «${title}»`;
    },
    /** "✅ Закрыть задачу" succeeded on a `complete`-kind proposal. */
    completedCard(taskId: number, title: string): string {
      return `✅ Закрыто: T${String(taskId)} «${title}»`;
    },
    /** "🗑 Отменить задачу" succeeded on a `cancel`-kind proposal. */
    cancelledCard(taskId: number, title: string): string {
      return `🗑 Отменено: T${String(taskId)} «${title}»`;
    },
    /** The duplicate submenu's own button succeeded — `appended` says whether "mark and append" (`dpa`)
     * was pressed, vs. plain "mark only" (`dpm`). */
    duplicateCard(taskId: number, appended: boolean): string {
      return appended
        ? `🔗 Отмечено как дубль T${String(taskId)}, описание дополнено`
        : `🔗 Отмечено как дубль T${String(taskId)}`;
    },
    /** A decline succeeded — `reasonLabel` is one of the four `reason*` labels above, or `null` for
     * `update`/`complete`/`cancel`'s plain decline (no reason submenu for those). */
    rejectedCard(reasonLabel: string | null): string {
      return reasonLabel === null ? '❌ Отклонено' : `❌ Отклонено: ${reasonLabel}`;
    },
  },
  /**
   * The "✏️ Изменить" edit dialog (`src/bot/conversations/editProposal.ts`,
   * plan.md Task 2.14, D23) — only ever entered for a `create`-kind
   * proposal (it ends in `acceptProposal`, which only accepts that kind).
   * `menuHeader`/`descriptionLine` are assembled around `texts.proposalCard`'s
   * own `titleLine`/`metaLine` (same card look as the original proposal
   * card) — every parameter carrying user/DB text arrives here already
   * HTML-escaped by the caller (`src/bot/views/editMenu.ts`), same
   * convention as `texts.proposalCard` above. `titlePrompt`/`descriptionPrompt`,
   * by contrast, are called directly from the conversation with a raw,
   * unescaped current value (mirrors `texts.people.namePrompt`'s own
   * convention) and escape it themselves.
   */
  editProposal: {
    /** Shown instead of entering the dialog for any proposal `kind` other than `create` — the dialog's
     * only exit, "Сохранить и создать", always calls `acceptProposal`, which only accepts that kind. */
    notSupported: 'Изменение доступно только для новых задач.',
    menuHeader: '✏️ Изменение задачи',
    /** The "Описание" field's own "nothing set" placeholder — both the menu preview (`descriptionLine`) and the field prompt's current value (`src/bot/conversations/editProposal.ts`) use this. */
    noDescription: 'без описания',
    descriptionLine(description: string | null): string {
      return `📝 ${description === null ? 'без описания' : description}`;
    },
    fieldTitleButton: 'Название',
    fieldAssigneeButton: 'Исполнитель',
    fieldDueButton: 'Срок',
    fieldPriorityButton: 'Приоритет',
    fieldDescriptionButton: 'Описание',
    saveButton: '✅ Сохранить и создать',
    backButton: '↩️ Назад',
    /** Shown instead of a new value when an update that expects a button press arrives as something else. */
    pickButtonHint: 'Пожалуйста, воспользуйтесь кнопками.',
    /** The dialog's own "↩️ Назад" — leaves without saving. */
    cancelled: 'Изменения отменены.',
    /** Shown when an update other than a text message arrives while a field's new value is expected. */
    textHint: 'Пожалуйста, отправьте текстовое сообщение.',
    /** The "Название" field's own prompt — `current` is the proposal's own (unescaped) title. */
    titlePrompt(current: string): string {
      return `Текущее название: <b>${escapeHtml(current)}</b>\nВведите новое название.`;
    },
    /** The "Описание" field's own prompt — `current` is already a display string ("без описания" or the
     * proposal's own unescaped description). */
    descriptionPrompt(current: string): string {
      return (
        `Текущее описание: <b>${escapeHtml(current)}</b>\n` +
        'Введите новое описание или отправьте «-», чтобы убрать его.'
      );
    },
    assigneeMenuTitle: 'Кому назначить?',
    /** Assigns to the Owner themselves — this dialog is Owner-only (D40), so "Я" always means the Owner. */
    assigneeSelfButton: 'Я',
    priorityMenuTitle: 'Приоритет?',
    dueMenuTitle: 'Срок?',
    dueTodayButton: 'Сегодня',
    dueTomorrowButton: 'Завтра',
    dueFriButton: 'Пт',
    dueNextMonButton: 'След. пн',
    dueNoneButton: 'Без срока',
    dueEnterButton: 'Ввести…',
    dueTextPrompt: 'Введите дату и время свободным текстом, например «15.10 14:00» или «в четверг в 11».',
    /** `label` is `texts.formatDue`'s own output for the parsed date. */
    duePreview(label: string): string {
      return `${label} — верно?`;
    },
    dateNotParsed: 'Не удалось разобрать дату. Попробуйте ещё раз, например «15.10 14:00».',
    yesButton: 'Да',
    noButton: 'Нет',
  },
  /**
   * The card outbox (`src/scheduler/jobs/cards.ts`, plan.md Task 2.12): the
   * two summary messages it sends instead of a proposal card, plus the
   * quiet-hours batch's button label.
   */
  cards: {
    /** Sent once per batch group once it has more than `MAX_CARDS_PER_BATCH` shown proposals — `count` is however many were left over. */
    moreProposals(count: number): string {
      return `Ещё ${String(count)} ${pluralizePredlozhenie(count)}: /inbox`;
    },
    /** SPEC §13.5/D10: everything found while the Owner was in quiet hours arrives as one message once they end, instead of individual cards. */
    quietBatch(count: number): string {
      return `🌙 За время тишины найдено ${String(count)} ${pluralizePredlozhenie(count)}`;
    },
    /** The quiet-hours batch message's only button — opens `/inbox` (Task 2.15's future callback handling). */
    openInboxButton: '📥 Разобрать',
    /** Superadmin alert (throttled hourly by `ErrorReporter.alert`): the workspace has no Owner yet, so the outbox has nowhere to deliver cards. */
    noOwner: '⚠️ У рабочего пространства нет руководителя — карточки предложений некому отправлять.',
    /** Superadmin alert (throttled hourly): the Owner has a membership but has never opened a DM with the bot (no `/start` yet), so cards pile up undelivered. */
    ownerNotStarted:
      '⚠️ Руководитель ещё не запускал бота в личных сообщениях (/start) — карточки предложений не доставляются.',
    /** Superadmin alert (throttled hourly): a card send just came back `forbidden` — the Owner blocked the bot in Telegram, so cards pile up undelivered until they unblock it. */
    ownerBlocked: '⚠️ Руководитель заблокировал бота в Telegram — карточки предложений не доставляются.',
  },
  /**
   * Reminder DMs (`src/scheduler/jobs/notify.ts`/`src/bot/views/reminder.ts`, plan.md Task 3.3, SPEC
   * §13.2/§13.3) — only ever sent to the Owner (D40). `pre_due`/`due`/`overdue`/`snooze` share one header
   * per kind, then the same title/assignee/due layout `proposalCard` uses for a card. The grouped-overdue
   * digest (3+ at once, `settings.reminders.groupOverdueThreshold`) reuses `overdueHeader`'s wording in its
   * own count header instead, one `overdueDigestLine` per task.
   */
  reminders: {
    preDueHeader: '⏳ Завтра срок',
    dueHeader: '🔔 Срок сегодня',
    overdueHeader: '🔴 Просрочено',
    /** A user-requested repeat ping (`[⏰ +1 час]`/`[📅 Завтра]`/`[🕐 Выбрать время]`) — the due date itself never changed, so this gets a neutral header rather than `dueHeader`/`overdueHeader`'s implied urgency. */
    snoozeHeader: '🔔 Напоминание',
    titleLine(title: string): string {
      return `📌 ${title}`;
    },
    metaLine(assignee: string, due: string): string {
      return `👤 ${assignee} · 📅 ${due}`;
    },
    doneButton: '✅ Готово',
    plusHourButton: '⏰ +1 час',
    tomorrowButton: '📅 Завтра',
    pickTimeButton: '🕐 Выбрать время',
    /** The grouped-overdue digest's own header — `count` is always `>= settings.reminders.groupOverdueThreshold`. */
    overdueDigestHeader(count: number): string {
      return `🔴 Просрочено (${String(count)}):`;
    },
    /** One digest row per overdue task — no per-task buttons (SPEC doesn't specify any for the grouped case); `/tasks` is where the Owner acts on them individually. */
    overdueDigestLine(taskId: number, title: string, due: string): string {
      return `• T${String(taskId)} «${title}» — ${due}`;
    },
    /** The digest's own overflow footer (review round 1, I4) — `src/bot/views/reminder.ts`'s `renderOverdueDigest` stops adding rows once the text would cross Telegram's 4096-char limit (CLAUDE.md) and appends this instead, mirroring SPEC §13.4's "ещё N → /tasks" overflow convention for the summary's own "no-due" section. */
    overdueDigestMore(count: number): string {
      return `… ещё ${String(count)} → /tasks`;
    },
    /** `[✅ Готово]` succeeded (plan.md Task 3.4, SPEC §13.3) — `title` is already escaped by the caller,
     * same convention as `proposalDecide.completedCard`. */
    doneConfirm(taskId: number, title: string): string {
      return `✅ Готово: T${String(taskId)} «${title}»`;
    },
    /** `[⏰ +1 час]`/`[📅 Завтра]`/the submenu's own three buttons all land here — `due` is
     * `texts.formatDue`'s own output for the snooze's `fireAt`. The task's own due date never changed
     * (SPEC §13.3), so this deliberately never mentions "due", only when the next ping will be. */
    snoozeConfirm(due: string): string {
      return `🔔 Отложено до: ${due}`;
    },
    /** `[🕐 Выбрать время]`'s own submenu (SPEC §13.3: `[Через 3 ч] [Сегодня 18:00] [Послезавтра] [Ввести…]`). */
    pickMenuTitle: 'Когда напомнить?',
    pick3hButton: 'Через 3 ч',
    pickToday18Button: 'Сегодня 18:00',
    pickDayAfterButton: 'Послезавтра',
    pickEnterButton: 'Ввести…',
    /** The submenu's own "Ввести…" button's free-text prompt (`src/bot/conversations/snoozeInput.ts`). */
    snoozeEnterPrompt: 'Введите дату и время свободным текстом, например «15.10 14:00» или «через 2 часа».',
    /** `snoozeFireAt` returned `null` — the picked option (currently only `today18`) is already unreachable
     * today (SPEC §13.3's own example: pressing it after 18:00). */
    snoozeUnavailable: 'Это время уже прошло. Выберите другой вариант.',
    /** The task a reminder button was pressed on no longer exists, or is already `done`/`cancelled` —
     * shared by every `v1:n:*` button and the `snoozeInput` conversation's own entry guard. */
    taskGone: 'Задача не найдена или уже закрыта.',
  },
  /**
   * The task card (`src/bot/views/taskCard.ts`/`src/bot/handlers/taskCallbacks.ts`, plan.md Task 3.6,
   * SPEC §12.4) — Owner only (D40/`task.edit`). `titleLine`/`statusLine` assemble the card header; the
   * meta/quote/link lines reuse `texts.reminders.metaLine`/`texts.proposalCard.quoteLine`/`.linkLine`
   * directly rather than duplicating identically-worded lines here. Every parameter carrying user/DB text
   * arrives here already HTML-escaped by the caller (`src/bot/views/taskCard.ts`), same convention as
   * `texts.proposalCard`.
   */
  taskCard: {
    titleLine(taskId: number, title: string): string {
      return `📌 T${String(taskId)} · ${title}`;
    },
    statusLine(statusLabel: string, priorityLabel: string): string {
      return `Статус: ${statusLabel} · Приоритет: ${priorityLabel}`;
    },
    statusOpen: 'открыта',
    statusInProgress: 'в работе',
    statusDone: 'выполнена',
    statusCancelled: 'отменена',
    descriptionLine(description: string): string {
      return `📝 ${description}`;
    },
    doneButton: '✅ Выполнено',
    startButton: '▶️ В работу',
    editButton: '✏️ Изменить',
    snoozeButton: '⏰ Отложить',
    cancelButton: '🗑 Отменить',
    historyButton: '📜 История',
    restoreButton: '♻️ Восстановить',
    deleteForeverButton: '🗑 Удалить навсегда',
    backButton: '↩️ К задаче',
    /** The card's own "edit" button opened the dialog, but the task is no longer in an editable (open/
     * in_progress) state (e.g. it was archived by another update while the card sat open). */
    editArchived: 'Эта задача в архиве. Сначала восстановите её, чтобы изменить.',
    /** Shared "задача не найдена" reply (brief scenario 9, Фокус ревью 2) — every `v1:t:*` button looks the
     * task up fresh before acting; a stale callback referencing an already-deleted/non-existent task gets
     * this instead of a thrown exception. */
    notFound: 'Задача не найдена.',
    /** "🗑 Удалить навсегда"'s own two-step confirmation (SPEC §12.4: "с двойным подтверждением") — the
     * initial press shows this first screen. */
    deleteConfirm1(taskId: number, title: string): string {
      return `Удалить задачу T${String(taskId)} «${title}» навсегда? Это действие нельзя отменить.`;
    },
    /** The first confirmation's own follow-up — the *second* of the two required confirmations. */
    deleteConfirm2:
      'Вы точно уверены? Будут безвозвратно удалены сама задача, её история и все уведомления по ней.',
    deleteConfirmButton: 'Да, продолжить',
    deleteForeverConfirmButton: 'Да, удалить навсегда',
    deleteCancelButton: '↩️ Отмена',
    deletedConfirm(taskId: number, title: string): string {
      return `🗑 Задача T${String(taskId)} «${title}» удалена навсегда.`;
    },
    /** `src/bot/conversations/editTask.ts`'s own menu header — distinct from `texts.editProposal.menuHeader`
     * only in that this edits an *existing* task rather than a not-yet-created one; its field menu/submenus
     * otherwise reuse `texts.editProposal`'s own wording directly (field names, due/assignee/priority
     * submenu titles and buttons, free-text date prompt/preview) since none of it is proposal-specific. */
    editMenuHeader: '✏️ Изменение задачи',
    /** Reuses every other button/prompt from `texts.editProposal`, but needs its own save label:
     * `texts.editProposal.saveButton` ("Сохранить и создать") always creates a task, which is wrong wording
     * for editing one that already exists. */
    editSaveButton: '✅ Сохранить',
    editSaved(taskId: number, title: string): string {
      return `✅ Сохранено: T${String(taskId)} «${title}»`;
    },
  },
  /**
   * The task card's "📜 История" button (`src/bot/views/history.ts`, plan.md Task 3.6, SPEC §12.4's "все
   * изменения пишутся в task_events") — the last 20 `task_events` rows for one task, newest first, dates in
   * the viewer's own zone (the Owner's — only they ever see this). `actor*`/`type*` cover
   * `task_events.actor_type`/`.type`'s known values (`src/domain/tasks/events.ts`); `typeOther` is the
   * fallback for a `type` this list doesn't name individually.
   */
  taskHistory: {
    header(taskId: number, title: string): string {
      return `📜 История задачи T${String(taskId)} «${title}»`;
    },
    empty: 'Событий пока нет.',
    line(dateLabel: string, actor: string, typeLabel: string): string {
      return `${dateLabel} · ${actor} · ${typeLabel}`;
    },
    actorSystem: 'Система',
    actorAi: 'ИИ',
    actorApple: 'Apple Reminders',
    /** `actor_type === 'user'` but the membership couldn't be resolved (should not normally happen). */
    actorUnknownUser: 'Пользователь',
    typeCreated: 'Создана',
    typeUpdated: 'Изменена',
    typeStatusChanged: 'Статус изменён',
    typeOther(type: string): string {
      return `Событие: ${type}`;
    },
  },
  /**
   * `/tasks`/`/today`/`/overdue`/`/archive` (`src/bot/views/taskList.ts`/`src/bot/handlers/lists.ts`,
   * plan.md Task 3.7, SPEC §12.3) — Owner only (D40, `task.viewAll`). `row`'s marker is `rowMarker`'s own
   * `'🔴'|'🔵'|'🟡'|'⚪'` (D24); `title`/`assignee` arrive already HTML-escaped by the caller, same
   * convention as `texts.taskCard`. `pageFooter`'s lowercase, no-period "стр N/M" is SPEC §12.3's own
   * literal wording (distinct from `texts.inbox.pageFooter`'s "Стр. N/M" — each list screen keeps its own
   * copy rather than sharing one, same stance `texts.taskCard`/`texts.reminders` already take on
   * near-identical lines elsewhere in this file).
   */
  taskList: {
    headerOpen: '📋 Открытые задачи',
    headerToday: '🟡 Сегодня',
    headerOverdue: '🔴 Просрочено',
    headerNoDue: '⚪ Без срока',
    /** `/today` (SPEC §12.2: "на сегодня + просроченные") — distinct from the filter row's own
     * `headerOverdue`/`headerToday`, which are each a single bucket. */
    headerTodayAndOverdue: '📅 Сегодня и просроченные',
    headerArchive: '🗄 Архив',
    headerAssignee(name: string): string {
      return `👤 Исполнитель: ${name}`;
    },
    headerChat(title: string): string {
      return `💬 Чат: ${title}`;
    },
    /** No tasks matched the current filter/page. */
    empty: 'Нет задач по этому фильтру.',
    /** One list row (SPEC §12.3): `marker T<id> <title> — <assignee> · <due>`. */
    row(marker: string, taskId: number, title: string, assignee: string, due: string): string {
      return `${marker} T${String(taskId)} ${title} — ${assignee} · ${due}`;
    },
    /** A row's own due column when the task has no due date at all (distinct from `texts.formatDue`'s
     * identical wording — this is a list-row fragment, not a full due-date line). */
    noDueLabel: 'без срока',
    pageFooter(page: number, totalPages: number): string {
      return `стр ${String(page)}/${String(totalPages)}`;
    },
    prevButton: '◀️',
    nextButton: '▶️',
    filterAllButton: '📋 Все открытые',
    filterTodayButton: '🟡 Сегодня',
    filterOverdueButton: '🔴 Просрочено',
    filterNoDueButton: '⚪ Без срока',
    filterAssigneeButton: '👤 По исполнителю ▾',
    filterChatButton: '💬 По чату ▾',
    assigneeMenuHeader: '👤 По какому исполнителю показать задачи?',
    chatMenuHeader: '💬 По какому чату показать задачи?',
    /** The "По чату ▾" picker has nothing to list (no chats attached to the workspace yet). */
    chatMenuEmpty: 'У этого рабочего пространства пока нет чатов.',
    /** A `chats.title`-less chat's own picker button/header label (same "без названия" fallback
     * `texts.inbox.itemButton` already uses for an untitled chat). */
    chatUntitled: 'без названия',
    backButton: '↩️ Назад',
  },
  /**
   * The morning summary (`src/scheduler/jobs/summary.ts`/`src/bot/views/summary.ts`, plan.md Task 3.5,
   * SPEC §13.4) — Owner only (D40, no "Ждут вашей проверки" section, since the review flow is
   * Member-only and was removed). Section order: overdue, today, unprocessed proposals, no-due — an empty
   * section is simply left out, and `allEmpty` replaces the whole body when every section is empty.
   * `sectionMore`/no-due's own overflow line reuse the same "ещё N → /tasks" convention as
   * `texts.reminders.overdueDigestMore`.
   */
  summary: {
    /** `dateLabel` is `src/time/format.ts`'s `formatDateLabel` output, e.g. `пт, 25 сен`. */
    header(dateLabel: string): string {
      return `☀️ Доброе утро! Сводка на ${dateLabel}`;
    },
    overdueHeader(count: number): string {
      return `🔴 Просрочено (${String(count)}):`;
    },
    todayHeader(count: number): string {
      return `🟡 Сегодня (${String(count)}):`;
    },
    inboxLine(count: number): string {
      return `📥 Неразобранные предложения: ${String(count)} → /inbox`;
    },
    /** `count` is the section's true total (`noDueTotal`), even when the body below only shows the top 5. */
    noDueHeader(count: number): string {
      return `⚪ Без срока (${String(count)}):`;
    },
    /** A no-due task never has a due date to show (that's the whole section), so its line is just the
     * title, unlike `texts.reminders.overdueDigestLine`'s own `title — due` shape. */
    noDueItemLine(taskId: number, title: string): string {
      return `• T${String(taskId)} «${title}»`;
    },
    /** Any section's own overflow footer, once its item list had to be cut short — `src/bot/views/
     * summary.ts`'s `renderSummary` budgets Telegram's 4096-char limit (CLAUDE.md) across every section. */
    sectionMore(count: number): string {
      return `… ещё ${String(count)} → /tasks`;
    },
    /** Every section empty (SPEC §13.4). */
    allEmpty: 'Задач на сегодня нет 🎉',
    allTasksButton: '📋 Все задачи',
  },
  /**
   * `/inbox` (SPEC §12.2 row, Owner only — D40, Task 2.15): every still-`pending` proposal (`shown` *and*
   * `suppressed` alike — this is deliberately the one place a `suppressed` proposal is ever surfaced to
   * the Owner, so a message the auto-pipeline hid below threshold is never permanently lost, CLAUDE.md's
   * "a missed task is worse than a false positive"), `PAGE_SIZE` per page. Tapping a list button resends
   * that proposal's card as a fresh DM message (`src/scheduler/jobs/cards.ts`'s `renderProposalCardForResend`) —
   * this list itself never carries the accept/reject buttons, only the resend/pagination ones.
   */
  inbox: {
    header: '📥 Входящие предложения',
    /** No `pending` proposals at all right now. */
    empty: 'Нет неразобранных предложений.',
    pageFooter(page: number, totalPages: number): string {
      return `Стр. ${String(page)}/${String(totalPages)}`;
    },
    /** One list row's button label — `title`/`chatTitle` are plain (unescaped: Telegram button text isn't HTML-parsed, CLAUDE.md's `escapeHtml` rule is for `parse_mode: 'HTML'` message bodies only). */
    itemButton(icon: string, title: string, chatTitle: string | null): string {
      const safeTitle = title === '' ? 'без названия' : title;
      return chatTitle === null ? `${icon} ${safeTitle}` : `${icon} ${safeTitle} — ${chatTitle}`;
    },
    kindCreateIcon: '🆕',
    kindUpdateIcon: '✏️',
    kindCompleteIcon: '✅',
    kindCancelIcon: '❌',
    prevButton: '« Назад',
    nextButton: 'Вперёд »',
    /** `answerCallbackQuery` toast once the tapped proposal's card has been resent. */
    resent: 'Карточка отправлена заново.',
    /** The tapped proposal could no longer be rendered as a card (SPEC §11.1's D44 gap, or its target task/chat is gone) — same "skip, don't crash" stance as `cardsJob`'s own `buildCardView`. */
    cardUnavailable: 'Не удалось собрать карточку для этого предложения.',
    /** The tapped proposal is no longer `pending` (decided or expired between opening `/inbox` and tapping it). */
    noLongerPending: 'Это предложение уже не в очереди — обновите список.',
  },
  /**
   * Labels prefixed to a media message's caption when normalizing incoming
   * messages (SPEC §7.2, `src/bot/handlers/normalize.ts`'s `normalizeIncoming`).
   */
  media: {
    photo: '[фото]',
    document: '[документ]',
    video: '[видео]',
    audio: '[аудио]',
    gif: '[gif]',
  },
  claim: {
    /** Sent when `/claim` is invoked with no code argument. */
    usage: 'Введите код после команды, например: <code>/claim ABCD2345</code>.',
    /** Sent after a successful `/claim` — the sender is now the workspace's owner. */
    success: 'Готово! Теперь вы — владелец. Список доступных команд смотрите в /help.',
    /** No `claim_codes` row matches the given code at all. */
    invalid: 'Код не найден. Проверьте, пожалуйста, что ввели его правильно.',
    /** The code matched but its `expires_at` is in the past. */
    expired: 'Срок действия кода истёк. Попросите новый через /transfer.',
    /** The code matched but was already redeemed. */
    used: 'Этот код уже использован.',
  },
  /**
   * Short (Telegram menu, ≤256 chars) descriptions for `setMyCommands`
   * (Task 1.11, `src/bot/commands.ts`'s `syncCommands`) — one entry per
   * command SPEC §12.2 lists, keyed by command name without the leading `/`.
   * Deliberately no `my` entry (D40 drops `/my` entirely).
   */
  commands: {
    start: 'Регистрация, часовой пояс, краткая справка',
    tasks: 'Открытые задачи',
    today: 'Задачи на сегодня и просроченные',
    overdue: 'Просроченные задачи',
    inbox: 'Неразобранные предложения',
    new: 'Создать задачу',
    archive: 'Выполненные и отменённые задачи',
    search: 'Поиск по названию и описанию задач',
    stats: 'Статистика по сотрудникам',
    people: 'Участники: имена, алиасы, часовой пояс',
    chats: 'Чаты: статус, анализ, реакции, пауза',
    settings: 'Настройки бота',
    transfer: 'Код передачи владения',
    timezone: 'Часовой пояс',
    privacy: 'Что бот делает с данными',
    help: 'Справка по вашей роли',
    claim: 'Стать владельцем по одноразовому коду',
    task: 'Создать задачу из сообщения',
    admin: 'Панель администратора',
    debug: 'Диагностика последнего анализа чата',
    reanalyze: 'Повторно проанализировать последние сообщения',
  },
  /**
   * `/search <текст>` (plan.md Task 3.8, SPEC §12.2) — Owner only (D40, `task.viewAll`). Result rows reuse
   * `texts.taskList.row`/`pageFooter`/`prevButton`/`nextButton` directly (`src/bot/handlers/search.ts`
   * builds the view) rather than a second copy of those; this namespace only holds what's actually new.
   * `header`'s `query` must already be HTML-escaped by the caller, same convention
   * `texts.taskList.headerAssignee`'s `name` already uses — the quoted query is also how
   * `src/bot/handlers/search.ts` recovers the original search text for its own "▶️ next page" callback
   * (parsed back out of this exact message, since `callback_data`'s charset can't carry arbitrary
   * free-text/Cyrillic — see that file's own doc comment), so this exact `«…»` shape is load-bearing, not
   * just decorative.
   */
  search: {
    usage: 'Введите текст для поиска, например: <code>/search расписание</code>.',
    header(query: string): string {
      return `🔍 Поиск: «${query}»`;
    },
    /** The search matched nothing at all (distinct from `texts.taskList.empty`'s "nothing in this filter"
     * wording — a search finding nothing isn't the same situation). */
    empty: 'Ничего не найдено.',
    /** The message this pagination callback points at no longer carries a parseable query — SPEC §12.2's
     * own "a missed task is worse than a false positive" stance means a best-effort re-parse that fails
     * must say so plainly rather than silently showing the wrong results. */
    expired: 'Результаты поиска устарели — выполните /search ещё раз.',
  },
  /**
   * `/stats` (plan.md Task 3.8, SPEC §12.5) — Owner only (D40, `task.viewAll`). One block per assignee
   * (`src/bot/views/stats.ts`'s `renderStats` picks each block's own icon — 👤/👑/❓ — based on
   * `TaskStatsRow.key.type`, this namespace only holds the Russian wording itself) plus the `[7] [30] [90]`
   * period-switch row.
   */
  stats: {
    header(periodDays: number): string {
      return `📊 Статистика за ${String(periodDays)} дней`;
    },
    /** SPEC §12.5's own wording for the workspace Owner's own "delegated to myself" row — kept as the
     * Latin "Owner" (SPEC §12.5 itself writes it this way, unlike every other label in this file). */
    ownerLabel: 'Owner',
    noneLabel: 'Без исполнителя',
    /** No task in the cohort at all for the selected period. */
    empty: 'За этот период задач нет.',
    periodButton(periodDays: number): string {
      return `${String(periodDays)} дн.`;
    },
    /** The currently-selected period's own button, visually marked so the Owner can see which window the
     * numbers below belong to. */
    periodButtonActive(periodDays: number): string {
      return `• ${String(periodDays)} дн. •`;
    },
    /** One assignee's own block — `name` already carries its own icon prefix (`renderStats`'s job);
     * `onTimePct`/`avgLateHours` of `null` (no `done` tasks / no late ones) read as `NO_DATA_LABEL`. */
    row(
      name: string,
      open: number,
      inProgress: number,
      overdueNow: number,
      done: number,
      onTimePct: number | null,
      avgLateHours: number | null,
    ): string {
      const onTime = onTimePct === null ? NO_DATA_LABEL : `${String(onTimePct)}%`;
      const roundedLate = avgLateHours === null ? null : Math.round(avgLateHours);
      const late =
        roundedLate === null ? NO_DATA_LABEL : `${String(roundedLate)} ${pluralizeChas(roundedLate)}`;
      return [
        name,
        `Открыто: ${String(open)} · В работе: ${String(inProgress)} · Просрочено сейчас: ${String(overdueNow)}`,
        `Выполнено: ${String(done)} · В срок: ${onTime} · Опоздание в среднем: ${late}`,
      ].join('\n');
    },
  },
};
