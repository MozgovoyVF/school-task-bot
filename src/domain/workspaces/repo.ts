import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { workspaces } from '../../db/schema/index.js';
import { parseSettings, mergeSettings, type Settings, type DeepPartial } from '../settings/schema.js';

export type WorkspaceRow = typeof workspaces.$inferSelect;

/**
 * Returns the single bootstrap workspace, creating it on first run. Not safe
 * against concurrent callers racing the initial insert (no unique
 * constraint backs this "single default row" invariant yet); acceptable
 * here since this is only called from the composition root at startup.
 * `name`/`timezone` are only used on that first insert — a later call with
 * different values does not rename the existing workspace.
 */
export async function ensureDefaultWorkspace(
  db: DbOrTx,
  input: { name: string; timezone: string },
): Promise<WorkspaceRow> {
  const [existing] = await db.select().from(workspaces).limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(workspaces)
    .values({ name: input.name, timezone: input.timezone })
    .returning();
  if (!created) throw new Error('failed to create default workspace');
  return created;
}

/** Returns a workspace by id, or `null` if it does not exist. */
export async function getWorkspace(db: DbOrTx, id: number): Promise<WorkspaceRow | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return row ?? null;
}

/** Lists all workspaces (id order). */
export async function listWorkspaces(db: DbOrTx): Promise<WorkspaceRow[]> {
  return db.select().from(workspaces).orderBy(workspaces.id);
}

/** Reads and validates `workspaces.settings` (jsonb) via {@link parseSettings}. */
export async function getSettings(db: DbOrTx, workspaceId: number): Promise<Settings> {
  const workspace = await getWorkspace(db, workspaceId);
  if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
  return parseSettings(workspace.settings);
}

/**
 * Updates the workspace's own `timezone` column (SPEC §16: the school's own zone, distinct from a user's
 * personal override in `users.timezone` — Task 3.11's `/settings` "school timezone" section). Unlike
 * `updateSettings` below, there is no zod re-validation step here: `timezone` is a plain `text` column,
 * and the caller (`src/bot/conversations/settings.ts`) only ever passes a value already resolved by
 * `time/zones.ts`'s `parseZoneInput` or picked from its own `RU_ZONES` list.
 */
export async function setWorkspaceTimezone(
  db: DbOrTx,
  workspaceId: number,
  timezone: string,
): Promise<WorkspaceRow> {
  const [updated] = await db
    .update(workspaces)
    .set({ timezone })
    .where(eq(workspaces.id, workspaceId))
    .returning();
  if (!updated) throw new Error(`workspace not found: ${workspaceId}`);
  return updated;
}

/**
 * Deep-merges `patch` onto the current settings, persists the result, and
 * returns it. Throws (without writing) if the merged settings are invalid.
 *
 * Callers that need to catch that `ZodError` from *inside* a
 * `@grammyjs/conversations` dialog should not wrap this function itself in
 * `conversation.external(...)`: that plugin's replay machinery does not
 * guarantee a thrown error survives with its original prototype intact
 * (confirmed empirically by `tests/integration/bot/settings.test.ts` — an
 * `instanceof ZodError` check on the error `conversation.external` rethrows
 * came back `false`). Such a caller should instead call {@link getSettings}
 * and `mergeSettings` directly (both pure/synchronous, same as
 * `src/bot/conversations/editPerson.ts`'s own unwrapped `parseAliases` call)
 * to decide whether the patch is valid, and only wrap the actual write —
 * {@link setSettings} below — in `conversation.external`.
 */
export async function updateSettings(
  db: DbOrTx,
  workspaceId: number,
  patch: DeepPartial<Settings>,
): Promise<Settings> {
  const current = await getSettings(db, workspaceId);
  const next = mergeSettings(current, patch);
  await setSettings(db, workspaceId, next);
  return next;
}

/** Persists already-validated settings (see {@link updateSettings}'s own doc comment for why a
 * conversation that must catch a validation error keeps this write separate from the validation step). */
export async function setSettings(db: DbOrTx, workspaceId: number, settings: Settings): Promise<void> {
  await db.update(workspaces).set({ settings }).where(eq(workspaces.id, workspaceId));
}
