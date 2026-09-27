import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { DbOrTx } from '../../db/client.js';
import { appState } from '../../db/schema/index.js';

/**
 * Reads a key from the `app_state` table (heartbeat, daily-job marks, the LLM
 * error streak counter, notification marks — plan.md decision D5) and
 * validates it through `schema`. Returns `null` when the key has no row.
 */
export async function getState<T>(db: DbOrTx, key: string, schema: z.ZodType<T>): Promise<T | null> {
  const rows = await db
    .select({ value: appState.value })
    .from(appState)
    .where(eq(appState.key, key))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return schema.parse(row.value);
}

/**
 * Upserts a key in `app_state`. `now` is a caller-supplied parameter (never
 * read from the clock here): this is a `domain/` file, which must not call
 * `Clock`/`new Date()` directly (CLAUDE.md §8).
 */
export async function setState(db: DbOrTx, key: string, value: unknown, now: Date): Promise<void> {
  await db
    .insert(appState)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt: now } });
}
