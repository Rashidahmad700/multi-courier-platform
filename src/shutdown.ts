import { logger } from './utils/logger';

/**
 * Shared graceful-shutdown wiring for both entry points. Lives in its own
 * module so `worker.ts` can reuse it without importing `index.ts` (which would
 * boot an HTTP server as a side effect).
 */
export function installShutdownHandlers(shutdown: () => Promise<void>): void {
  let shuttingDown = false;

  const handle = (signal: string) => async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await shutdown();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', handle('SIGTERM'));
  process.on('SIGINT', handle('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason, error_type: 'UNHANDLED_REJECTION' }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error, error_type: 'UNCAUGHT_EXCEPTION' }, 'uncaught exception');
    process.exit(1);
  });
}
