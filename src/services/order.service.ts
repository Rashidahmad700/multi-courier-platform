import { randomUUID } from 'node:crypto';
import type { CourierRegistry } from '../couriers/courier.registry';
import type { ICourierAdapter } from '../couriers/courier.interface';
import { ShipmentStatus, isCancellable } from '../domain/shipment-status';
import type {
  CourierCallAudit,
  UnifiedShipmentRequest,
  UnifiedTrackingEvent,
} from '../domain/unified.types';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';
import { OrderModel, type OrderDocument } from '../models/order.model';
import { TrackingEventModel } from '../models/tracking-event.model';
import { logFailure, logger } from '../utils/logger';

export interface OperationContext {
  requestId: string;
  batchId?: string;
}

export interface CreateOrderResult {
  order: OrderDocument;
  /**
   * True when this call did not create a new shipment because the order_id had
   * already been processed — the idempotency guarantee (requirement 3.4).
   */
  idempotentReplay: boolean;
}

const DUPLICATE_KEY_ERROR = 11000;

/**
 * Courier-agnostic orchestration for a single order. Every courier-specific
 * concern is behind `ICourierAdapter`, which is why adding a courier needs no
 * change in this file (requirement 3.2).
 */
export class OrderService {
  constructor(private readonly registry: CourierRegistry) {}

  /**
   * Create one shipment.
   *
   * Idempotency is enforced by the unique index on `orders.orderId`: we insert
   * the order *before* calling the courier, so two concurrent requests for the
   * same order_id race on the database and exactly one wins. The loser never
   * reaches the courier.
   */
  async createOrder(
    courierPartner: string,
    request: UnifiedShipmentRequest,
    context: OperationContext,
  ): Promise<CreateOrderResult> {
    // Resolve first: an unknown courier must fail before we persist anything.
    const adapter = this.registry.get(courierPartner);

    const claim = await this.claimOrder(adapter.name, request, context);
    if (claim.replay) {
      logger.info(
        { order_id: request.orderId, request_id: context.requestId, courier_partner: adapter.name },
        'idempotent replay: order already processed, no shipment created',
      );
      return { order: claim.order, idempotentReplay: true };
    }

    const order = await this.dispatchToCourier(adapter, claim.order, request, context);
    return { order, idempotentReplay: false };
  }

  /**
   * Insert-or-adopt. Returns `replay: true` when an existing order already has
   * (or is actively getting) a shipment; returns the adoptable document when a
   * previous attempt failed and is safe to retry.
   */
  private async claimOrder(
    courierPartner: string,
    request: UnifiedShipmentRequest,
    context: OperationContext,
  ): Promise<{ order: OrderDocument; replay: boolean }> {
    try {
      const created = await OrderModel.create({
        orderId: request.orderId,
        internalOrderId: `ord_${randomUUID()}`,
        courierPartner,
        status: ShipmentStatus.PENDING,
        unifiedRequest: request,
        requestId: context.requestId,
        batchId: context.batchId ?? null,
      });
      return { order: created, replay: false };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      const existing = await OrderModel.findOne({ orderId: request.orderId }).exec();
      if (!existing) {
        // Vanishingly rare: the winning insert was rolled back between our
        // failure and this read. Surface it rather than looping.
        throw new AppError(
          ErrorCode.DUPLICATE_ORDER,
          `Order "${request.orderId}" is already being processed.`,
        );
      }

      // A previous attempt that never reached the courier may be retried in
      // place; anything with an AWB is a definitive replay.
      const retryable = existing.status === ShipmentStatus.FAILED && !existing.awbNumber;
      return { order: existing, replay: !retryable };
    }
  }

