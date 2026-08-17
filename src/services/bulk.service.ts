import { randomUUID } from 'node:crypto';
import { config } from '../config';
import type { UnifiedShipmentRequest } from '../domain/unified.types';
import { AppError } from '../errors/app-error';
import { BatchItemStatus, BatchModel, BatchStatus, type BatchDocument } from '../models/batch.model';
import { jobQueue, type JobQueue } from '../queue/job.queue';
import { mapWithConcurrency } from '../utils/concurrency';
import { logFailure, logger } from '../utils/logger';
import type { OrderService } from './order.service';

export const BULK_JOB_TYPE = 'bulk-order';

export interface BulkOrderInput {
  courierPartner: string;
  order: UnifiedShipmentRequest;
}

export interface BulkJobPayload {
  batchId: string;
  requestId: string;
  orders: BulkOrderInput[];
}

/**
 * Bulk create.
 *
 * Strategy (requirement 3.4): accept, persist, enqueue, and return a
 * `batch_id` immediately — the HTTP request never waits on any courier call.
 * A worker then processes the batch with bounded concurrency. Alternatives
 * considered and why they lost are recorded in DESIGN.md.
 */
export class BulkService {
  constructor(
    private readonly orderService: OrderService,
    private readonly queue: JobQueue = jobQueue,
  ) {}

  /** Validates size, records the batch, enqueues the job. Returns instantly. */
  async submit(orders: BulkOrderInput[], requestId: string): Promise<BatchDocument> {
    if (orders.length === 0) {
      throw AppError.validation('A bulk request must contain at least one order.', [
        { field: 'orders', message: 'must contain between 1 and ' + config.bulk.maxOrders + ' orders' },
      ]);
    }
    if (orders.length > config.bulk.maxOrders) {
      throw AppError.validation(
        `A bulk request may contain at most ${config.bulk.maxOrders} orders.`,
        [{ field: 'orders', message: `received ${orders.length}, limit is ${config.bulk.maxOrders}` }],
      );
    }

    const duplicateIds = findDuplicateOrderIds(orders);
    if (duplicateIds.length > 0) {
      throw AppError.validation('order_id values must be unique within a batch.', [
        { field: 'orders[].order_id', message: `duplicated: ${duplicateIds.join(', ')}` },
      ]);
    }

    const batchId = `batch_${randomUUID()}`;
    const batch = await BatchModel.create({
      batchId,
      status: BatchStatus.QUEUED,
      totalCount: orders.length,
      requestId,
      items: orders.map((entry) => ({
        orderId: entry.order.orderId,
        courierPartner: entry.courierPartner,
        status: BatchItemStatus.QUEUED,
      })),
    });

    const payload: BulkJobPayload = { batchId, requestId, orders };
    await this.queue.enqueue(BULK_JOB_TYPE, payload, { maxAttempts: config.bulk.maxAttempts });

    logger.info(
      { batch_id: batchId, request_id: requestId, order_count: orders.length },
      'bulk batch accepted and queued',
    );
    return batch;
  }

  async getBatch(batchId: string): Promise<BatchDocument> {
    const batch = await BatchModel.findOne({ batchId }).exec();
    if (!batch) throw AppError.notFound(`Batch "${batchId}"`);
    return batch;
  }

  /**
   * Worker entry point. Processes the batch with bounded concurrency; a single
   * order failing never aborts the rest, and every outcome — success, failure,
   * idempotent duplicate — is recorded per item with a human-readable reason.
   */
  async processBatch(payload: BulkJobPayload): Promise<void> {
    const { batchId, requestId, orders } = payload;

    await BatchModel.updateOne(
      { batchId },
      { $set: { status: BatchStatus.PROCESSING, startedAt: new Date() } },
    ).exec();

    await mapWithConcurrency(orders, config.bulk.workerConcurrency, async (entry) => {
      await this.processOne(batchId, requestId, entry);
    });

    await this.finalise(batchId);
  }

  private async processOne(
    batchId: string,
    requestId: string,
    entry: BulkOrderInput,
  ): Promise<void> {
    const { courierPartner, order } = entry;

    try {
      const result = await this.orderService.createOrder(courierPartner, order, {
        requestId,
        batchId,
      });

      await this.updateItem(batchId, order.orderId, {
        status: result.idempotentReplay ? BatchItemStatus.DUPLICATE : BatchItemStatus.SUCCEEDED,
        internalOrderId: result.order.internalOrderId,
        awbNumber: result.order.awbNumber ?? null,
        errorCode: null,
        reason: result.idempotentReplay
          ? 'Order already existed; no new shipment was created.'
          : null,
      });
    } catch (error) {
      const appError = AppError.from(error);
      await this.updateItem(batchId, order.orderId, {
        status: BatchItemStatus.FAILED,
        errorCode: appError.code,
        // Client-safe, human-readable: our own message, never the courier's raw text.
        reason: appError.message,
      });

      logFailure(
        {
          order_id: order.orderId,
          courier_partner: courierPartner,
          request_id: requestId,
          batch_id: batchId,
          error_type: appError.code,
        },
        appError,
        'bulk item failed',
      );
    }
  }

  private async updateItem(
    batchId: string,
    orderId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const set: Record<string, unknown> = { 'items.$[item].processedAt': new Date() };
    for (const [key, value] of Object.entries(patch)) {
      set[`items.$[item].${key}`] = value;
    }

    await BatchModel.updateOne(
      { batchId },
      { $set: set, $inc: { 'items.$[item].attempts': 1 } },
      { arrayFilters: [{ 'item.orderId': orderId }] },
    ).exec();
  }

  /** Recompute counts from the items themselves so a retried job stays correct. */
  private async finalise(batchId: string): Promise<void> {
    const batch = await BatchModel.findOne({ batchId }).exec();
    if (!batch) return;

    const succeeded = batch.items.filter((i) => i.status === BatchItemStatus.SUCCEEDED).length;
    const duplicates = batch.items.filter((i) => i.status === BatchItemStatus.DUPLICATE).length;
    const failed = batch.items.filter((i) => i.status === BatchItemStatus.FAILED).length;

    batch.set({
      succeededCount: succeeded,
      duplicateCount: duplicates,
      failedCount: failed,
      status: failed > 0 ? BatchStatus.COMPLETED_WITH_ERRORS : BatchStatus.COMPLETED,
      completedAt: new Date(),
    });
    await batch.save();

    logger.info(
      {
        batch_id: batchId,
        succeeded,
        duplicates,
        failed,
        total: batch.totalCount,
      },
      'bulk batch finished',
    );
  }
}

function findDuplicateOrderIds(orders: readonly BulkOrderInput[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of orders) {
    if (seen.has(entry.order.orderId)) duplicates.add(entry.order.orderId);
    seen.add(entry.order.orderId);
  }
  return [...duplicates];
}
