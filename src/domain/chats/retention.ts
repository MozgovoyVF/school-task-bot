import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';

export interface RetentionResult {
  deletedMessages: number;
  clearedTexts: number;
  clearedRaw: number;
}

const DEFAULT_MESSAGE_DAYS = 30;
const DEFAULT_BATCH_RAW_DAYS = 30;

/**
 * Daily storage-retention cleanup (SPEC.md line ~647, plan.md Task 1.12):
 *
 * - `messages` rows older than the owning chat's workspace's
 *   `settings.retention.messageDays` (default 30) are deleted outright,
 *   *unless* a still-`pending` proposal references them via
 *   `proposals.source_message_ids` — those are kept but have `text` blanked
 *   instead (the referencing task/proposal already carries its own
 *   `source_quote`, SPEC §7.2's `≤200` chars quote, so nothing is lost for
 *   an open decision).
 * - `analysis_batches.raw_response` is blanked once the batch is older than
 *   `settings.retention.batchRawDays` (default 30) — independent of the
 *   message rule above.
 *
 * All three statements are plain SQL (not the query builder): each needs an
 * `UPDATE`/`DELETE ... FROM` join out to `chats`/`workspaces` to read the
 * owning workspace's retention settings (jsonb, with a default applied when
 * there is no workspace to read from — `analysis_batches.chat_id` is
 * nullable for manual/reanalyze batches, D5), which the query builder has
 * no direct way to express. `now` is threaded through as a parameter (the
 * caller's `Clock.now()`) rather than read here — this is a `domain/` file,
 * and CLAUDE.md §8 bans `new Date()`/SQL `now()` in business logic.
 */
export async function runRetention(db: DbOrTx, opts: { now: Date }): Promise<RetentionResult> {
  // Interpolated as an ISO string, not the raw `Date`: postgres.js's simple-query parameter
  // serializer errors on a `Date` value bound against an explicit `::timestamptz` cast
  // (`reset.str` expects a string/Buffer/ArrayBuffer) — an ISO string parses to the same instant.
  const now = opts.now.toISOString();

  const deletedMessages = await db.execute<{ id: number }>(sql`
    delete from messages m
    using chats c
    left join workspaces w on w.id = c.workspace_id
    where m.chat_id = c.id
      and m.sent_at <= ${now}::timestamptz
        - (coalesce((w.settings -> 'retention' ->> 'messageDays')::int, ${DEFAULT_MESSAGE_DAYS}) * interval '1 day')
      and not exists (
        select 1 from proposals p where p.status = 'pending' and m.id = any(p.source_message_ids)
      )
    returning m.id
  `);

  const clearedTexts = await db.execute<{ id: number }>(sql`
    update messages m
    set text = null
    from chats c
    left join workspaces w on w.id = c.workspace_id
    where m.chat_id = c.id
      and m.text is not null
      and m.sent_at <= ${now}::timestamptz
        - (coalesce((w.settings -> 'retention' ->> 'messageDays')::int, ${DEFAULT_MESSAGE_DAYS}) * interval '1 day')
      and exists (
        select 1 from proposals p where p.status = 'pending' and m.id = any(p.source_message_ids)
      )
    returning m.id
  `);

  const clearedRaw = await db.execute<{ id: number }>(sql`
    update analysis_batches b
    set raw_response = null
    from (
      select b2.id,
             coalesce((w.settings -> 'retention' ->> 'batchRawDays')::int, ${DEFAULT_BATCH_RAW_DAYS}) as days
      from analysis_batches b2
      left join chats c on c.id = b2.chat_id
      left join workspaces w on w.id = c.workspace_id
    ) sub
    where b.id = sub.id
      and b.raw_response is not null
      and b.created_at <= ${now}::timestamptz - (sub.days * interval '1 day')
    returning b.id
  `);

  return {
    deletedMessages: deletedMessages.length,
    clearedTexts: clearedTexts.length,
    clearedRaw: clearedRaw.length,
  };
}
