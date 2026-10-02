import { z } from 'zod';
import { loadEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import { isEntrypoint } from '../src/ops/entrypoint.js';
import {
  feedbackStats,
  type ConfidenceBucket,
  type FeedbackByCategory,
  type FeedbackSample,
  type FeedbackStats,
} from '../src/domain/proposals/feedback.js';

// SPEC §20.4 / plan.md Task 3.13 — `pnpm feedback-report`'s CLI entry point. Reads the Owner's accept/
// reject decisions on `proposals` and prints a Markdown digest of where the model tends to be wrong
// (categories, reject reasons, which fields the Owner edits before accepting, accuracy by confidence
// bucket) for local review. Read-only: never writes to the DB, never calls the LLM, and (without
// `--with-text`) never prints a single task title or quote — only category labels and counts.

const DEFAULT_LOOKBACK_DAYS = 30;

interface CliArgs {
  since: Date;
  withText: boolean;
}

// External input (process.argv) — goes through zod, CLAUDE.md §8.
const RawCliArgsSchema = z.object({
  since: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
  withText: z.boolean().default(false),
});

/** Minimal hand-rolled `--flag value` / `--flag` parser (no CLI-args dependency in SPEC §4's allowlist) —
 * mirrors `eval/run.ts`'s own `parseArgv`. */
function toCamelCase(key: string): string {
  return key.replace(/-([a-z])/g, (_match, c: string) => c.toUpperCase());
}

function parseArgv(argv: readonly string[], defaultSince: Date): CliArgs {
  const raw: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = toCamelCase(token.slice(2));
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      raw[key] = next;
      i += 1;
    } else {
      raw[key] = true;
    }
  }
  const parsed = RawCliArgsSchema.parse(raw);
  return {
    since: parsed.since !== undefined ? new Date(parsed.since) : defaultSince,
    withText: parsed.withText,
  };
}

// -- Markdown rendering ----------------------------------------------------

function renderByCategory(byCategory: FeedbackByCategory): string {
  const categories = Object.keys(byCategory).sort();
  if (categories.length === 0) return '_No proposals in this period._\n';
  const lines = ['| Category | Shown | Accepted | Rejected |', '| --- | ---: | ---: | ---: |'];
  for (const category of categories) {
    const c = byCategory[category];
    if (!c) continue;
    lines.push(`| ${category} | ${String(c.shown)} | ${String(c.accepted)} | ${String(c.rejected)} |`);
  }
  return lines.join('\n') + '\n';
}

function renderCounts(title: string, counts: Record<string, number>): string {
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) return `### ${title}\n\n_None._\n`;
  const lines = [`### ${title}`, '', '| Key | Count |', '| --- | ---: |'];
  for (const key of keys) {
    lines.push(`| ${key} | ${String(counts[key])} |`);
  }
  return lines.join('\n') + '\n';
}

function renderConfidenceBuckets(buckets: readonly ConfidenceBucket[]): string {
  const lines = ['| Confidence | Accepted | Rejected | Accuracy |', '| --- | ---: | ---: | ---: |'];
  for (const b of buckets) {
    const total = b.accepted + b.rejected;
    const accuracy = total > 0 ? `${((b.accepted / total) * 100).toFixed(1)}%` : 'n/a';
    lines.push(
      `| [${b.from.toFixed(2)}, ${b.to.toFixed(2)}${b.to === 1 ? ']' : ')'} | ${String(b.accepted)} | ${String(b.rejected)} | ${accuracy} |`,
    );
  }
  return lines.join('\n') + '\n';
}

function renderSamples(samples: readonly FeedbackSample[]): string {
  if (samples.length === 0) return '_None._\n';
  const lines: string[] = [];
  for (const s of samples) {
    const quote = s.quote !== null ? ` — _"${s.quote}"_` : '';
    lines.push(`- [${s.decision}] ${s.title}${quote}`);
  }
  return lines.join('\n') + '\n';
}

function renderReport(stats: FeedbackStats, since: Date, withText: boolean): string {
  const parts = [
    '# Proposal feedback report',
    '',
    `Period: since ${since.toISOString()}`,
    '',
    '## By category',
    '',
    renderByCategory(stats.byCategory),
    renderCounts('Reject reasons', stats.rejectReasons),
    '',
    renderCounts('Edited fields before accept', stats.editedFields),
    '',
    '### Accuracy by confidence bucket',
    '',
    renderConfidenceBuckets(stats.confidenceBuckets),
  ];

  if (withText && stats.samples) {
    parts.push('', '### Samples (local analysis only)', '', renderSamples(stats.samples));
  }

  return parts.join('\n') + '\n';
}

async function main(): Promise<void> {
  const defaultSince = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const args = parseArgv(process.argv.slice(2), defaultSince);

  if (args.withText) {
    console.error(
      '[feedback-report] --with-text включает реальные названия задач и цитаты из сообщений — ' +
        'только для локального разбора. Не коммитить, не пересылать, не вставлять в чаты/issues.',
    );
  }

  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);
  try {
    const stats = await feedbackStats(db, { since: args.since, withText: args.withText });
    console.log(renderReport(stats, args.since, args.withText));
  } finally {
    await close();
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  await main();
}
