import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors/app-error';
import { ErrorCode } from '../../src/errors/error-codes';
import { computeBackoffDelay, defaultIsRetryable, withRetry } from '../../src/utils/retry';

const retryConfig = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: false };
const context = { operation: 'test.op' };

/** Records delays instead of waiting, so the suite stays fast and deterministic. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe('computeBackoffDelay', () => {
  it('grows exponentially from the configured base', () => {
    expect(computeBackoffDelay(1, retryConfig)).toBe(100);
    expect(computeBackoffDelay(2, retryConfig)).toBe(200);
    expect(computeBackoffDelay(3, retryConfig)).toBe(400);
  });

  it('never exceeds the configured maximum', () => {
    expect(computeBackoffDelay(10, retryConfig)).toBe(1000);
  });

  it('applies full jitter within [0, capped] when enabled', () => {
    const jittered = { ...retryConfig, jitter: true };
    expect(computeBackoffDelay(3, jittered, () => 0)).toBe(0);
    expect(computeBackoffDelay(3, jittered, () => 0.5)).toBe(200);
    expect(computeBackoffDelay(3, jittered, () => 0.999)).toBeLessThanOrEqual(400);
  });
});

describe('defaultIsRetryable', () => {
  it('treats courier 5xx / network failures as retryable', () => {
    expect(defaultIsRetryable(new AppError(ErrorCode.COURIER_UNAVAILABLE, 'down'))).toBe(true);
  });

  it('treats a rejected payload as non-retryable', () => {
    expect(defaultIsRetryable(new AppError(ErrorCode.COURIER_REJECTED, 'bad payload'))).toBe(false);
  });

  it('treats a courier auth failure as non-retryable (re-auth is handled separately)', () => {
    expect(defaultIsRetryable(new AppError(ErrorCode.COURIER_AUTH_FAILED, 'nope'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the first successful result without sleeping', async () => {
    const { sleep, delays } = recordingSleep();
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(withRetry(fn, { ...retryConfig, sleep }, context)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('recovers after a transient failure', async () => {
    const { sleep, delays } = recordingSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppError(ErrorCode.COURIER_UNAVAILABLE, 'timeout'))
      .mockResolvedValue('recovered');

    await expect(withRetry(fn, { ...retryConfig, sleep }, context)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([100]);
  });

  it('aborts immediately on a non-retryable failure', async () => {
    const { sleep, delays } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new AppError(ErrorCode.COURIER_REJECTED, 'bad payload'));

    await expect(withRetry(fn, { ...retryConfig, sleep }, context)).rejects.toMatchObject({
      code: ErrorCode.COURIER_REJECTED,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const { sleep, delays } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new AppError(ErrorCode.COURIER_UNAVAILABLE, 'still down'));

    await expect(withRetry(fn, { ...retryConfig, sleep }, context)).rejects.toMatchObject({
      code: ErrorCode.COURIER_UNAVAILABLE,
      message: 'still down',
    });
    expect(fn).toHaveBeenCalledTimes(3);
    // Slept between attempts only, never after the final one.
    expect(delays).toEqual([100, 200]);
  });

  it('honours a configured attempt count of 1 (retries disabled)', async () => {
    const { sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new AppError(ErrorCode.COURIER_UNAVAILABLE, 'down'));

    await expect(
      withRetry(fn, { ...retryConfig, maxAttempts: 1, sleep }, context),
    ).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
