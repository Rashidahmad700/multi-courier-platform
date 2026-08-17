import { buildContainer } from './container';
import { connectDatabase, disconnectDatabase } from './db';
import { installShutdownHandlers } from './shutdown';
import { logger } from './utils/logger';

/**
 * Standalone worker process. Run one or more of these alongside the API in
 * production so a slow courier can never block HTTP request handling.
 */
async function main(): Promise<void> {
  await connectDatabase();

  const container = buildContainer();
  container.worker.start();
  logger.info('bulk worker process started');

  installShutdownHandlers(async () => {
    await container.worker.stop();
    await disconnectDatabase();
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start worker');
  process.exit(1);
});
