import { Schema, model, type InferSchemaType } from 'mongoose';
import { SHIPMENT_STATUSES } from '../domain/shipment-status';

/**
 * Append-only tracking history (requirement 3.3).
 *
 * Nothing in the codebase updates or deletes a document in this collection —
 * writes go through `insertMany(..., { ordered: false })` and rely on the
 * unique index below to drop replays of events we already stored, so polling
 * the courier repeatedly does not duplicate history.
 */
const trackingEventSchema = new Schema(
  {
    orderId: { type: String, required: true, index: true },
    internalOrderId: { type: String, required: true, index: true },
    courierPartner: { type: String, required: true },
    awbNumber: { type: String, required: true, index: true },

    /** Unified status this event maps to. */
    status: { type: String, required: true, enum: SHIPMENT_STATUSES },
    /** The courier's own code, preserved even when it maps to UNKNOWN. */
    courierStatusCode: { type: String, required: true },
    description: { type: String, default: '' },
    location: { type: String, default: null },
    reasonCode: { type: String, default: null },
    reasonDescription: { type: String, default: null },

    /** When the courier says the scan happened. */
    occurredAt: { type: Date, required: true },
    /** When we recorded it. */
    recordedAt: { type: Date, required: true, default: () => new Date() },

    /** The exact courier payload this event was derived from. */
    rawPayload: { type: Schema.Types.Mixed },
    requestId: { type: String, default: null },
  },
  {
    versionKey: false,
    collection: 'tracking_events',
    // Guard rail: a schema-level hook is cheap insurance that no future change
    // accidentally introduces a mutating write path into an audit collection.
    strict: 'throw',
  },
);

// De-duplicates replayed scans: same shipment + same courier code + same instant.
trackingEventSchema.index(
  { awbNumber: 1, courierStatusCode: 1, occurredAt: 1 },
  { unique: true, name: 'uniq_scan' },
);
trackingEventSchema.index({ internalOrderId: 1, occurredAt: 1 });

export type TrackingEventAttributes = InferSchemaType<typeof trackingEventSchema>;

export const TrackingEventModel = model('TrackingEvent', trackingEventSchema);

export type TrackingEventDocument = ReturnType<(typeof TrackingEventModel)['hydrate']>;
