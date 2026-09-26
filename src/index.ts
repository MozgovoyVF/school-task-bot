import { loadEnv } from './config/env.js';
import { startApp } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await startApp(env);

  let shuttingDown = false;
  function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) return;
    shuttingDown = true;
    app.deps.logger.info({ signal }, 'shutting down');
    void app
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.deps.logger.error({ err }, 'failed to shut down cleanly');
        process.exit(1);
      });
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // The logger may not exist yet (e.g. `loadEnv()` rejected due to invalid env vars),
  // so this is the one legitimate last-resort use of the console in the whole app.
  console.error('failed to start', err);
  process.exit(1);
});
