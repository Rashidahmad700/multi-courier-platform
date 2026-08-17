import { Schema, model, type InferSchemaType } from 'mongoose';

export const BatchStatus = {
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  /** Finished, but at least one order failed. */
  COMPLETED_WITH_ERRORS: 'COMPLETED_WITH_ERRORS',
} as const;

export type BatchStatus = (typeof BatchStatus)[keyof typeof BatchStatus];

export const BatchItemStatus = {
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  /** Order already existed; no second shipment was created (idempotency). */
  DUPLICATE: 'DUPLICATE',
} as const;

export type BatchItemStatus = (typeof BatchItemStatus)[keyof typeof BatchItemStatus];

const batchItemSchema = new Schema(
  {
    orderId: { type: String, required: true },
    courierPartner: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: Object.values(BatchItemStatus),
      default: BatchItemStatus.QUEUED,
    },
    internalOrderId: { type: String, default: null },
    awbNumber: { type: String, default: null },
    /** Normalized, client-safe error code when this item failed. */
    errorCode: { type: String, default: null },
    /** Human-readable reason (requirement 3.4). */
    reason: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    processedAt: { type: Date, default: null },
  },
  { _id: false },
);

const batchSchema = new Schema(
  {
    batchId: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      required: true,
      enum: Object.values(BatchStatus),
      default: BatchStatus.QUEUED,
      index: true,
    },
    totalCount: { type: Number, required: true },
    succeededCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    duplicateCount: { type: Number, default: 0 },
    items: { type: [batchItemSchema], default: [] },
    requestId: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'batches' },
);

export type BatchAttributes = InferSchemaType<typeof batchSchema>;

export const BatchModel = model('Batch', batchSchema);

export type BatchDocument = ReturnType<(typeof BatchModel)['hydrate']>;
