import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors/app-error';
import { ErrorCode } from '../../errors/error-codes';
import type {
  AdapterResult,
  CourierCallAudit,
  UnifiedCancelResponse,
  UnifiedServiceabilityRequest,
  UnifiedServiceabilityResponse,
  UnifiedShipmentRequest,
  UnifiedShipmentResponse,
  UnifiedTrackingResponse,
} from '../../domain/unified.types';
import type { CourierCallContext, CourierCapabilities, ICourierAdapter } from '../courier.interface';
import { MOCK_STATUS_MAP, mapMockStatus } from './mock.status';

export interface MockCourierOptions {
  /** Simulated network latency, so bulk concurrency is observable in dev. */
  latencyMs: number;
  /** Any shipment to this delivery pincode is rejected — drives failure-path tests. */
  failPincode: string;
}

interface MockShipment {
  awbNumber: string;
  orderId: string;
  courierStatusCode: string;
  scans: Array<{ code: string; at: Date; location: string }>;
}

/**
 * A second, fully in-process courier. It exists to prove the claim in
 * DESIGN.md that adding a courier touches only its own folder, one config
 * entry and one registry line — and to give the test suite a deterministic,
 * network-free courier to exercise the full create -> track -> cancel path.
 *
 * It deliberately uses its own status vocabulary (`SHIPMENT_BOOKED`, ...) so
 * the status-mapping seam is genuinely exercised, not bypassed.
 */
export class MockCourierAdapter implements ICourierAdapter {
  readonly name = 'mock';
  readonly capabilities: CourierCapabilities = {
    serviceability: true,
    shippingLabel: true,
    cancellation: true,
  };

  private readonly shipments = new Map<string, MockShipment>();

  constructor(private readonly options: MockCourierOptions) {}

  async createShipment(
    request: UnifiedShipmentRequest,
    _context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedShipmentResponse>> {
    const startedAt = Date.now();
    await this.delay();

    const wireRequest = {
      reference: request.orderId,
      to_pin: request.delivery.pincode,
      from_pin: request.pickup.pincode,
      payment: request.paymentMode,
      cod_amount: request.codAmount,
      weight_kg: request.dimensions.weightKg,
    };

    if (request.delivery.pincode === this.options.failPincode) {
      throw new AppError(
        ErrorCode.COURIER_NOT_SERVICEABLE,
        `Mock courier does not deliver to pincode ${request.delivery.pincode}.`,
        {
          raw: { ...wireRequest, mock_error: 'PINCODE_BLACKLISTED' },
          retryable: false,
        },
      );
    }

    const awbNumber = `MOCK${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    const shipment: MockShipment = {
      awbNumber,
      orderId: request.orderId,
      courierStatusCode: 'SHIPMENT_BOOKED',
      scans: [{ code: 'SHIPMENT_BOOKED', at: new Date(), location: request.pickup.city }],
    };
    this.shipments.set(awbNumber, shipment);

    const wireResponse = {
      ok: true,
      reference: request.orderId,
      tracking_id: awbNumber,
      label_url: `https://mock-courier.local/labels/${awbNumber}.pdf`,
      state: shipment.courierStatusCode,
    };

    return {
      data: {
        courierOrderId: request.orderId,
        awbNumber,
        status: mapMockStatus(shipment.courierStatusCode),
        labelUrl: wireResponse.label_url,
      },
      audit: this.audit('POST', '/mock/shipments', wireRequest, wireResponse, startedAt),
    };
  }

