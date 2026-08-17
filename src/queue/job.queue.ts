import { JobModel, JobStatus, type JobDocument } from '../models/job.model';
import { logger } from '../utils/logger';

export interface EnqueueOptions {
  maxAttempts: number;
  /** Delay before the job becomes claimable. */
  delayMs?: number;
}

/**
 * Minimal queue API over the `jobs` collection. Kept separate from the worker
 * so producers (the HTTP layer) never import worker machinery.
 */
export class JobQueue {
  async enqueue(type: string, payload: unknown, options: EnqueueOptions): Promise<JobDocument> {
    return JobModel.create({
      type,
      payload,
      maxAttempts: options.maxAttempts,
      availableAt: new Date(Date.now() + (options.delayMs ?? 0)),
      status: JobStatus.PENDING,
    });
  }

  /**
   * Atomically claim one due job and lease it for `visibilityTimeoutMs`.
   * `findOneAndUpdate` is a single-document atomic operation, so two workers
   * can never claim the same job.
   */
  async claim(type: string, visibilityTimeoutMs: number): Promise<JobDocument | null> {
    const now = new Date();
    return JobModel.findOneAndUpdate(
      {
        type,
        availableAt: { $lte: now },
        $or: [
          { status: JobStatus.PENDING },
          // Reclaim jobs whose worker died holding the lease.
          { status: JobStatus.ACTIVE, lockedUntil: { $lt: now } },
        ],
      },
      {
        $set: { status: JobStatus.ACTIVE, lockedUntil: new Date(now.getTime() + visibilityTimeoutMs) },
        $inc: { attempts: 1 },
      },
      { sort: { availableAt: 1 }, new: true },
    ).exec();
  }

  async complete(jobId: unknown): Promise<void> {
    await JobModel.updateOne(
      { _id: jobId },
      { $set: { status: JobStatus.COMPLETED, lockedUntil: null, completedAt: new Date() } },
    ).exec();
  }

  /**
   * Record a failure. If attempts remain the job goes back to PENDING with a
   * backoff delay; otherwise it is parked as FAILED for reconciliation.
   */
  async fail(job: JobDocument, error: unknown, backoffMs: number): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = job.attempts >= job.maxAttempts;

    await JobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: exhausted ? JobStatus.FAILED : JobStatus.PENDING,
          lastError: message.slice(0, 1000),
          lockedUntil: null,
          availableAt: new Date(Date.now() + (exhausted ? 0 : backoffMs)),
          ...(exhausted ? { completedAt: new Date() } : {}),
        },
      },
    ).exec();

    logger.warn(
      { job_id: String(job._id), job_type: job.type, attempts: job.attempts, exhausted },
      exhausted ? 'job failed permanently' : 'job failed; will retry',
    );
  }
}

export const jobQueue = new JobQueue();
