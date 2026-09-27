/**
 * All user-facing (and, for now, superadmin-facing) strings live here
 * (CLAUDE.md §8): this is the only file allowed to contain Cyrillic outside
 * `src/config/constants.ts`. Telegram uses `parse_mode: 'HTML'` everywhere,
 * so any dynamic value interpolated into a string here must be escaped first.
 */
import type { RU_ZONES, ZoneLabel } from '../../time/zones.js';
import { CLAIM_CODE_TTL_HOURS } from '../../config/constants.js';

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
  },
  common: {
    /** Sent when a user without the required role invokes a restricted command or callback. */
    forbidden: 'У вас нет доступа к этой команде.',
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
    /** `/start`'s welcome overview for anyone the bot does not yet recognize (no owner/member concept before phase 1). */
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
   * Only `superadmin`/`staff`/`stranger` are distinguished: through Task 1.4,
   * Owner and Member have no commands of their own yet (those arrive in
   * later phases — see plan.md's Phase 1 task list), so both currently get
   * the same `staff` text; `can()` (`src/domain/people/permissions.ts`) has
   * nothing yet to differentiate between them here.
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
    /** `/help` for a recognized Owner or Member (no role-specific commands exist yet — see the doc comment above). */
    staff(): string {
      return ['📋 Доступные команды:', '/timezone — часовой пояс', '/help — эта справка'].join('\n');
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
    /** `/admin` panel for a superadmin: build version and elapsed process uptime. */
    panel(gitSha: string, uptimeSec: number): string {
      return [
        '🛠 Панель администратора',
        `Версия: <code>${escapeHtml(gitSha)}</code>`,
        `Аптайм: ${formatUptime(uptimeSec)}`,
      ].join('\n');
    },
    /** Button on the `/admin` panel that issues a claim code (Task 1.5, `src/bot/handlers/transfer.ts`). */
    ownerCodeButton: 'Код владельца',
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
};
