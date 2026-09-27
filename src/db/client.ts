import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export { schema };

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

/** Creates a Drizzle db handle over a fresh postgres.js connection pool. Callers must `close()` it when done. */
export function createDb(url: string, opts?: { max?: number }): { db: Db; close: () => Promise<void> } {
  const client = postgres(url, { max: opts?.max });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}
