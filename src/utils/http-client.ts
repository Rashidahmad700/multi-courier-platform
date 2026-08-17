import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type Method,
} from 'axios';
import type { RetryConfig } from '../config';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';
import type { CourierCallAudit } from '../domain/unified.types';
import { withRetry } from './retry';
import { logger } from './logger';

export interface CourierHttpRequest {
  method: Method;
  /** Path relative to the client's base URL. */
  url: string;
  data?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Skip the automatic re-authentication path (used by the auth call itself). */
  skipAuth?: boolean;
}

export interface CourierHttpResponse<T> {
  data: T;
  audit: CourierCallAudit;
}

export interface CourierHttpClientOptions {
  courierName: string;
  baseUrl: string;
  timeoutMs: number;
  retry: RetryConfig;
  /**
   * Returns the current auth header value (e.g. `Bearer x`), refreshing if
   * needed. `forceRefresh` is set when the courier just rejected our token.
   */
  getAuthHeader?: (forceRefresh: boolean) => Promise<Record<string, string>>;
}

export interface HttpCallContext {
  requestId: string;
  orderId?: string;
  operation: string;
}

/**
 * Thin HTTP layer shared by adapters. It owns three cross-cutting concerns so
 * no adapter has to re-implement them:
 *   1. audit capture (raw request + raw response + timing),
 *   2. retry with configurable exponential backoff on 5xx/timeout/network,
 *   3. re-authentication on 401/403, followed by exactly one retry.
 */
export class CourierHttpClient {
  private readonly axios: AxiosInstance;

  constructor(private readonly options: CourierHttpClientOptions) {
    this.axios = axios.create({
      baseURL: options.baseUrl,
      timeout: options.timeoutMs,
      // Never throw on status: we classify every response ourselves so the
      // audit record is captured for failures too.
      validateStatus: () => true,
    });
  }

  async request<T>(req: CourierHttpRequest, context: HttpCallContext): Promise<CourierHttpResponse<T>> {
    return withRetry(
      () => this.sendWithAuthRecovery<T>(req, context),
      this.options.retry,
      {
        operation: `${this.options.courierName}.${context.operation}`,
        courier_partner: this.options.courierName,
        request_id: context.requestId,
        order_id: context.orderId,
      },
    );
  }

  /**
   * One attempt, plus — if the courier rejects our credentials — a forced
   * token refresh and exactly one more attempt. Never more than one, so an
   * account with genuinely bad credentials fails fast instead of hammering
   * the courier's auth endpoint.
   */
  private async sendWithAuthRecovery<T>(
    req: CourierHttpRequest,
    context: HttpCallContext,
  ): Promise<CourierHttpResponse<T>> {
    const first = await this.send<T>(req, context, false);
    if (!isAuthFailure(first.audit.httpStatus) || req.skipAuth || !this.options.getAuthHeader) {
      return this.classify<T>(first, context);
    }

    logger.warn(
      {
        courier_partner: this.options.courierName,
        request_id: context.requestId,
        order_id: context.orderId,
        operation: context.operation,
        error_type: ErrorCode.COURIER_AUTH_FAILED,
      },
      'courier rejected credentials; re-authenticating and retrying once',
    );

    const second = await this.send<T>(req, context, true);
    if (isAuthFailure(second.audit.httpStatus)) {
      throw new AppError(
        ErrorCode.COURIER_AUTH_FAILED,
        'Courier authentication failed after re-authenticating.',
        { raw: second.audit.responsePayload, retryable: false },
      );
    }
    return this.classify<T>(second, context);
  }

  private async send<T>(
    req: CourierHttpRequest,
    context: HttpCallContext,
    forceAuthRefresh: boolean,
  ): Promise<CourierHttpResponse<T>> {
    const authHeaders =
      req.skipAuth || !this.options.getAuthHeader
        ? {}
        : await this.options.getAuthHeader(forceAuthRefresh);

    const axiosConfig: AxiosRequestConfig = {
      method: req.method,
      url: req.url,
      data: req.data,
      params: req.params,
      headers: { 'Content-Type': 'application/json', ...authHeaders, ...req.headers },
    };

    const startedAt = Date.now();
    let response: AxiosResponse<T> | undefined;
    let transportError: unknown;

    try {
      response = await this.axios.request<T>(axiosConfig);
    } catch (error) {
      transportError = error;
    }

    const audit: CourierCallAudit = {
      endpoint: joinUrl(this.options.baseUrl, req.url),
      method: String(req.method).toUpperCase(),
      requestPayload: req.data ?? req.params ?? null,
      responsePayload: response ? response.data : serialiseTransportError(transportError),
      httpStatus: response?.status,
      durationMs: Date.now() - startedAt,
    };

    if (transportError) {
      // Timeouts, DNS failures, connection resets: transient by nature, so let
      // the retry wrapper have a go at them.
      throw new AppError(
        ErrorCode.COURIER_UNAVAILABLE,
        `Courier "${this.options.courierName}" is unreachable.`,
        { raw: audit, cause: transportError, retryable: true },
      );
    }

    return { data: response!.data, audit };
  }

  /** Turn a completed HTTP response into either a value or a typed AppError. */
  private classify<T>(
    result: CourierHttpResponse<T>,
    context: HttpCallContext,
  ): CourierHttpResponse<T> {
    const status = result.audit.httpStatus ?? 0;

    if (status >= 500) {
      throw new AppError(
        ErrorCode.COURIER_UNAVAILABLE,
        `Courier "${this.options.courierName}" returned a server error.`,
        { raw: result.audit, retryable: true },
      );
    }

    if (isAuthFailure(status)) {
      throw new AppError(
        ErrorCode.COURIER_AUTH_FAILED,
        'Courier authentication failed.',
        { raw: result.audit, retryable: false },
      );
    }

    if (status >= 400) {
      // The courier's own message is attached as `raw` for logs/persistence and
      // is stripped before the response reaches a client.
      throw new AppError(
        ErrorCode.COURIER_REJECTED,
        `Courier "${this.options.courierName}" rejected the ${context.operation} request.`,
        { raw: result.audit, retryable: false },
      );
    }

    return result;
  }
}

function isAuthFailure(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function serialiseTransportError(error: unknown): Record<string, unknown> {
  if (axios.isAxiosError(error)) {
    return { code: error.code ?? 'TRANSPORT_ERROR', message: error.message };
  }
  if (error instanceof Error) return { code: error.name, message: error.message };
  return { code: 'UNKNOWN_TRANSPORT_ERROR', message: String(error) };
}
