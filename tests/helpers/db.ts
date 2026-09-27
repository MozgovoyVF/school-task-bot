import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../../src/db/client.js';

const DEFAULT_TEST_DATABASE_URL = 'postgres://stb:stb@localhost:5433/stb_test';

let cached: Db | undefined;

/** Returns a process-wide Drizzle handle to the test database (`TEST_DATABASE_URL`, one connection). */
export function getTestDb(): Db {
  if (!cached) {
    const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
    cached = createDb(url, { max: 1 }).db;
  }
  return cached;
}

/** Empties every table in the `public` schema (except the migrations log) and resets identities. */
export async function truncateAll(db: Db): Promise<void> {
  const rows = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  if (rows.length === 0) return;
  const tables = rows.map((row) => `"${row.tablename}"`).join(', ');
  await db.execute(sql.raw(`truncate table ${tables} restart identity cascade`));
}