  private async dispatchToCourier(
    adapter: ICourierAdapter,
    order: OrderDocument,
    request: UnifiedShipmentRequest,
    context: OperationContext,
  ): Promise<OrderDocument> {
    try {
      const { data, audit } = await adapter.createShipment(request, {
        requestId: context.requestId,
        orderId: request.orderId,
      });

      order.set({
        courierOrderId: data.courierOrderId ?? null,
        awbNumber: data.awbNumber,
        status: data.status,
        labelUrl: data.labelUrl ?? null,
        routeCode: data.routeCode ?? null,
        estimatedDeliveryDate: data.estimatedDeliveryDate ?? null,
        lastFailure: null,
      });
      order.courierExchanges.push(toExchange('createShipment', audit));
      await order.save();

      // No tracking event is written here on purpose: `tracking_events` holds
      // courier-reported scans only. Couriers emit their own creation scan
      // (UrbaneBolt: "MAN"), and synthesising one here would duplicate it. The
      // platform-side record of creation is the order document itself.

      logger.info(
        {
          order_id: order.orderId,
          internal_order_id: order.internalOrderId,
          courier_partner: adapter.name,
          awb: data.awbNumber,
          request_id: context.requestId,
        },
        'shipment created',
      );
      return order;
    } catch (error) {
      const appError = AppError.from(error);

      // Persist the failure so it is reconcilable later rather than lost with
      // the HTTP response (requirement 3.5).
      order.set({
        status: ShipmentStatus.FAILED,
        lastFailure: {
          errorCode: appError.code,
          message: appError.message,
          raw: sanitizeRaw(appError.raw),
          attempts: (order.lastFailure?.attempts ?? 0) + 1,
          at: new Date(),
        },
      });
      if (isAuditRaw(appError.raw)) {
        order.courierExchanges.push(toExchange('createShipment', appError.raw));
      }
      await order.save();

      logFailure(
        {
          order_id: order.orderId,
          courier_partner: adapter.name,
          request_id: context.requestId,
          error_type: appError.code,
        },
        appError,
        'shipment creation failed',
      );
      throw appError;
    }
  }

  /** Current status plus full history, refreshed from the courier when possible. */
  async trackOrder(orderRef: string, context: OperationContext): Promise<{
    order: OrderDocument;
    events: UnifiedTrackingEvent[];
  }> {
    const order = await this.findOrder(orderRef);

    if (!order.awbNumber) {
      // Never handed to a courier (queued, or creation failed). The stored
      // status is authoritative; there is nothing to poll.
      return { order, events: await this.storedEvents(order) };
    }

    const adapter = this.registry.get(order.courierPartner);

    try {
      const { data, audit } = await adapter.trackShipment(order.awbNumber, {
        requestId: context.requestId,
        orderId: order.orderId,
      });

      await this.appendTrackingEvents(order, data.events, audit.responsePayload, context.requestId);

      order.set({
        status: data.currentStatus,
        courierStatusCode: data.courierStatusCode,
        statusDescription: data.statusDescription,
        estimatedDeliveryDate: data.estimatedDeliveryDate ?? order.estimatedDeliveryDate,
      });
      order.courierExchanges.push(toExchange('trackShipment', audit));
      await order.save();

      if (data.currentStatus === ShipmentStatus.UNKNOWN) {
        logger.warn(
          {
            order_id: order.orderId,
            courier_partner: adapter.name,
            courier_status_code: data.courierStatusCode,
            request_id: context.requestId,
          },
          'courier reported an unmapped status code; stored as UNKNOWN with the raw code',
        );
      }
    } catch (error) {
      const appError = AppError.from(error);
      logFailure(
        {
          order_id: order.orderId,
          courier_partner: order.courierPartner,
          request_id: context.requestId,
          error_type: appError.code,
        },
        appError,
        'live tracking refresh failed; serving last known state',
      );
      // Tracking is a read: a courier outage should degrade to the last known
      // state, not fail the request. Anything else (bad AWB, auth) surfaces.
      if (appError.code !== ErrorCode.COURIER_UNAVAILABLE) throw appError;
    }

    return { order, events: await this.storedEvents(order) };
  }

