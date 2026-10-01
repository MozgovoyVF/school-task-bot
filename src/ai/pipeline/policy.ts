import type { Settings } from '../../domain/settings/schema.js';
import type { ResolvedDue } from '../../time/resolveDue.js';
import type { ResolvedAction } from './resolve.js';

export type PolicyDecision = 'shown' | 'suppressed';
export type PolicyMode = 'auto' | 'manual';

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

type Thresholds = Settings['ai']['thresholds'];

/**
 * SPEC §9.6: `commitment`/`request_to_owner` clear the bar either via a
 * resolved due date at the (lower) `low` threshold, or on confidence alone
 * at the (higher) `high` threshold — an invalid `due` (unparseable text) is
 * not treated as "has a due date" here, since a due the pipeline could not
 * actually resolve gives the Owner nothing to act on.
 */
function hasDue(due: ResolvedDue): boolean {
  return due.dueAt !== null && !due.invalid;
}

/** create: `assignment`, `event`, `owner_intent` — SPEC §9.6 row 1. */
function policyForLowOnlyCreate(confidence: number, thresholds: Thresholds): PolicyResult {
  return confidence >= thresholds.low
    ? { decision: 'shown', reason: 'above_low' }
    : { decision: 'suppressed', reason: 'below_low' };
}

/** create: `commitment`, `request_to_owner` — SPEC §9.6 row 2. */
function policyForDueSensitiveCreate(
  action: Extract<ResolvedAction, { kind: 'create' }>,
  thresholds: Thresholds,
): PolicyResult {
  const { confidence } = action;
  if (confidence >= thresholds.high) return { decision: 'shown', reason: 'above_high' };
  if (hasDue(action.due) && confidence >= thresholds.low) {
    return { decision: 'shown', reason: 'has_due_above_low' };
  }
  return {
    decision: 'suppressed',
    reason: hasDue(action.due) ? 'commitment_without_enough_confidence' : 'commitment_without_due_below_high',
  };
}

function policyForCreate(
  action: Extract<ResolvedAction, { kind: 'create' }>,
  thresholds: Thresholds,
): PolicyResult {
  switch (action.category) {
    case 'assignment':
    case 'event':
    case 'owner_intent':
      return policyForLowOnlyCreate(action.confidence, thresholds);
    case 'commitment':
    case 'request_to_owner':
      return policyForDueSensitiveCreate(action, thresholds);
  }
}

/** update / complete / cancel — SPEC §9.6 row 3. */
function policyForModify(confidence: number, thresholds: Thresholds): PolicyResult {
  return confidence >= thresholds.modify
    ? { decision: 'shown', reason: 'modify_above_threshold' }
    : { decision: 'suppressed', reason: 'modify_below_threshold' };
}

/**
 * SPEC §9.6: decides whether a resolved action is shown to the Owner as a
 * proposal or suppressed (kept, with `policy_decision='suppressed'` and this
 * `reason`, visible to superadmin in `/debug`). A `manual` request (Owner
 * explicitly asked, e.g. via `/debug` or a re-run) is never suppressed —
 * CLAUDE.md: a missed task is worse than a false positive, so thresholds
 * only gate the unattended `auto` pipeline.
 */
export function applyPolicy(action: ResolvedAction, thresholds: Thresholds, mode: PolicyMode): PolicyResult {
  if (mode === 'manual') return { decision: 'shown', reason: 'manual_override' };

  if (action.kind === 'create') return policyForCreate(action, thresholds);
  return policyForModify(action.confidence, thresholds);
}
