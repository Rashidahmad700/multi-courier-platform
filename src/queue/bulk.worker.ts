import { config } from '../config';
import { BULK_JOB_TYPE, type BulkJobPayload, type BulkService } from '../services/bulk.service';
import { computeBackoffDelay } from '../utils/retry';
import { logFailure, logger } from '../utils/logger';
import { jobQueue, type JobQueue } from './job.queue';

/**
 * Polling worker for the MongoDB-backed queue.
 *
 * Runs either inside the API process (dev/demo, `RUN_WORKER_IN_API_PROCESS=true`)
 * or as its own process (`npm run start:worker`). Multiple instances are safe:
 * job claiming is a single atomic `findOneAndUpdate`.
 */
export class BulkWorker {
  private running = false;
  private loop: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly bulkService: BulkService,
    private readonly queue: JobQueue = jobQueue,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    logger.info({ poll_interval_ms: config.bulk.pollIntervalMs }, 'bulk worker started');
  }

  /** Resolves once the in-flight job (if any) has finished. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.loop;
    this.loop = null;
    logger.info('bulk worker stopped');
  }

  /**
   * Drain every currently-due job and return. Used by tests so they never have
   * to sleep on the poll interval.
   */
  async drain(maxJobs = 100): Promise<number> {
    let processed = 0;
    while (processed < maxJobs) {
      const claimed = await this.tick();
      if (!claimed) break;
      processed += 1;
    }
    return processed;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = false;
      try {
        claimed = await this.tick();
      } catch (error) {
        logFailure({ error_type: 'WORKER_LOOP_ERROR' }, error, 'bulk worker loop error');
      }
      // Back off only when idle; keep draining while work exists.
      if (!claimed) await this.sleep(config.bulk.pollIntervalMs);
    }
  }

  /** Claim and process at most one job. Returns true if a job was claimed. */
  private async tick(): Promise<boolean> {
    const job = await this.queue.claim(BULK_JOB_TYPE, config.bulk.visibilityTimeoutMs);
    if (!job) return false;

    const payload = job.payload as BulkJobPayload;
    try {
      await this.bulkService.processBatch(payload);
      await this.queue.complete(job._id);
    } catch (error) {
      logFailure(
        {
          batch_id: payload?.batchId,
          request_id: payload?.requestId,
          error_type: 'BULK_JOB_FAILED',
        },
        error,
        'bulk job failed',
      );
      await this.queue.fail(job, error, computeBackoffDelay(job.attempts, config.courierDefaults.retry));
    }
    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
      this.timer.unref?.();
    });
  }
}
