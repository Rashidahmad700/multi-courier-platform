import type { RetryConfig } from '../../config';
import { AppError } from '../../errors/app-error';
import { ErrorCode } from '../../errors/error-codes';
import type {
  AdapterResult,
  UnifiedCancelResponse,
  UnifiedServiceabilityRequest,
  UnifiedServiceabilityResponse,
  UnifiedShipmentRequest,
  UnifiedShipmentResponse,
  UnifiedTrackingResponse,
} from '../../domain/unified.types';
import { CourierHttpClient } from '../../utils/http-client';
import type { CourierCallContext, CourierCapabilities, ICourierAdapter } from '../courier.interface';
import { UrbaneBoltTokenManager } from './urbanebolt.auth';
import {
  fromCancelResponse,
  fromManifestResponse,
  fromPincodeResponse,
  fromTrackingResponse,
  toManifestItem,
} from './urbanebolt.mapper';
import type {
  UrbaneBoltCancelResponse,
  UrbaneBoltManifestResponse,
  UrbaneBoltPincodeResponse,
  UrbaneBoltTrackingResponse,
} from './urbanebolt.types';

export interface UrbaneBoltAdapterOptions {
  baseUrl: string;
  username: string;
  password: string;
  customerCode: string;
  defaultServiceType: string;
  timeoutMs: number;
  retry: RetryConfig;
  tokenRefreshSkewSeconds: number;
}

const ENDPOINTS = {
  manifest: '/api/v1/services/manifest/',
  tracking: '/api/v1/services/tracking-pub/',
  cancel: '/api/v1/services/cancel/',
  pincodes: '/api/v1/location/pincodes/',
} as const;

/**
 * UrbaneBolt integration. Holds only transport + orchestration concerns; all
 * field-level translation lives in `urbanebolt.mapper.ts`, so a change to
 * UrbaneBolt's schema touches the mapper and types, not this class.
 */
export class UrbaneBoltAdapter implements ICourierAdapter {
  readonly name = 'urbanebolt';
  readonly capabilities: CourierCapabilities = {
    serviceability: true,
    shippingLabel: true,
    cancellation: true,
  };

  private readonly http: CourierHttpClient;
  private readonly tokens: UrbaneBoltTokenManager;

  constructor(private readonly options: UrbaneBoltAdapterOptions) {
    this.tokens = new UrbaneBoltTokenManager({
      baseUrl: options.baseUrl,
      username: options.username,
      password: options.password,
      timeoutMs: options.timeoutMs,
      refreshSkewSeconds: options.tokenRefreshSkewSeconds,
    });

    this.http = new CourierHttpClient({
      courierName: this.name,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      getAuthHeader: (forceRefresh) => this.tokens.getAuthHeader(forceRefresh),
    });
  }

  async createShipment(
    request: UnifiedShipmentRequest,
    context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedShipmentResponse>> {
    const item = toManifestItem(request, {
      customerCode: this.options.customerCode,
      defaultServiceType: this.options.defaultServiceType,
    });

    // The manifest endpoint takes an array. We deliberately send one order per
    // call: it keeps a courier-side per-item failure attributable to exactly one
    // of our orders, which is what bulk partial-success reporting depends on.
    const { data, audit } = await this.http.request<UrbaneBoltManifestResponse>(
      { method: 'POST', url: ENDPOINTS.manifest, data: [item] },
      { requestId: context.requestId, orderId: request.orderId, operation: 'createShipment' },
    );

    return { data: fromManifestResponse(data, request.orderId), audit };
  }

  async trackShipment(
    awbNumber: string,
    context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedTrackingResponse>> {
    const { data, audit } = await this.http.request<UrbaneBoltTrackingResponse>(
      { method: 'GET', url: ENDPOINTS.tracking, params: { awb: awbNumber } },
      { requestId: context.requestId, orderId: context.orderId, operation: 'trackShipment' },
    );

    return { data: fromTrackingResponse(data, awbNumber), audit };
  }

  async cancelShipment(
    awbNumber: string,
    context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedCancelResponse>> {
    const { data, audit } = await this.http.request<UrbaneBoltCancelResponse>(
      { method: 'POST', url: ENDPOINTS.cancel, data: { awbs: awbNumber } },
      { requestId: context.requestId, orderId: context.orderId, operation: 'cancelShipment' },
    );

    return { data: fromCancelResponse(data, awbNumber), audit };
  }

  async checkServiceability(
    request: UnifiedServiceabilityRequest,
    context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedServiceabilityResponse>> {
    const pincodes = `${request.pickupPincode},${request.deliveryPincode}`;
    const { data, audit } = await this.http.request<UrbaneBoltPincodeResponse>(
      { method: 'GET', url: ENDPOINTS.pincodes, params: { pincodes } },
      { requestId: context.requestId, orderId: context.orderId, operation: 'checkServiceability' },
    );

    return {
      data: fromPincodeResponse(data, request.pickupPincode, request.deliveryPincode),
      audit,
    };
  }
}

/**
 * Builds the adapter from validated config, failing loudly at resolution time
 * if this deployment has UrbaneBolt enabled without credentials.
 */
export function createUrbaneBoltAdapter(options: {
  baseUrl?: string;
  username?: string;
  password?: string;
  customerCode?: string;
  defaultServiceType: string;
  tokenRefreshSkewSeconds: number;
  timeoutMs: number;
  retry: RetryConfig;
}): UrbaneBoltAdapter {
  const missing = (
    [
      ['URBANEBOLT_BASE_URL', options.baseUrl],
      ['URBANEBOLT_USERNAME', options.username],
      ['URBANEBOLT_PASSWORD', options.password],
      ['URBANEBOLT_CUSTOMER_CODE', options.customerCode],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      `UrbaneBolt is enabled but not configured. Missing: ${missing.join(', ')}.`,
    );
  }

  return new UrbaneBoltAdapter({
    baseUrl: options.baseUrl!,
    username: options.username!,
    password: options.password!,
    customerCode: options.customerCode!,
    defaultServiceType: options.defaultServiceType,
    timeoutMs: options.timeoutMs,
    retry: options.retry,
    tokenRefreshSkewSeconds: options.tokenRefreshSkewSeconds,
  });
}
