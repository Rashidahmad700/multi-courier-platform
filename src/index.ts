import type { Server } from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { buildContainer } from './container';
import { connectDatabase, disconnectDatabase } from './db';
import { installShutdownHandlers } from './shutdown';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  await connectDatabase();

  const container = buildContainer();
  const app = createApp(container);

  if (config.bulk.runWorkerInApiProcess) {
    container.worker.start();
    logger.warn(
      'bulk worker is running inside the API process (RUN_WORKER_IN_API_PROCESS=true); ' +
        'run it as a separate process in production',
    );
  }

  const server: Server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'API listening');
  });

  installShutdownHandlers(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (config.bulk.runWorkerInApiProcess) await container.worker.stop();
    await disconnectDatabase();
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start API');
  process.exit(1);
});
