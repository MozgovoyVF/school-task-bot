import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { workspaces, users, memberships } from '../../../src/db/schema/index.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

describe('schema', () => {
  it('has pg_trgm working on Cyrillic', async () => {
    const [row] = await db.execute<{ same: number; diff: number }>(
      sql`select similarity('подготовить расписание', 'подготовить расписание') as same, similarity('расписание', 'аренда') as diff`,
    );
    expect(Number(row!.same)).toBe(1);
    expect(Number(row!.diff)).toBeLessThan(0.3);
  });

  it('allows at most one owner per workspace', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Школа' }).returning();
    const [u1, u2] = await db
      .insert(users)
      .values([
        { tgUserId: 1, firstName: 'A' },
        { tgUserId: 2, firstName: 'B' },
      ])
      .returning();
    await db
      .insert(memberships)
      .values({ workspaceId: ws!.id, userId: u1!.id, role: 'owner', displayName: 'A' });
    // drizzle-orm wraps the driver error in a generic "Failed query: …" DrizzleQueryError; the actual
    // Postgres message (and the constraint name) is on `.cause`, so we assert on that instead of `.message`.
    let error: unknown;
    try {
      await db
        .insert(memberships)
        .values({ workspaceId: ws!.id, userId: u2!.id, role: 'owner', displayName: 'B' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const cause = error instanceof Error ? error.cause : undefined;
    expect(cause).toBeInstanceOf(Error);
    expect(cause instanceof Error ? cause.message : '').toMatch(/memberships_one_owner|duplicate key/);
  });

  it('creates trigram indexes', async () => {
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexdef like '%gin_trgm_ops%'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});
