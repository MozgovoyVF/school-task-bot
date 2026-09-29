import { and, eq, lt } from 'drizzle-orm';
import { proposals } from '../../db/schema/index.js';
import { getSettings } from '../../domain/workspaces/repo.js';
import { dailyJob } from '../daily.js';
import type { Job } from '../ticker.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * D11 (plan.md, decided at Task 2.15): once a day, moves every still-`pending` proposal older than
 * `ai.proposalExpiryDays` (default 7) to `expired`. Before that they stay fully visible — in `/inbox` and
 * in the quiet-hours summary — SPEC §11.2's "proposals don't auto-expire" is read as "don't disappear
 * before their time," not "never expire" (see plan.md's D11 row for the full reasoning). `WHERE
 * status='pending'` makes this idempotent the same way every other decision write in this codebase is
 * (CLAUDE.md's `UPDATE … WHERE status='pending' RETURNING` convention) — a second run the same day is a
 * no-op past whatever the first run already flipped, and `dailyJob` itself already guards against running
 * more than once per UTC calendar day.
 */
export const expireProposalsJob: Job = dailyJob('expire-proposals', '03:40', async (deps) => {
  const now = deps.clock.now();
  const settings = await getSettings(deps.db, deps.workspace.id);
  const cutoff = new Date(now.getTime() - settings.ai.proposalExpiryDays * DAY_MS);

  const expired = await deps.db
    .update(proposals)
    .set({ status: 'expired' })
    .where(
      and(
        eq(proposals.workspaceId, deps.workspace.id),
        eq(proposals.status, 'pending'),
        lt(proposals.createdAt, cutoff),
      ),
    )
    .returning({ id: proposals.id });

  if (expired.length > 0) {
    deps.logger.info({ count: expired.length }, 'expireProposalsJob: expired proposals');
  }
});
