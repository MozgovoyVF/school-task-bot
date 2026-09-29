import type { Metrics, RowClassification } from './metrics.js';

export interface ReportMeta {
  /** `YYYY-MM-DD` — the report file's own date, not necessarily "today" (kept caller-supplied so tests don't depend on the system clock). */
  date: string;
  model: string;
  fallback: string | null;
  promptVersion: string;
  prefilter: 'off' | 'llm' | 'jev';
  provider: 'openrouter' | 'fixture';
  datasetPath: string;
  actualCostUsd: number;
}

export interface Failure {
  caseId: string;
  classification: RowClassification;
  mismatches: string[];
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/**
 * Failures worth listing in the report: an FN or FP is always a real miss
 * (`scoreRow` already pushed an "expected ... not shown"/"unexpected ...
 * shown" note for it), a TP is only worth listing if it has sub-metric
 * mismatches (wrong category/assignee/due), and a TN — nothing expected,
 * nothing shown — is never a failure at all.
 */
export function reportableFailures(failures: readonly Failure[]): Failure[] {
  return failures.filter(
    (f) => f.classification === 'FN' || f.classification === 'FP' || f.mismatches.length > 0,
  );
}

/**
 * Renders one eval run as a Markdown report (brief step 3; SPEC §21: "Отчёт
 * — Markdown в `eval/reports/`"). Failures are pre-filtered by the caller
 * ({@link reportableFailures}) rather than here, so `eval/run.ts` can also
 * print/log the same filtered list without rendering the report twice.
 */
export function renderReport(meta: ReportMeta, metrics: Metrics, failures: readonly Failure[]): string {
  const lines: string[] = [
    `# Eval report: ${meta.model} / ${meta.promptVersion}`,
    '',
    `- Date: ${meta.date}`,
    `- Provider: ${meta.provider}`,
    `- Model: ${meta.model}${meta.fallback !== null ? ` (fallback: ${meta.fallback})` : ''}`,
    `- Prompt version: ${meta.promptVersion}`,
    `- Prefilter: ${meta.prefilter}`,
    `- Dataset: ${meta.datasetPath} (n=${String(metrics.n)})`,
    `- Actual cost: ${usd(meta.actualCostUsd)}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| n | ${String(metrics.n)} |`,
    `| recall | ${pct(metrics.recall)} |`,
    `| precision | ${pct(metrics.precision)} |`,
    `| typeAccuracy | ${pct(metrics.typeAccuracy)} |`,
    `| categoryAccuracy | ${pct(metrics.categoryAccuracy)} |`,
    `| assigneeAccuracy | ${pct(metrics.assigneeAccuracy)} |`,
    `| dueAccuracy | ${pct(metrics.dueAccuracy)} |`,
    `| cost per 100 cases | ${usd(metrics.costPer100)} |`,
    `| avg latency (ms) | ${metrics.avgLatencyMs.toFixed(0)} |`,
    '',
  ];

  if (failures.length === 0) {
    lines.push('No failures.');
  } else {
    lines.push('## Failures', '');
    for (const f of failures) {
      const suffix = f.mismatches.length > 0 ? `: ${f.mismatches.join('; ')}` : '';
      lines.push(`- \`${f.caseId}\` [${f.classification}]${suffix}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/** Filesystem-safe `<date>-<model>-<prompt>.md` (brief step 3), or `.local.md` for a `--provider fixture` smoke run — see `eval/run.ts`'s doc comment: fixture metrics are a synthetic "perfect echo", not a real model score, so they must never land in the committed `COMPARISON.md` history (`.gitignore` already excludes `eval/reports/*.local.md`). */
export function reportFileName(meta: ReportMeta): string {
  const safe = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const suffix = meta.provider === 'fixture' ? '.local.md' : '.md';
  return `${meta.date}-${safe(meta.model)}-${safe(meta.promptVersion)}${suffix}`;
}

export const COMPARISON_HEADER =
  '| Date | Model | Prompt | Prefilter | n | Recall | Precision | Type | Category | Assignee | Due | Cost/100 | Avg latency (ms) |\n' +
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';

/** One `COMPARISON.md` row (SPEC §21's "сравнительная таблица моделей") for a real (`--provider openrouter`) run only — see {@link reportFileName}. */
export function comparisonRow(meta: ReportMeta, metrics: Metrics): string {
  return (
    `| ${meta.date} | ${meta.model} | ${meta.promptVersion} | ${meta.prefilter} | ${String(metrics.n)} | ` +
    `${pct(metrics.recall)} | ${pct(metrics.precision)} | ${pct(metrics.typeAccuracy)} | ` +
    `${pct(metrics.categoryAccuracy)} | ${pct(metrics.assigneeAccuracy)} | ${pct(metrics.dueAccuracy)} | ` +
    `${usd(metrics.costPer100)} | ${metrics.avgLatencyMs.toFixed(0)} |`
  );
}
