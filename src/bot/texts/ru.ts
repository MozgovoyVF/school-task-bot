/**
 * All user-facing (and, for now, superadmin-facing) strings live here
 * (CLAUDE.md §8): this is the only file allowed to contain Cyrillic outside
 * `src/config/constants.ts`. Telegram uses `parse_mode: 'HTML'` everywhere,
 * so any dynamic value interpolated into a string here must be escaped first.
 */

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
    /** `/start`/`/help` response for a recognized superadmin. */
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
    /** `/start`/`/help` response for anyone the bot does not yet recognize (no owner/member concept before phase 1). */
    stranger(): string {
      return (
        'Этот бот работает для сотрудников школы французского языка и настраивается её руководителем. ' +
        'Если вы сотрудник и должны иметь доступ, обратитесь, пожалуйста, к руководителю школы.'
      );
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
  },
};