  async cancelOrder(orderRef: string, context: OperationContext): Promise<OrderDocument> {
    const order = await this.findOrder(orderRef);

    if (!isCancellable(order.status as ShipmentStatus)) {
      if (order.status === ShipmentStatus.CANCELLED) return order; // idempotent
      throw new AppError(
        ErrorCode.INVALID_STATE,
        `Order "${order.orderId}" is ${order.status} and can no longer be cancelled.`,
      );
    }

    // No AWB means the courier never got it; cancelling is a local state change.
    if (!order.awbNumber) {
      order.set({ status: ShipmentStatus.CANCELLED, cancelledAt: new Date() });
      await order.save();
      return order;
    }

    const adapter = this.registry.get(order.courierPartner);
    if (!adapter.capabilities.cancellation) {
      throw new AppError(
        ErrorCode.INVALID_STATE,
        `Courier "${adapter.name}" does not support cancellation.`,
      );
    }

    try {
      const { data, audit } = await adapter.cancelShipment(order.awbNumber, {
        requestId: context.requestId,
        orderId: order.orderId,
      });

      order.set({
        status: ShipmentStatus.CANCELLED,
        statusDescription: data.message,
        cancelledAt: new Date(),
      });
      order.courierExchanges.push(toExchange('cancelShipment', audit));
      await order.save();

      // As with creation: the courier's own cancellation scan arrives via
      // tracking. `cancelledAt` plus the persisted exchange is the platform's
      // record, so the append-only history stays purely courier-reported.

      logger.info(
        {
          order_id: order.orderId,
          courier_partner: adapter.name,
          awb: order.awbNumber,
          request_id: context.requestId,
        },
        'shipment cancelled',
      );
      return order;
    } catch (error) {
      const appError = AppError.from(error);
      logFailure(
        {
          order_id: order.orderId,
          courier_partner: order.courierPartner,
          request_id: context.requestId,
          error_type: appError.code,
        },
        appError,
        'shipment cancellation failed',
      );
      throw appError;
    }
  }

  /** Accepts either our internal order id or the client's order_id. */
  private async findOrder(orderRef: string): Promise<OrderDocument> {
    const order = await OrderModel.findOne({
      $or: [{ internalOrderId: orderRef }, { orderId: orderRef }],
    }).exec();
    if (!order) throw AppError.notFound(`Order "${orderRef}"`);
    return order;
  }

  /**
   * Append-only write. Duplicate scans are rejected by the `uniq_scan` index
   * and skipped via `ordered: false`; nothing is ever updated or deleted.
   */
  private async appendTrackingEvents(
    order: OrderDocument,
    events: readonly UnifiedTrackingEvent[],
    rawPayload: unknown,
    requestId: string,
  ): Promise<void> {
    if (events.length === 0 || !order.awbNumber) return;

    const docs = events.map((event) => ({
      orderId: order.orderId,
      internalOrderId: order.internalOrderId,
      courierPartner: order.courierPartner,
      awbNumber: order.awbNumber as string,
      status: event.status,
      courierStatusCode: event.courierStatusCode,
      description: event.description,
      location: event.location ?? null,
      reasonCode: event.reasonCode ?? null,
      reasonDescription: event.reasonDescription ?? null,
      occurredAt: event.occurredAt,
      recordedAt: new Date(),
      rawPayload,
      requestId,
    }));

    try {
      await TrackingEventModel.insertMany(docs, { ordered: false });
    } catch (error) {
      // `ordered: false` reports duplicates as a bulk error while still having
      // inserted the new documents. Only a non-duplicate failure is a problem.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  private async storedEvents(order: OrderDocument): Promise<UnifiedTrackingEvent[]> {
    const events = await TrackingEventModel.find({ internalOrderId: order.internalOrderId })
      .sort({ occurredAt: 1 })
      .lean()
      .exec();

    return events.map((event) => ({
      status: event.status as ShipmentStatus,
      courierStatusCode: event.courierStatusCode,
      description: event.description ?? '',
      ...(event.location ? { location: event.location } : {}),
      occurredAt: event.occurredAt,
      ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
      ...(event.reasonDescription ? { reasonDescription: event.reasonDescription } : {}),
    }));
  }
}

function toExchange(operation: string, audit: CourierCallAudit): Record<string, unknown> {
  return {
    operation,
    endpoint: audit.endpoint,
    method: audit.method,
    requestPayload: audit.requestPayload,
    responsePayload: audit.responsePayload,
    httpStatus: audit.httpStatus,
    durationMs: audit.durationMs,
    at: new Date(),
  };
}

function isAuditRaw(raw: unknown): raw is CourierCallAudit {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'endpoint' in raw &&
    'method' in raw &&
    'durationMs' in raw
  );
}

/** Keep the stored blob bounded so one pathological courier reply cannot bloat a document. */
function sanitizeRaw(raw: unknown): unknown {
  if (raw === undefined) return null;
  const serialised = safeStringify(raw);
  return serialised.length > 20_000 ? { truncated: true, preview: serialised.slice(0, 20_000) } : raw;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: number; writeErrors?: Array<{ code?: number }> };
  if (candidate.code === DUPLICATE_KEY_ERROR) return true;
  return (candidate.writeErrors ?? []).every((writeError) => writeError.code === DUPLICATE_KEY_ERROR)
    && (candidate.writeErrors ?? []).length > 0;
}
