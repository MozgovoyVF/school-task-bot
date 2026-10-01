import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { Tx } from '../../db/client.js';
import { notifications } from '../../db/schema/index.js';
import { getOwner } from '../../domain/people/repo.js';
import { getSettings } from '../../domain/workspaces/repo.js';
import { earliestTimeStrictlyAfter } from '../../domain/notifications/plan.js';
import { userZone } from '../../time/zones.js';
import type { Job } from '../ticker.js';

type NotificationRow = typeof notifications.$inferSelect;

/** `fireAt`'s own clock-of-day, read in `zone`, as `HH:mm` — matches `settings.summary.time`'s format
 * (`src/domain/settings/schema.ts`'s `TimeString`). */
function timeOfDay(fireAt: Date, zone: string): string {
  return DateTime.fromJSDate(fireAt, { zone }).toFormat('HH:mm');
}

/** Cancels every still-`scheduled` `summary`-kind row for `recipientUserId`, except `keepId` (if given) —
 * used both for D10's "`summary.enabled=false` → cancel what's pending" and for replacing a now-stale
 * scheduled row (e.g. after a `/settings` time change) with a fresh one. */
async function cancelScheduledSummaries(
  tx: Tx,
  workspaceId: number,
  recipientUserId: number,
  keepId?: number,
): Promise<NotificationRow[]> {
  const rows = await tx
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.recipientUserId, recipientUserId),
        eq(notifications.kind, 'summary'),
        eq(notifications.status, 'scheduled'),
      ),
    );
  const stale = rows.filter((row) => row.id !== keepId);
  for (const row of stale) {
    await tx.update(notifications).set({ status: 'cancelled' }).where(eq(notifications.id, row.id));
  }
  return rows;
}

/**
 * Self-healing scheduled-summary maintenance (plan.md Task 3.5): every tick, for the workspace's Owner —
 * D40, the only summary recipient — makes sure exactly one `scheduled` `summary`-kind `notifications` row
 * exists for the next occurrence of `settings.summary.time` in the Owner's own zone, strictly after `now`
 * (`earliestTimeStrictlyAfter`, shared with `src/domain/notifications/plan.ts`'s reminder planning).
 *
 * Nothing to do (no row touched at all) when there's no Owner yet, the Owner has never opened a DM
 * (`dm_started_at IS NULL`), or the Owner has blocked the bot (`dm_blocked`) — mirrors `cardsJob`'s own
 * gates, minus the superadmin alert (a missing summary recipient isn't itself an error condition the way a
 * stuck card outbox is).
 *
 * `settings.summary.enabled === false` cancels whatever `scheduled` row(s) exist and stops there. Otherwise,
 * an already-`scheduled` row whose own time-of-day (in the Owner's zone) still matches `settings.summary.
 * time` and is still strictly in the future is left alone; anything else `scheduled` is stale (e.g. the
 * Owner changed `/settings`'s summary time, or `notifyJob` just sent today's row this same tick — see
 * below) and is cancelled, then replaced by one fresh row for the next occurrence.
 *
 * Running after `notifyJob` in `src/app.ts`'s ticker (both inside one `tickOnce()`) is what makes the next
 * day's row appear in the very same tick a summary is sent: `notifyJob` marks today's row `sent` (so it's
 * no longer `scheduled`), and this job — running right after, same tick — then finds nothing `scheduled` and
 * inserts tomorrow's.
 */
export const ensureSummariesJob: Job = {
  name: 'ensure-summaries',
  async run(deps) {
    const now = deps.clock.now();

    await deps.db.transaction(async (tx) => {
      const owner = await getOwner(tx, deps.workspace.id);
      if (owner === null) return;
      if (owner.user.dmStartedAt === null || owner.user.dmBlocked) return;

      const settings = await getSettings(tx, deps.workspace.id);
      const zone = userZone(owner.user, deps.workspace);

      if (!settings.summary.enabled) {
        await cancelScheduledSummaries(tx, deps.workspace.id, owner.user.id);
        return;
      }

      const scheduled = await tx
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.workspaceId, deps.workspace.id),
            eq(notifications.recipientUserId, owner.user.id),
            eq(notifications.kind, 'summary'),
            eq(notifications.status, 'scheduled'),
          ),
        );

      const valid = scheduled.find(
        (row) =>
          row.fireAt.getTime() > now.getTime() && timeOfDay(row.fireAt, zone) === settings.summary.time,
      );

      if (valid) {
        await cancelScheduledSummaries(tx, deps.workspace.id, owner.user.id, valid.id);
        return;
      }

      await cancelScheduledSummaries(tx, deps.workspace.id, owner.user.id);

      const fireAt = earliestTimeStrictlyAfter(zone, settings.summary.time, now);
      const date = fireAt.toISODate();
      if (date === null) {
        deps.logger.error(
          { zone, time: settings.summary.time },
          'ensureSummariesJob: invalid fireAt computed',
        );
        return;
      }

      // A `/settings` time change (e.g. 09:00 → 18:00, same local calendar date) can retarget onto the
      // very `dedupe_key` the row just cancelled above still holds (`summary:{ws}:{user}:{date}` only ever
      // encodes the *date*, not the time-of-day) — `onConflictDoUpdate` revives that same row (same id)
      // back to `scheduled` with the new `fire_at`, instead of silently dropping the insert
      // (`onConflictDoNothing` would leave the Owner with *no* scheduled summary at all until the next
      // calendar date). `setWhere` restricts the revival to a row this job itself just cancelled
      // (`status='cancelled'`) — a `sent` row for today must never be flipped back to `scheduled` and resent
      // just because the Owner changed the time later the same day (SPEC's dedupe key exists precisely to
      // guard against a double send). When the new occurrence lands on a different date, there is no row to
      // collide with at all, so this inserts a genuinely new one, same as a plain insert would.
      await tx
        .insert(notifications)
        .values({
          workspaceId: deps.workspace.id,
          taskId: null,
          recipientUserId: owner.user.id,
          kind: 'summary',
          fireAt: fireAt.toJSDate(),
          dedupeKey: `summary:${String(deps.workspace.id)}:${String(owner.user.id)}:${date}`,
        })
        .onConflictDoUpdate({
          target: notifications.dedupeKey,
          set: {
            status: 'scheduled',
            fireAt: fireAt.toJSDate(),
            attempts: 0,
            lastError: null,
            sentTgMessageId: null,
          },
          setWhere: eq(notifications.status, 'cancelled'),
        });
    });
  },
};
