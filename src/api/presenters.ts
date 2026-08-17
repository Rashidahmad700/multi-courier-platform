import type { UnifiedTrackingEvent } from '../domain/unified.types';
import type { BatchDocument } from '../models/batch.model';
import type { OrderDocument } from '../models/order.model';

/**
 * Response shaping. Kept in one place so the public contract cannot drift
 * between endpoints, and so nothing internal (raw courier payloads, Mongo
 * `_id`, stored credentials) escapes by accident.
 */

export function success<T>(data: T, requestId: string): { success: true; data: T; request_id: string } {
  return { success: true, data, request_id: requestId };
}

export function presentOrder(order: OrderDocument): Record<string, unknown> {
  return {
    order_id: order.orderId,
    internal_order_id: order.internalOrderId,
    courier_partner: order.courierPartner,
    courier_order_id: order.courierOrderId,
    awb_number: order.awbNumber,
    status: order.status,
    courier_status_code: order.courierStatusCode,
    status_description: order.statusDescription,
    label_url: order.labelUrl,
    route_code: order.routeCode,
    estimated_delivery_date: order.estimatedDeliveryDate,
    batch_id: order.batchId,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    cancelled_at: order.cancelledAt,
    ...(order.lastFailure
      ? {
          last_failure: {
            error_code: order.lastFailure.errorCode,
            message: order.lastFailure.message,
            attempts: order.lastFailure.attempts,
            at: order.lastFailure.at,
          },
        }
      : {}),
  };
}

export function presentTracking(
  order: OrderDocument,
  events: readonly UnifiedTrackingEvent[],
): Record<string, unknown> {
  return {
    ...presentOrder(order),
    history: events.map((event) => ({
      status: event.status,
      courier_status_code: event.courierStatusCode,
      description: event.description,
      location: event.location ?? null,
      reason_code: event.reasonCode ?? null,
      reason_description: event.reasonDescription ?? null,
      occurred_at: event.occurredAt,
    })),
  };
}

export function presentBatch(batch: BatchDocument): Record<string, unknown> {
  return {
    batch_id: batch.batchId,
    status: batch.status,
    counts: {
      total: batch.totalCount,
      succeeded: batch.succeededCount,
      failed: batch.failedCount,
      duplicate: batch.duplicateCount,
      pending: Math.max(
        0,
        batch.totalCount - batch.succeededCount - batch.failedCount - batch.duplicateCount,
      ),
    },
    created_at: batch.createdAt,
    started_at: batch.startedAt,
    completed_at: batch.completedAt,
    results: batch.items.map((item) => ({
      order_id: item.orderId,
      courier_partner: item.courierPartner,
      status: item.status,
      internal_order_id: item.internalOrderId,
      awb_number: item.awbNumber,
      error_code: item.errorCode,
      reason: item.reason,
      processed_at: item.processedAt,
    })),
  };
}
