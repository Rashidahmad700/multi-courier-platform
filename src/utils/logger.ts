import pino from 'pino';
import { config } from '../config';

/**
 * Structured JSON logging. Credentials and courier tokens are redacted at the
 * logger level so an adapter cannot leak them by logging a request object.
 */
export const logger = pino({
  level: config.isTest ? 'silent' : config.logLevel,
  base: { service: 'multi-courier-platform' },
  redact: {
    paths: [
      'password',
      '*.password',
      '*.*.password',
      'access_token',
      '*.access_token',
      'headers.authorization',
      '*.headers.authorization',
      'req.headers.authorization',
      'config.headers.Authorization',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = pino.Logger;

/** Fields every failure log line must carry (requirement 3.5). */
export interface FailureLogContext {
  order_id?: string;
  courier_partner?: string;
  request_id?: string;
  error_type: string;
  [key: string]: unknown;
}

export function logFailure(context: FailureLogContext, error: unknown, message: string): void {
  logger.error(
    {
      ...context,
      err: error instanceof Error ? { message: error.message, stack: error.stack } : { raw: error },
    },
    message,
  );
}