  async trackShipment(
    awbNumber: string,
    _context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedTrackingResponse>> {
    const startedAt = Date.now();
    await this.delay();

    const shipment = this.shipments.get(awbNumber);
    if (!shipment) {
      throw AppError.notFound(`Shipment "${awbNumber}" at mock courier`);
    }

    const wireResponse = {
      tracking_id: shipment.awbNumber,
      reference: shipment.orderId,
      state: shipment.courierStatusCode,
      history: shipment.scans.map((scan) => ({
        state: scan.code,
        at: scan.at.toISOString(),
        hub: scan.location,
      })),
    };

    return {
      data: {
        awbNumber: shipment.awbNumber,
        courierOrderId: shipment.orderId,
        currentStatus: mapMockStatus(shipment.courierStatusCode),
        courierStatusCode: shipment.courierStatusCode,
        statusDescription: MOCK_STATUS_MAP[shipment.courierStatusCode]?.description ?? '',
        events: shipment.scans.map((scan) => ({
          status: mapMockStatus(scan.code),
          courierStatusCode: scan.code,
          description: MOCK_STATUS_MAP[scan.code]?.description ?? '',
          location: scan.location,
          occurredAt: scan.at,
        })),
      },
      audit: this.audit(
        'GET',
        `/mock/shipments/${awbNumber}`,
        { tracking_id: awbNumber },
        wireResponse,
        startedAt,
      ),
    };
  }

  async cancelShipment(
    awbNumber: string,
    _context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedCancelResponse>> {
    const startedAt = Date.now();
    await this.delay();

    const shipment = this.shipments.get(awbNumber);
    if (!shipment) {
      throw AppError.notFound(`Shipment "${awbNumber}" at mock courier`);
    }
    if (shipment.courierStatusCode === 'DELIVERY_DONE') {
      throw new AppError(
        ErrorCode.INVALID_STATE,
        `AWB "${awbNumber}" is already delivered and cannot be cancelled.`,
        { retryable: false },
      );
    }

    const alreadyCancelled = shipment.courierStatusCode === 'SHIPMENT_VOID';
    if (!alreadyCancelled) {
      shipment.courierStatusCode = 'SHIPMENT_VOID';
      shipment.scans.push({ code: 'SHIPMENT_VOID', at: new Date(), location: 'SYSTEM' });
    }

    return {
      data: {
        awbNumber,
        cancelled: true,
        message: alreadyCancelled
          ? 'Shipment was already cancelled.'
          : 'Shipment cancelled at the courier.',
      },
      audit: this.audit(
        'POST',
        `/mock/shipments/${awbNumber}/cancel`,
        { tracking_id: awbNumber },
        { ok: true, state: 'SHIPMENT_VOID' },
        startedAt,
      ),
    };
  }

  async checkServiceability(
    request: UnifiedServiceabilityRequest,
    _context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedServiceabilityResponse>> {
    const startedAt = Date.now();
    await this.delay();

    const serviceable = request.deliveryPincode !== this.options.failPincode;
    return {
      data: {
        serviceable,
        availableServiceTypes: serviceable ? ['STANDARD', 'EXPRESS'] : [],
        ...(serviceable ? {} : { reason: 'Delivery pincode is blacklisted by the mock courier.' }),
      },
      audit: this.audit('GET', '/mock/serviceability', request, { serviceable }, startedAt),
    };
  }

  /** Test helper: force a shipment into a given courier-side state. */
  advanceTo(awbNumber: string, courierStatusCode: string, location = 'HUB'): void {
    const shipment = this.shipments.get(awbNumber);
    if (!shipment) throw new Error(`unknown mock AWB ${awbNumber}`);
    shipment.courierStatusCode = courierStatusCode;
    shipment.scans.push({ code: courierStatusCode, at: new Date(), location });
  }

  private async delay(): Promise<void> {
    if (this.options.latencyMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
  }

  private audit(
    method: string,
    endpoint: string,
    requestPayload: unknown,
    responsePayload: unknown,
    startedAt: number,
  ): CourierCallAudit {
    return {
      endpoint,
      method,
      requestPayload,
      responsePayload,
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Factory, mirroring the shape of the real adapters' factories. */
export function createMockCourierAdapter(options: MockCourierOptions): MockCourierAdapter {
  return new MockCourierAdapter(options);
}
