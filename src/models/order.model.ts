import { Schema, model, type InferSchemaType } from 'mongoose';
import { SHIPMENT_STATUSES, ShipmentStatus } from '../domain/shipment-status';

/**
 * One document per shipment we were asked to create.
 *
 * `orderId` carries a unique index and doubles as the idempotency key: the
 * insert is what makes duplicate submissions impossible, including under
 * concurrency, because the database — not application code — arbitrates.
 */
const courierExchangeSchema = new Schema(
  {
    operation: { type: String, required: true },
    endpoint: { type: String, required: true },
    method: { type: String, required: true },
    requestPayload: { type: Schema.Types.Mixed },
    responsePayload: { type: Schema.Types.Mixed },
    httpStatus: { type: Number },
    durationMs: { type: Number },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const failureSchema = new Schema(
  {
    errorCode: { type: String, required: true },
    message: { type: String, required: true },
    /** Courier's own error, kept for reconciliation. Never serialised to clients. */
    raw: { type: Schema.Types.Mixed },
    attempts: { type: Number, default: 1 },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    /** Client-supplied business id; also the idempotency key. */
    orderId: { type: String, required: true, unique: true, index: true },
    /** Internal surrogate id exposed in API responses. */
    internalOrderId: { type: String, required: true, unique: true, index: true },

    courierPartner: { type: String, required: true, index: true },
    courierOrderId: { type: String, default: null },
    awbNumber: { type: String, default: null, index: true },

    status: {
      type: String,
      required: true,
      enum: SHIPMENT_STATUSES,
      default: ShipmentStatus.PENDING,
      index: true,
    },
    /** The courier's own last-reported status code, unmapped. */
    courierStatusCode: { type: String, default: null },
    statusDescription: { type: String, default: null },

    labelUrl: { type: String, default: null },
    routeCode: { type: String, default: null },
    estimatedDeliveryDate: { type: String, default: null },

    /** The normalized payload the client sent us. */
    unifiedRequest: { type: Schema.Types.Mixed, required: true },

    /**
     * Full audit trail of every courier round-trip for this order: raw request
     * sent and raw response received (requirement 3.3).
     */
    courierExchanges: { type: [courierExchangeSchema], default: [] },

    /** Populated when creation failed; drives reconciliation. */
    lastFailure: { type: failureSchema, default: null },
    /** Set to true once a failed order has been reconciled/retried by an operator. */
    reconciled: { type: Boolean, default: false, index: true },

    batchId: { type: String, default: null, index: true },
    requestId: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
  },
  {
    timestamps: true, // createdAt / updatedAt (requirement 3.3)
    versionKey: false,
    collection: 'orders',
  },
);

// Surfacing failed, unreconciled orders is the single most common ops query.
orderSchema.index({ status: 1, reconciled: 1, createdAt: -1 });

export type OrderAttributes = InferSchemaType<typeof orderSchema>;

export const OrderModel = model('Order', orderSchema);

/**
 * Derived from the model rather than written as `HydratedDocument<Attributes>`:
 * the schema sets `versionKey: false`, and only the model's own hydrated type
 * reflects that, so deriving here keeps the two provably in sync.
 */
export type OrderDocument = ReturnType<(typeof OrderModel)['hydrate']>;
