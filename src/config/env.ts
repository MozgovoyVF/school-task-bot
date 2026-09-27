import { z } from 'zod';
import { IANAZone } from 'luxon';
import { DEFAULT_WORKSPACE_NAME } from './constants.js';

/**
 * Validated application configuration, built from process.env (or an
 * injected source, e.g. in tests) via {@link loadEnv}.
 *
 * See SPEC §26 for the canonical list of variables and plan.md decision D21
 * for GIT_SHA.
 */

export class EnvError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'EnvError';
    this.issues = issues;
  }
}

function requiredString() {
  return z.string({
    error: (issue) => (issue.input === undefined ? 'Required' : undefined),
  });
}

/** Parses a comma-separated list of positive Telegram IDs, e.g. "111, 222". */
function tgIdList() {
  return requiredString().transform((value, ctx) => {
    const ids = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => {
        const id = Number(part);
        if (!Number.isInteger(id) || id <= 0) {
          ctx.addIssue({ code: 'custom', message: `invalid Telegram ID "${part}"` });
          return null;
        }
        return id;
      });
    if (ids.some((id) => id === null)) return z.NEVER;
    if (ids.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'must list at least one Telegram ID' });
      return z.NEVER;
    }
    return ids as number[];
  });
}

/** Parses a single optional positive Telegram ID. */
function tgId() {
  return z
    .string()
    .transform((value, ctx) => {
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) {
        ctx.addIssue({ code: 'custom', message: `invalid Telegram ID "${value}"` });
        return z.NEVER;
      }
      return id;
    })
    .optional();
}

function boolFlag(defaultValue: boolean) {
  return z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(defaultValue);
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url);
  } catch {
    return false;
  }
}

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    APP_ENV: z.enum(['dev', 'prod']).default('dev'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    TELEGRAM_BOT_TOKEN: requiredString(),
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
    TELEGRAM_WEBHOOK_URL: z.string().refine(isValidUrl, 'must be a valid URL').optional(),
    TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

    SUPERADMIN_TG_IDS: tgIdList(),
    BOOTSTRAP_OWNER_TG_ID: tgId(),

    DEFAULT_WORKSPACE_NAME: z.string().default(DEFAULT_WORKSPACE_NAME),
    DEFAULT_TIMEZONE: z
      .string()
      .refine((tz) => IANAZone.isValidZone(tz), 'must be a valid IANA time zone')
      .default('Europe/Moscow'),

    DATABASE_URL: requiredString(),
    MIGRATE_ON_START: boolFlag(true),

    LLM_PROVIDER: z.string().default('openrouter'),
    OPENROUTER_API_KEY: z.string().optional(),
    LLM_MODEL_PRIMARY: z.string().optional(),
    LLM_MODEL_FALLBACK: z.string().optional(),
    LLM_DAILY_BUDGET_USD: z.coerce.number().positive().default(1),

    AI_PREFILTER: z.enum(['off', 'jev', 'llm']).default('off'),
    AI_PREFILTER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.15),
    TYPESAFE_API_KEY: z.string().optional(),

    HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_BASE_URL: z.string().refine(isValidUrl, 'must be a valid URL').optional(),
    BACKUP_AGE_RECIPIENT: z.string().optional(),

    GIT_SHA: z.string().default('dev'),
  })
  .superRefine((env, ctx) => {
    if (env.TELEGRAM_MODE === 'webhook') {
      if (!env.TELEGRAM_WEBHOOK_URL) {
        ctx.addIssue({
          code: 'custom',
          path: ['TELEGRAM_WEBHOOK_URL'],
          message: 'required when TELEGRAM_MODE=webhook',
        });
      }
      if (!env.TELEGRAM_WEBHOOK_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['TELEGRAM_WEBHOOK_SECRET'],
          message: 'required when TELEGRAM_MODE=webhook',
        });
      }
    }
    if (env.AI_PREFILTER === 'jev' && !env.TYPESAFE_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['TYPESAFE_API_KEY'],
        message: 'required when AI_PREFILTER=jev',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function stripEmptyStrings(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    result[key] = value === '' ? undefined : value;
  }
  return result;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const raw = stripEmptyStrings(source);
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new EnvError(issues);
  }
  return result.data;
}
