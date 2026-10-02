import { gte } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { proposals } from '../../db/schema/index.js';
import { parseProposalPayload, type ProposalRow } from './repo.js';

/** Per-`proposals.category` counts (SPEC §20.4): how many rows of that category were ever shown to the
 * Owner on a card (`policy_decision='shown'`), and of those/other rows in the same category, how many the
 * Owner accepted or rejected. `category` is `null` for a handful of legacy/unclassified rows — bucketed
 * under `'unknown'` so a `feedbackStats` caller never has to special-case a missing key. */
export type FeedbackByCategory = Record<string, { shown: number; accepted: number; rejected: number }>;

/** One confidence bucket's decided-proposal counts — `accepted / (accepted + rejected)` is this bucket's
 * empirical accuracy, the whole point of SPEC §20.4's "accuracy by confidence" breakdown. Only `accepted`/
 * `rejected` rows count; a still-`pending`/`expired`/`superseded` row was never decided and carries no
 * accuracy signal. */
export interface ConfidenceBucket {
  from: number;
  to: number;
  accepted: number;
  rejected: number;
}

/** One decided proposal's free text (`payload.title`/`payload.quote`), only ever populated when
 * `feedbackStats` is called with `withText: true` — see that function's doc comment for why this is the
 * one field the whole module exists to gate. */
export interface FeedbackSample {
  title: string;
  quote: string | null;
  decision: ProposalRow['status'];
}

export interface FeedbackStats {
  byCategory: FeedbackByCategory;
  /** Counts of `proposals.reject_reason` among `status='rejected'` rows, keyed by the reason column's own
   * enum values; a rejected `update`/`complete`/`cancel`-kind row (no reject-reason submenu, `decide.ts`)
   * has `reject_reason=null` and is counted under `'unspecified'`. */
  rejectReasons: Record<string, number>;
  /** Counts of which fields the Owner changed in the edit dialog (`payload.ownerEdits`, plan.md Task
   * 2.14) before accepting — only ever populated for `status='accepted'` rows, since `ownerEdits` is
   * written as a follow-up to a successful `acceptProposal` call. */
  editedFields: Record<string, number>;
  confidenceBuckets: ConfidenceBucket[];
  /** Only present when `withText: true` — see {@link FeedbackSample}. */
  samples?: FeedbackSample[];
}

/** Fixed-width confidence buckets covering `proposals.confidence`'s full `[0, 1]` range (plan.md Task
 * 3.13's brief leaves the exact bucketing to this implementation). The last bucket's `to` is inclusive —
 * every other bucket's is exclusive — so a `confidence` of exactly `1` (the LLM's own max) still lands
 * somewhere instead of falling through every bucket. */
const CONFIDENCE_BUCKET_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;

/** Maximum number of {@link FeedbackSample} rows returned when `withText: true` — caps how much real user
 * content (CLAUDE.md §9: never to be committed/shared) a single report can carry, while still giving the
 * local reader enough decided rows to spot a pattern. Oldest-`since` order below means this is the
 * earliest `SAMPLE_LIMIT` decided rows in the window, not a random sample — good enough for local error
 * analysis, where the point is "show me examples," not statistical coverage (the frequency tables above
 * already cover that). */
const SAMPLE_LIMIT = 200;

function bucketFor(confidence: number): ConfidenceBucket | undefined {
  for (let i = 0; i < CONFIDENCE_BUCKET_EDGES.length - 1; i += 1) {
    const from = CONFIDENCE_BUCKET_EDGES[i];
    const to = CONFIDENCE_BUCKET_EDGES[i + 1];
    if (from === undefined || to === undefined) continue;
    const isLastBucket = i === CONFIDENCE_BUCKET_EDGES.length - 2;
    if (confidence >= from && (confidence < to || (isLastBucket && confidence <= to))) {
      return { from, to, accepted: 0, rejected: 0 };
    }
  }
  return undefined;
}

function sampleTitle(payload: ReturnType<typeof parseProposalPayload>): string {
  if (!payload) return '';
  return payload.title ?? payload.changes?.title ?? '';
}

/**
 * `pnpm feedback-report`'s data source (SPEC §20.4, plan.md Task 3.13): aggregates every `proposals` row
 * created on or after `since` into the frequency tables a human reviewer uses to spot where the model is
 * systematically wrong — which categories get rejected most, why (`reject_reason`), which fields the
 * Owner keeps having to fix by hand before accepting (`payload.ownerEdits`), and whether the model's own
 * `confidence` actually tracks the Owner's accept/reject decision.
 *
 * `withText` gates the one field (`samples`) that can carry real task titles/quotes — everything else in
 * the return value is already category labels and integer counts, never free text, so it is safe to print,
 * log, or paste into a chat even without the flag. `withText: false` must still return a value whose
 * `JSON.stringify` contains no task titles/quotes (`scripts/feedback-report.ts`'s `--with-text` flag is the
 * only caller allowed to ask for `true`, and only after printing its local-analysis-only warning).
 */
export async function feedbackStats(
  db: DbOrTx,
  args: { since: Date; withText: boolean },
): Promise<FeedbackStats> {
  const rows = await db.select().from(proposals).where(gte(proposals.createdAt, args.since));

  const byCategory: FeedbackByCategory = {};
  const rejectReasons: Record<string, number> = {};
  const editedFields: Record<string, number> = {};
  const buckets = new Map<string, ConfidenceBucket>();
  const samples: FeedbackSample[] = [];

  for (const row of rows) {
    const category = row.category ?? 'unknown';
    const entry = (byCategory[category] ??= { shown: 0, accepted: 0, rejected: 0 });
    if (row.policyDecision === 'shown') entry.shown += 1;
    if (row.status === 'accepted') entry.accepted += 1;
    if (row.status === 'rejected') entry.rejected += 1;

    if (row.status === 'rejected') {
      const reason = row.rejectReason ?? 'unspecified';
      rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1;
    }

    const payload = parseProposalPayload(row.payload);

    if (row.status === 'accepted' && payload?.ownerEdits) {
      for (const field of Object.keys(payload.ownerEdits)) {
        editedFields[field] = (editedFields[field] ?? 0) + 1;
      }
    }

    if (row.status === 'accepted' || row.status === 'rejected') {
      const bucket = bucketFor(row.confidence);
      if (bucket) {
        const key = `${String(bucket.from)}-${String(bucket.to)}`;
        const existing = buckets.get(key) ?? bucket;
        if (row.status === 'accepted') existing.accepted += 1;
        else existing.rejected += 1;
        buckets.set(key, existing);
      }

      if (args.withText && samples.length < SAMPLE_LIMIT) {
        samples.push({ title: sampleTitle(payload), quote: payload?.quote ?? null, decision: row.status });
      }
    }
  }

  const confidenceBuckets = CONFIDENCE_BUCKET_EDGES.slice(0, -1).map((from, i) => {
    const to = CONFIDENCE_BUCKET_EDGES[i + 1] as number;
    const key = `${String(from)}-${String(to)}`;
    return buckets.get(key) ?? { from, to, accepted: 0, rejected: 0 };
  });

  const result: FeedbackStats = { byCategory, rejectReasons, editedFields, confidenceBuckets };
  if (args.withText) result.samples = samples;
  return result;
}
