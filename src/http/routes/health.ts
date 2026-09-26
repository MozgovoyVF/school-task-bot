import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import { HEARTBEAT_MAX_AGE_MS } from '../../config/constants.js';

export interface HealthDeps {
  db: Db;
  clock: Clock;
  heartbeat: () => Date | null;
}

/**
 * `GET /healthz`: 200 `{ status: 'ok' }` when the ticker's heartbeat is at
 * most `HEARTBEAT_MAX_AGE_MS` old and the database answers a trivial query;
 * 503 otherwise (stale/missing heartbeat, or an unreachable database).
 */
export function registerHealthRoute(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/healthz', async (_request, reply) => {
    const heartbeat = deps.heartbeat();
    const age = heartbeat ? deps.clock.now().getTime() - heartbeat.getTime() : Number.POSITIVE_INFINITY;
    if (age > HEARTBEAT_MAX_AGE_MS) {
      return reply.code(503).send({ status: 'error' });
    }

    try {
      await deps.db.execute(sql`select 1`);
    } catch {
      return reply.code(503).send({ status: 'error' });
    }

    return reply.code(200).send({ status: 'ok' });
  });
}
