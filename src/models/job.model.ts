import { Schema, model, type InferSchemaType } from 'mongoose';

export const JobStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

/**
 * A MongoDB-backed work queue.
 *
 * Chosen over BullMQ/Redis deliberately: the assignment fixes MongoDB as the
 * datastore, and adding Redis for a single queue would double the operational
 * surface. Atomic `findOneAndUpdate` gives us exactly-one-worker claim
 * semantics, and `lockedUntil` gives us crash recovery — a worker that dies
 * mid-job simply lets the lease expire and another worker picks the job up.
 * Trade-off (documented in DESIGN.md): we poll rather than get pushed, so job
 * pickup latency is bounded by BULK_WORKER_POLL_INTERVAL_MS.
 */
const jobSchema = new Schema(
  {
    /** Job family, e.g. `bulk-order`. */
    type: { type: String, required: true, index: true },
    status: {
      type: String,
      required: true,
      enum: Object.values(JobStatus),
      default: JobStatus.PENDING,
      index: true,
    },
    payload: { type: Schema.Types.Mixed, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },
    /** Lease expiry while ACTIVE; also used to schedule retries. */
    lockedUntil: { type: Date, default: null },
    availableAt: { type: Date, required: true, default: () => new Date(), index: true },
    lastError: { type: String, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'jobs' },
);

// The exact shape of the claim query, so the poll is a covered index scan.
jobSchema.index({ type: 1, status: 1, availableAt: 1 });

export type JobAttributes = InferSchemaType<typeof jobSchema>;

export const JobModel = model('Job', jobSchema);

export type JobDocument = ReturnType<(typeof JobModel)['hydrate']>;
