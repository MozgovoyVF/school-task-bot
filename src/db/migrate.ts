import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadEnv } from '../config/env.js';
import { createDb, type Db } from './client.js';
import { isEntrypoint } from '../ops/entrypoint.js';

const DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_FOLDER = join(DIRNAME, 'migrations');

/** Applies every pending SQL migration from `migrationsFolder` (default: `src/db/migrations`). */
export function runMigrations(db: Db, migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER): Promise<void> {
  return migrate(db, { migrationsFolder });
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);
  try {
    await runMigrations(db);
  } finally {
    await close();
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  await main();
}
