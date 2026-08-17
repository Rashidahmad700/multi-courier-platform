import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '../../src/errors/app-error';
import { ErrorCode } from '../../src/errors/error-codes';
import { CourierHttpClient } from '../../src/utils/http-client';

/**
 * Exercises the shared courier transport against a real (ephemeral, local) HTTP
 * server. Using a real socket rather than a mocked axios keeps the timeout,
 * status-classification and re-authentication behaviour honest.
 */

type Handler = (req: { url: string; auth: string | undefined }) => {
  status: number;
  body: unknown;
  delayMs?: number;
};

let server: Server | undefined;

async function startServer(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    const result = handler({ url: req.url ?? '', auth: req.headers.authorization });
    const send = (): void => {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    };
    if (result.delayMs) setTimeout(send, result.delayMs);
    else send();
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

const retry = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: false };
const context = { requestId: 'req_test', operation: 'testOp' };

describe('CourierHttpClient', () => {
  it('returns the body and a full audit record on success', async () => {
    const baseUrl = await startServer(() => ({ status: 200, body: { status: 'Success' } }));
    const client = new CourierHttpClient({
      courierName: 'test',
      baseUrl,
      timeoutMs: 2000,
      retry,
    });

    const result = await client.request<{ status: string }>(
      { method: 'POST', url: '/create', data: { orderNumber: 'A1' } },
      context,
    );

    expect(result.data).toEqual({ status: 'Success' });
    expect(result.audit).toMatchObject({
      method: 'POST',
      httpStatus: 200,
      requestPayload: { orderNumber: 'A1' },
      responsePayload: { status: 'Success' },
    });
    expect(result.audit.endpoint).toContain('/create');
    expect(result.audit.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('retries a 5xx and succeeds once the courier recovers', async () => {
    let calls = 0;
    const baseUrl = await startServer(() => {
      calls += 1;
      return calls < 3
        ? { status: 503, body: { detail: 'unavailable' } }
        : { status: 200, body: { status: 'Success' } };
    });

    const client = new CourierHttpClient({ courierName: 'test', baseUrl, timeoutMs: 2000, retry });
    await expect(
      client.request({ method: 'GET', url: '/track' }, context),
    ).resolves.toMatchObject({ data: { status: 'Success' } });
    expect(calls).toBe(3);
  });

  it('gives up after the configured attempts and reports COURIER_UNAVAILABLE', async () => {
    let calls = 0;
    const baseUrl = await startServer(() => {
      calls += 1;
      return { status: 500, body: { detail: 'boom' } };
    });

    const client = new CourierHttpClient({ courierName: 'test', baseUrl, timeoutMs: 2000, retry });
    await expect(client.request({ method: 'GET', url: '/track' }, context)).rejects.toMatchObject({
      code: ErrorCode.COURIER_UNAVAILABLE,
    });
    expect(calls).toBe(3);
  });

  it('does not retry a 4xx, and keeps the courier body out of the client message', async () => {
    let calls = 0;
    const baseUrl = await startServer(() => {
      calls += 1;
      return { status: 400, body: { detail: 'customerCode NOT_ALLOWED xyz' } };
    });

    const client = new CourierHttpClient({ courierName: 'test', baseUrl, timeoutMs: 2000, retry });
    let error: AppError | undefined;
    try {
      await client.request({ method: 'POST', url: '/create', data: {} }, context);
      expect.unreachable('the 4xx should have thrown');
    } catch (caught) {
      error = caught as AppError;
    }

    expect(error!.code).toBe(ErrorCode.COURIER_REJECTED);
    expect(error!.message).not.toContain('NOT_ALLOWED');
    expect(JSON.stringify(error!.raw)).toContain('NOT_ALLOWED');
    expect(calls).toBe(1);
  });

  it('re-authenticates on 401 and retries exactly once', async () => {
    let calls = 0;
    const baseUrl = await startServer(({ auth }) => {
      calls += 1;
      return auth === 'Bearer fresh-token'
        ? { status: 200, body: { status: 'Success' } }
        : { status: 401, body: { detail: 'Authentication credentials were not provided.' } };
    });

    let tokenFetches = 0;
    const client = new CourierHttpClient({
      courierName: 'test',
      baseUrl,
      timeoutMs: 2000,
      retry,
      getAuthHeader: async (forceRefresh) => {
        tokenFetches += 1;
        return { Authorization: `Bearer ${forceRefresh ? 'fresh-token' : 'stale-token'}` };
      },
    });

    await expect(
      client.request({ method: 'GET', url: '/track' }, context),
    ).resolves.toMatchObject({ data: { status: 'Success' } });

    expect(calls).toBe(2); // original + exactly one retry
    expect(tokenFetches).toBe(2); // cached attempt + forced refresh
  });

  it('stops after one re-auth attempt when the credentials are genuinely wrong', async () => {
    let calls = 0;
    const baseUrl = await startServer(() => {
      calls += 1;
      return { status: 401, body: { detail: 'Authentication credentials were not provided.' } };
    });

    const client = new CourierHttpClient({
      courierName: 'test',
      baseUrl,
      timeoutMs: 2000,
      retry,
      getAuthHeader: async () => ({ Authorization: 'Bearer bad' }),
    });

    await expect(client.request({ method: 'GET', url: '/track' }, context)).rejects.toMatchObject({
      code: ErrorCode.COURIER_AUTH_FAILED,
    });
    // Two calls total, and no exponential-backoff retries: bad credentials fail fast.
    expect(calls).toBe(2);
  });

  it('treats a timeout as retryable and reports COURIER_UNAVAILABLE', async () => {
    const baseUrl = await startServer(() => ({ status: 200, body: {}, delayMs: 300 }));
    const client = new CourierHttpClient({
      courierName: 'test',
      baseUrl,
      timeoutMs: 50,
      retry: { ...retry, maxAttempts: 2 },
    });

    await expect(client.request({ method: 'GET', url: '/slow' }, context)).rejects.toMatchObject({
      code: ErrorCode.COURIER_UNAVAILABLE,
    });
  });
});
