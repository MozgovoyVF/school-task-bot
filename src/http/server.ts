import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthRoute, type HealthDeps } from './routes/health.js';

/** Builds the Fastify instance (does not `listen()`; the composition root owns that). */
export function buildHttpServer(deps: HealthDeps): FastifyInstance {
  const app = Fastify();
  registerHealthRoute(app, deps);
  return app;
}
