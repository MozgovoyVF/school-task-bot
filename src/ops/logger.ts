import pino from 'pino';

/**
 * Application logger type re-export. See SPEC §18 and CLAUDE.md §8: message
 * texts, names and usernames must never be logged at level info or above,
 * and secrets (tokens, API keys) must never be logged at all.
 */
export type Logger = pino.Logger;

/** Depth-limited wildcard prefixes: fast-redact's `*` matches exactly one level. */
const REDACT_DEPTHS = ['', '*.', '*.*.', '*.*.*.'];

/** PII fields: values are replaced by `censor` so operators still see a field existed. */
const PII_KEYS = ['text', 'caption', 'first_name', 'last_name', 'username'];

/**
 * Secret fields: key *names* (e.g. `TELEGRAM_BOT_TOKEN`) contain the sensitive
 * substring themselves, so censoring only the value would still leak it via the
 * key. `redact.paths` in pino only supports one global `remove` flag shared by
 * every path, and we need `remove: false` for PII_KEYS so `censor` is visible.
 * So secret keys are stripped entirely (key + value) up front, in
 * `formatters.log`, which pino runs before `redact` (see pino docs: formatters
 * run before the redact function on the assembled log object). The
 * `*.<SECRET_KEY>` entries below are kept in `redact.paths` too, as
 * defense-in-depth for any shape `stripSecrets` might miss.
 */
const SECRET_KEYS = ['TELEGRAM_BOT_TOKEN', 'OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'authorization', 'token', 'apiKey'];

const redactPaths = [
  ...REDACT_DEPTHS.flatMap((prefix) => PII_KEYS.map((key) => `${prefix}${key}`)),
  ...SECRET_KEYS.map((key) => `*.${key}`),
];

const SECRET_KEY_SET = new Set(SECRET_KEYS);

/** Recursively strips secret-named keys from plain objects/arrays, without mutating the input. */
function stripSecrets(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecrets(item, seen));
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (seen.has(value)) return {};
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEY_SET.has(key)) continue;
      result[key] = stripSecrets(val, seen);
    }
    return result;
  }
  return value;
}

/**
 * Builds the application's pino logger. PII (message texts, captions, names,
 * usernames) up to 3 levels deep is censored via `redact.paths`; secrets
 * (tokens, API keys, authorization headers) are fully stripped at any depth
 * via `formatters.log`, since censoring their value alone would still leak
 * the secret through the key name.
 */
export function createLogger(opts: { level: string; destination?: pino.DestinationStream }): Logger {
  const options: pino.LoggerOptions = {
    level: opts.level,
    formatters: {
      log(object) {
        return stripSecrets(object, new WeakSet<object>()) as Record<string, unknown>;
      },
    },
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}
