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
};
