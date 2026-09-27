import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Logger } from '../../ops/logger.js';

/**
 * Workspace settings, validated with defaults per SPEC §16. Owner changes the
 * main options via `/settings`, superadmin changes `ai.*`/`batch.*` via
 * `/admin`. Stored as `workspaces.settings` (jsonb); see plan.md Task 1.1.
 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TimeString = z.string().regex(TIME_RE, 'expected HH:mm');

const DateString = z
  .string()
  .regex(DATE_RE, 'expected YYYY-MM-DD')
  .refine((value) => DateTime.fromISO(value).isValid, 'invalid calendar date');

/** ISO weekday: 1 (Monday) .. 7 (Sunday) — plan.md decision D10. */
const IsoWeekday = z.number().int().min(1).max(7);

const SummarySchema = z.object({
  enabled: z.boolean().default(true),
  time: TimeString.default('09:00'),
  forMembers: z.boolean().default(false),
});

const RemindersSchema = z.object({
  preDueTime: TimeString.default('10:00'),
  allDayDueTime: TimeString.default('10:00'),
  overdueTime: TimeString.default('10:00'),
  notifyAssignees: z.boolean().default(true),
  groupOverdueThreshold: z.number().int().positive().default(3),
});

const QuietWindowSchema = z.object({
  from: TimeString,
  to: TimeString,
});

const QuietDateRangeSchema = z.object({
  from: DateString,
  to: DateString,
  label: z.string().optional(),
});

const QuietSchema = z.object({
  enabled: z.boolean().default(false),
  weekdays: z.array(IsoWeekday).default([]),
  windows: z.array(QuietWindowSchema).default([]),
  dateRanges: z.array(QuietDateRangeSchema).default([]),
});

const FuzzyTimesSchema = z.object({
  morning: TimeString.default('10:00'),
  afternoon: TimeString.default('15:00'),
  evening: TimeString.default('19:00'),
  endOfWeekDay: IsoWeekday.default(5),
  endOfWeekTime: TimeString.default('18:00'),
  soonWorkdays: z.number().int().positive().default(2),
  defaultTime: TimeString.default('18:00'),
});

const AiThresholdsSchema = z.object({
  low: z.number().min(0).max(1).default(0.35),
  high: z.number().min(0).max(1).default(0.7),
  modify: z.number().min(0).max(1).default(0.5),
});

const AiAutoCreateSchema = z.object({
  enabled: z.boolean().default(false),
  minConfidence: z.number().min(0).max(1).default(0.9),
});

const AiSchema = z.object({
  thresholds: AiThresholdsSchema.default({ low: 0.35, high: 0.7, modify: 0.5 }),
  autoCreate: AiAutoCreateSchema.default({ enabled: false, minConfidence: 0.9 }),
  proposalExpiryDays: z.number().int().positive().default(7),
});

const BatchSchema = z.object({
  quietSeconds: z.number().int().positive().default(180),
  maxMessages: z.number().int().positive().default(25),
  maxWaitSeconds: z.number().int().positive().default(600),
});

const ReactionsSchema = z.object({
  onDetect: z.string().nullable().default('👀'),
  onAccept: z.string().nullable().default(null),
});

const RetentionSchema = z.object({
  messageDays: z.number().int().positive().default(30),
  batchRawDays: z.number().int().positive().default(30),
});

export const SettingsSchema = z.object({
  summary: SummarySchema.default({ enabled: true, time: '09:00', forMembers: false }),
  reminders: RemindersSchema.default({
    preDueTime: '10:00',
    allDayDueTime: '10:00',
    overdueTime: '10:00',
    notifyAssignees: true,
    groupOverdueThreshold: 3,
  }),
  quiet: QuietSchema.default({ enabled: false, weekdays: [], windows: [], dateRanges: [] }),
  fuzzyTimes: FuzzyTimesSchema.default({
    morning: '10:00',
    afternoon: '15:00',
    evening: '19:00',
    endOfWeekDay: 5,
    endOfWeekTime: '18:00',
    soonWorkdays: 2,
    defaultTime: '18:00',
  }),
  ai: AiSchema.default({
    thresholds: { low: 0.35, high: 0.7, modify: 0.5 },
    autoCreate: { enabled: false, minConfidence: 0.9 },
    proposalExpiryDays: 7,
  }),
  batch: BatchSchema.default({ quietSeconds: 180, maxMessages: 25, maxWaitSeconds: 600 }),
  reactions: ReactionsSchema.default({ onDetect: '👀', onAccept: null }),
  retention: RetentionSchema.default({ messageDays: 30, batchRawDays: 30 }),
  privacyNoticeText: z.string().nullable().default(null),
});

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Recursive partial: object branches may omit any field, at any depth.
 * Arrays (`quiet.weekdays`/`windows`/`dateRanges`) are treated as atomic
 * values — `mergeSettings` replaces them wholesale rather than merging by
 * index, so a patched array stays a full array, not an array of partials.
 */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

type SettingsShape = typeof SettingsSchema.shape;

/**
 * Validates and fills workspace settings from an untrusted source (jsonb
 * from the DB, or `{}`/`null` for a brand-new workspace). Each top-level
 * branch (`summary`, `ai`, …) is parsed independently: an invalid branch
 * falls back to its defaults (logged as a warning) without discarding the
 * other, valid branches — CLAUDE.md §8 requires all external data to go
 * through zod, and SPEC's recall-first priority means a corrupted setting
 * must not crash the caller.
 */
export function parseSettings(raw: unknown, logger?: Logger): Settings {
  const source: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(SettingsSchema.shape) as (keyof SettingsShape)[]) {
    const fieldSchema = SettingsSchema.shape[key];
    const parsed = fieldSchema.safeParse(source[key]);
    if (parsed.success) {
      result[key] = parsed.data;
    } else {
      logger?.warn({ branch: key, issues: parsed.error.issues }, 'invalid workspace settings branch, using defaults');
      // `undefined` always short-circuits to the field's own `.default(...)`.
      result[key] = fieldSchema.parse(undefined);
    }
  }

  return SettingsSchema.parse(result);
}

/**
 * Deep-merges `patch` onto `current` (a fully-populated `Settings`) and
 * re-validates the result, throwing `ZodError` if the merge produced an
 * invalid value (e.g. an out-of-range time or threshold).
 */
export function mergeSettings(current: Settings, patch: DeepPartial<Settings>): Settings {
  const merged = deepMerge(current, patch);
  return SettingsSchema.parse(merged);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(current: unknown, patch: unknown): unknown {
  if (Array.isArray(patch)) return patch;
  if (isPlainObject(patch)) {
    const base = isPlainObject(current) ? current : {};
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      result[key] = deepMerge(base[key], value);
    }
    return result;
  }
  return patch;
}
