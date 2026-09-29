import { DateTime } from 'luxon';
import type { AssigneeResolution, ResolvedAction } from '../src/ai/pipeline/resolve.js';
import type { ResolvedDue } from '../src/time/resolveDue.js';
import type { EvalCase } from './schema.js';

type ExpectedAction = EvalCase['expected'][number];

export interface EvalRow {
  caseId: string;
  expected: EvalCase['expected'];
  predicted: Array<ResolvedAction & { decision: 'shown' | 'suppressed' }>;
  /**
   * `expected[i].due` (when present) run through `resolveDue` by the
   * caller (`eval/run.ts`, using the case's own `now`/`workspaceTz` and the
   * default `fuzzyTimes` settings) — `null` for an expected item with no
   * `due` at all (`complete`/`cancel`, or an `update` with no due change)
   * *or* one that resolved to no due date. Parallel to `expected` by index.
   */
  resolvedExpectedDue: Array<Date | null>;
  costUsd: number;
  latencyMs: number;
}

export interface Metrics {
  n: number;
  recall: number;
  precision: number;
  typeAccuracy: number;
  categoryAccuracy: number;
  assigneeAccuracy: number;
  dueAccuracy: number;
  costPer100: number;
  avgLatencyMs: number;
}

export type RowClassification = 'TP' | 'FN' | 'FP' | 'TN';

export interface RowExplanation {
  classification: RowClassification;
  /** Human-readable mismatch notes, e.g. "category: expected assignment, got event". English on purpose — internal eval tooling output, not bot UI text (CLAUDE.md confines Cyrillic to `src/bot/texts/ru.ts`, and eval/ is outside `src/` anyway). */
  mismatches: string[];
}

/**
 * The synthetic `userId` convention `eval/run.ts` uses when it builds a
 * `ResolveContext` for a case with no real DB rows: the workspace owner
 * always gets this id. {@link assigneeMatches} below decodes an
 * `EvalCase`'s expected `assignee` string ("OWNER"/"ALL"/"P<N>"/`null`)
 * back through the exact same convention — the two must never drift apart.
 */
export const EVAL_OWNER_USER_ID = 0;

/** `"P7"` -> `7`; `"OWNER"` -> {@link EVAL_OWNER_USER_ID}. Throws on anything else (a dataset bug, not a real-world case to score gracefully). */
export function participantCodeToUserId(code: string): number {
  if (code === 'OWNER') return EVAL_OWNER_USER_ID;
  const match = /^P(\d+)$/.exec(code);
  if (match?.[1] === undefined) {
    throw new Error(`participantCodeToUserId: unrecognized participant code "${code}"`);
  }
  return Number(match[1]);
}

/** Denominator-is-zero default: with nothing to get wrong, the metric is vacuously perfect rather than `NaN`. */
function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function assigneeMatches(predicted: AssigneeResolution, expectedCode: string | null): boolean {
  if (expectedCode === null) return predicted.type === 'none';
  if (expectedCode === 'ALL') return predicted.type === 'all';
  if (predicted.type !== 'user') return false;
  try {
    return predicted.userId === participantCodeToUserId(expectedCode);
  } catch {
    return false;
  }
}

function targetRefOf(target: { taskId: number } | { proposalId: number }): string {
  return 'taskId' in target ? `T${String(target.taskId)}` : `R${String(target.proposalId)}`;
}

function dueOf(action: ResolvedAction): ResolvedDue | null {
  if (action.kind === 'create') return action.due;
  if (action.kind === 'update') return action.changes.due ?? null;
  return null;
}

/**
 * Brief step 1.4: "всё, что не all-day, должно совпадать с точностью до
 * минуты; у all-day — дата." All-day-ness is read off the *predicted*
 * action's own `ResolvedDue.allDay` (the expected side only ever reaches
 * here as a bare `Date`, via `resolvedExpectedDue`) — the two sides agree
 * on it in practice, since both go through the same `resolveDue` given
 * matching date/hint input.
 */
