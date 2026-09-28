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
 * Deep-merges `patch` onto the current settings, persists the result, and
 * returns it. Throws (without writing) if the merged settings are invalid.
 */
export async function updateSettings(
  db: DbOrTx,
  workspaceId: number,
  patch: DeepPartial<Settings>,
): Promise<Settings> {
  const current = await getSettings(db, workspaceId);
  const next = mergeSettings(current, patch);

  await db.update(workspaces).set({ settings: next }).where(eq(workspaces.id, workspaceId));

  return next;
}
