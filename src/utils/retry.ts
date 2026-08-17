import type { RetryConfig } from '../config';
import { AppError } from '../errors/app-error';
import { logger } from './logger';

export interface RetryContext {
  /** Free-form label used in logs, e.g. `urbanebolt.createShipment`. */
  operation: string;
  order_id?: string;
  courier_partner?: string;
  request_id?: string;
}

export interface RetryOptions extends RetryConfig {
  /** Decides whether a given failure is worth another attempt. */
  isRetryable?: (error: unknown) => boolean;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for deterministic tests; must return [0, 1). */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** An AppError knows whether it is retryable; anything else is assumed transient. */
export function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof AppError) return error.retryable;
  return true;
}

/**
 * Exponential backoff delay for a given 1-based attempt number.
 * Exported so the retry policy is unit-testable without burning real time.
 */
export function computeBackoffDelay(
  attempt: number,
  { baseDelayMs, maxDelayMs, jitter }: RetryConfig,
  random: () => number = Math.random,
): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, maxDelayMs);
  if (!jitter) return capped;
  // Full jitter: uniformly random in [0, capped]. Prevents a fleet of workers
  // from re-hitting a recovering courier in lockstep.
  return Math.floor(random() * capped);
}

/**
 * Runs `fn` with exponential backoff. Non-retryable failures abort immediately;
 * once attempts are exhausted the last error is rethrown untouched so callers
 * still see the real cause.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
  context: RetryContext,
): Promise<T> {
  const {
    maxAttempts,
    isRetryable = defaultIsRetryable,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (!isRetryable(error)) {
        logger.debug(
          { ...context, attempt, error_type: errorType(error) },
          'operation failed with a non-retryable error; not retrying',
        );
        throw error;
      }

      if (attempt === maxAttempts) {
        logger.warn(
          { ...context, attempts: attempt, error_type: errorType(error) },
          'operation failed after exhausting all retry attempts',
        );
        throw error;
      }

      const delay = computeBackoffDelay(attempt, options, random);
      logger.warn(
        { ...context, attempt, next_retry_in_ms: delay, error_type: errorType(error) },
        'operation failed with a retryable error; backing off',
      );
      await sleep(delay);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw AppError.from(lastError);
}

function errorType(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error) return error.name;
  return 'UnknownError';
}