function dueMatches(expectedDueAt: Date, predicted: ResolvedDue): boolean {
  if (predicted.dueAt === null) return false;
  if (!predicted.allDay) return expectedDueAt.getTime() === predicted.dueAt.getTime();
  const zone = predicted.tz ?? 'UTC';
  return (
    DateTime.fromJSDate(expectedDueAt).setZone(zone).toISODate() ===
    DateTime.fromJSDate(predicted.dueAt).setZone(zone).toISODate()
  );
}

/**
 * Picks, among `shown` predicted actions not already in `used`, the one
 * that pairs with `exp` for scoring purposes (brief step 1.2: "по типу и
 * targetRef, для create — по категории"). `type` always gates the pairing
 * (an expected `create` never pairs with a predicted `update`, etc.);
 * `update`/`complete`/`cancel` additionally require the same `targetRef`
 * (there may be several open tasks/proposals in a batch); `create` has no
 * `targetRef` to key on, so among same-typed candidates it prefers one
 * whose `category` also matches (falling back to the first if none does —
 * this is what lets a category *mismatch* still register as a match, per
 * the brief's own example: "верный тип при неверной категории").
 */
function findMatchIndex(
  shown: ReadonlyArray<ResolvedAction & { decision: 'shown' | 'suppressed' }>,
  used: ReadonlySet<number>,
  exp: ExpectedAction,
): number | undefined {
  const candidates: number[] = [];
  shown.forEach((predicted, index) => {
    if (used.has(index) || predicted.kind !== exp.type) return;
    if (exp.type === 'create') {
      candidates.push(index);
      return;
    }
    if ('target' in predicted && targetRefOf(predicted.target) === exp.targetRef) candidates.push(index);
  });
  if (candidates.length === 0) return undefined;
  if (exp.type === 'create' && exp.category !== undefined) {
    const withCategory = candidates.find((index) => {
      const predicted = shown[index];
      return predicted?.kind === 'create' && predicted.category === exp.category;
    });
    if (withCategory !== undefined) return withCategory;
  }
  return candidates[0];
}

interface RowScore {
  classification: RowClassification;
  typeTotal: number;
  typeCorrect: number;
  categoryTotal: number;
  categoryCorrect: number;
  assigneeTotal: number;
  assigneeCorrect: number;
  dueTotal: number;
  dueCorrect: number;
  mismatches: string[];
}

/**
 * Scores one case (brief step 1's five rules): TP/FN/FP/TN are decided at
 * case level ("TP: ожидалось и показано" — an expected action existed and
 * *something* was shown for this case, not necessarily the right thing),
 * matching the brief's own worked example (4 whole cases -> one of each
 * classification -> recall 0.5, precision 0.5). `typeAccuracy` and friends
 * are then scored separately, per matched expected/predicted pair found by
 * {@link findMatchIndex} — an expected item with no same-typed match still
 * counts toward `typeAccuracy`'s denominator (a real miss), but category/
 * assignee/due accuracy are conditional on a match having been found at all
 * (there is nothing to compare otherwise). Suppressed predicted actions are
 * filtered out up front (step 1.5): they were never shown to the Owner, so
 * they can neither satisfy an expectation nor count as a false positive.
 */
