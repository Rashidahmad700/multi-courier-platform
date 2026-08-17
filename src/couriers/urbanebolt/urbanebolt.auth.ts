import axios, { type AxiosInstance } from 'axios';
import { AppError } from '../../errors/app-error';
import { ErrorCode } from '../../errors/error-codes';
import { logger } from '../../utils/logger';
import type { UrbaneBoltAuthResponse } from './urbanebolt.types';

export interface UrbaneBoltAuthOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
  /** Refresh this many seconds before the courier's stated expiry. */
  refreshSkewSeconds: number;
}

/**
 * Caches the UrbaneBolt bearer token and refreshes it on demand.
 *
 * Concurrent callers share a single in-flight refresh (`pending`), so a burst
 * of 100 bulk orders triggers one token call, not 100.
 */
export class UrbaneBoltTokenManager {
  private token: string | null = null;
  private expiresAtMs = 0;
  private pending: Promise<string> | null = null;
  private readonly http: AxiosInstance;

  constructor(private readonly options: UrbaneBoltAuthOptions) {
    this.http = axios.create({
      baseURL: options.baseUrl,
      timeout: options.timeoutMs,
      validateStatus: () => true,
    });
  }

  /** `Authorization` header, refreshing the token when stale or forced. */
  async getAuthHeader(forceRefresh = false): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getToken(forceRefresh)}` };
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && Date.now() < this.expiresAtMs) {
      return this.token;
    }
    if (forceRefresh) this.invalidate();
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  invalidate(): void {
    this.token = null;
    this.expiresAtMs = 0;
  }

  private async fetchToken(): Promise<string> {
    const response = await this.http
      .post<UrbaneBoltAuthResponse>(
        '/api/v1/auth/getToken/',
        { username: this.options.username, password: this.options.password },
        { headers: { 'Content-Type': 'application/json' } },
      )
      .catch((error: unknown) => {
        throw new AppError(ErrorCode.COURIER_UNAVAILABLE, 'UrbaneBolt auth endpoint unreachable.', {
          cause: error,
          raw: error,
          retryable: true,
        });
      });

    if (response.status >= 500) {
      throw new AppError(ErrorCode.COURIER_UNAVAILABLE, 'UrbaneBolt auth endpoint returned 5xx.', {
        raw: response.data,
        retryable: true,
      });
    }
    if (response.status >= 400 || !response.data?.access_token) {
      throw new AppError(ErrorCode.COURIER_AUTH_FAILED, 'UrbaneBolt rejected the API credentials.', {
        raw: response.data,
        retryable: false,
      });
    }

    const { access_token: accessToken, expires_in: expiresIn } = response.data;
    const lifetimeSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
    const effectiveSeconds = Math.max(
      60,
      lifetimeSeconds - this.options.refreshSkewSeconds,
    );

    this.token = accessToken;
    this.expiresAtMs = Date.now() + effectiveSeconds * 1000;

    logger.info(
      { courier_partner: 'urbanebolt', expires_in_s: lifetimeSeconds },
      'obtained UrbaneBolt access token',
    );
    return accessToken;
  }
}
