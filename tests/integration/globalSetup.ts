import postgres from 'postgres';
import { createDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const DEFAULT_TEST_DATABASE_URL = 'postgres://stb:stb@localhost:5433/stb_test';

function testDatabaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

export default async function setup(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const dbName = testDatabaseName(testUrl);
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';

  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const { db, close } = createDb(testUrl, { max: 1 });
  try {
    await runMigrations(db);
  } finally {
    await close();
  }
}