function scoreRow(row: EvalRow): RowScore {
  const shown = row.predicted.filter((p) => p.decision === 'shown');
  const expectedCount = row.expected.length;

  let classification: RowClassification;
  if (expectedCount > 0 && shown.length > 0) classification = 'TP';
  else if (expectedCount > 0) classification = 'FN';
  else if (shown.length > 0) classification = 'FP';
  else classification = 'TN';

  const score: RowScore = {
    classification,
    typeTotal: 0,
    typeCorrect: 0,
    categoryTotal: 0,
    categoryCorrect: 0,
    assigneeTotal: 0,
    assigneeCorrect: 0,
    dueTotal: 0,
    dueCorrect: 0,
    mismatches: [],
  };

  const used = new Set<number>();
  row.expected.forEach((exp, i) => {
    score.typeTotal += 1;
    const matchIndex = findMatchIndex(shown, used, exp);
    if (matchIndex === undefined) {
      score.mismatches.push(`expected ${exp.type} not shown`);
      return;
    }
    used.add(matchIndex);
    score.typeCorrect += 1;
    const predicted = shown[matchIndex];
    if (predicted === undefined) return;

    if (exp.type === 'create' && exp.category !== undefined) {
      score.categoryTotal += 1;
      const ok = predicted.kind === 'create' && predicted.category === exp.category;
      if (ok) score.categoryCorrect += 1;
      else if (predicted.kind === 'create') {
        score.mismatches.push(`category: expected ${exp.category}, got ${predicted.category}`);
      }
    }

    if (exp.type === 'create' && exp.assignee !== undefined && predicted.kind === 'create') {
      score.assigneeTotal += 1;
      if (assigneeMatches(predicted.assignee, exp.assignee)) score.assigneeCorrect += 1;
      else score.mismatches.push(`assignee: expected ${exp.assignee ?? 'none'}`);
    }

    const expectedDueAt = row.resolvedExpectedDue[i] ?? null;
    if (expectedDueAt !== null) {
      score.dueTotal += 1;
      const predictedDue = dueOf(predicted);
      if (predictedDue !== null && dueMatches(expectedDueAt, predictedDue)) score.dueCorrect += 1;
      else score.mismatches.push('due: mismatch');
    }
  });

  for (let i = 0; i < shown.length; i += 1) {
    if (!used.has(i)) {
      const predicted = shown[i];
      const title = predicted?.kind === 'create' ? ` "${predicted.title}"` : '';
      score.mismatches.push(`unexpected ${predicted?.kind}${title} shown`);
    }
  }

  return score;
}

/** Per-case classification and mismatch notes, for `eval/report.ts`'s failures section. */
export function explainRow(row: EvalRow): RowExplanation {
  const score = scoreRow(row);
  return { classification: score.classification, mismatches: score.mismatches };
}

/**
 * Aggregates {@link EvalRow}s (one per eval case) into the dataset-level
 * metrics `eval/report.ts` renders (brief's "Produces" list; SPEC §21).
 */
export function computeMetrics(rows: readonly EvalRow[]): Metrics {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let typeTotal = 0;
  let typeCorrect = 0;
  let categoryTotal = 0;
  let categoryCorrect = 0;
  let assigneeTotal = 0;
  let assigneeCorrect = 0;
  let dueTotal = 0;
  let dueCorrect = 0;
  let costSum = 0;
  let latencySum = 0;

  for (const row of rows) {
    costSum += row.costUsd;
    latencySum += row.latencyMs;
    const score = scoreRow(row);
    if (score.classification === 'TP') tp += 1;
    else if (score.classification === 'FN') fn += 1;
    else if (score.classification === 'FP') fp += 1;

    typeTotal += score.typeTotal;
    typeCorrect += score.typeCorrect;
    categoryTotal += score.categoryTotal;
    categoryCorrect += score.categoryCorrect;
    assigneeTotal += score.assigneeTotal;
    assigneeCorrect += score.assigneeCorrect;
    dueTotal += score.dueTotal;
    dueCorrect += score.dueCorrect;
  }

  const n = rows.length;
  return {
    n,
    recall: safeDiv(tp, tp + fn),
    precision: safeDiv(tp, tp + fp),
    typeAccuracy: safeDiv(typeCorrect, typeTotal),
    categoryAccuracy: safeDiv(categoryCorrect, categoryTotal),
    assigneeAccuracy: safeDiv(assigneeCorrect, assigneeTotal),
    dueAccuracy: safeDiv(dueCorrect, dueTotal),
    costPer100: n === 0 ? 0 : (costSum / n) * 100,
    avgLatencyMs: n === 0 ? 0 : latencySum / n,
  };
}
