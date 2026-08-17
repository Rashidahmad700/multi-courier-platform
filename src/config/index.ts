import 'dotenv/config';
import { z } from 'zod';

/**
 * Every tunable — credentials, base URLs, timeouts, retry counts, concurrency —
 * is read from the environment exactly once, here, and validated at boot.
 * Nothing else in the codebase is allowed to touch `process.env`.
 */

const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .refine((v) => ['true', 'false', '1', '0', 'yes', 'no'].includes(v), {
    message: 'must be a boolean-ish value (true/false/1/0/yes/no)',
  })
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB_NAME: z.string().min(1).optional(),

  // ---- Bulk / queue -------------------------------------------------------
  BULK_MAX_ORDERS: z.coerce.number().int().positive().max(1000).default(100),
  BULK_WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(10),
  BULK_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  BULK_JOB_VISIBILITY_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  BULK_JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // When true the API process also runs the queue worker in-process. Convenient
  // for local dev and for the graded demo; in production run `npm run start:worker`
  // as a separate process so a slow courier cannot starve the HTTP event loop.
  RUN_WORKER_IN_API_PROCESS: booleanish.default('true'),

  // ---- Courier: shared retry defaults -------------------------------------
  COURIER_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  COURIER_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  COURIER_RETRY_BASE_DELAY_MS: z.coerce.number().int().nonnegative().default(300),
  COURIER_RETRY_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(5_000),
  COURIER_RETRY_JITTER: booleanish.default('true'),

  // ---- Courier: UrbaneBolt ------------------------------------------------
  URBANEBOLT_ENABLED: booleanish.default('true'),
  URBANEBOLT_BASE_URL: z.string().url().optional(),
  URBANEBOLT_USERNAME: z.string().optional(),
  URBANEBOLT_PASSWORD: z.string().optional(),
  URBANEBOLT_CUSTOMER_CODE: z.string().optional(),
  URBANEBOLT_DEFAULT_SERVICE_TYPE: z.string().default('SDD'),
  // The token endpoint returns `expires_in` (seconds); we refresh this many
  // seconds before that to avoid racing the courier's own clock.
  URBANEBOLT_TOKEN_REFRESH_SKEW_S: z.coerce.number().int().nonnegative().default(300),

  // ---- Courier: Mock (bonus adapter, proves pluggability) -----------------
  MOCK_COURIER_ENABLED: booleanish.default('true'),
  MOCK_COURIER_LATENCY_MS: z.coerce.number().int().nonnegative().default(0),
  MOCK_COURIER_FAIL_PINCODE: z.string().default('000000'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return parsed.data;
}

const env = loadEnv();

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export const config = {
  env: env.NODE_ENV,
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  logLevel: env.LOG_LEVEL,

  mongo: {
    uri: env.MONGODB_URI,
    dbName: env.MONGODB_DB_NAME,
  },

  bulk: {
    maxOrders: env.BULK_MAX_ORDERS,
    workerConcurrency: env.BULK_WORKER_CONCURRENCY,
    pollIntervalMs: env.BULK_WORKER_POLL_INTERVAL_MS,
    visibilityTimeoutMs: env.BULK_JOB_VISIBILITY_TIMEOUT_MS,
    maxAttempts: env.BULK_JOB_MAX_ATTEMPTS,
    runWorkerInApiProcess: env.RUN_WORKER_IN_API_PROCESS,
  },

  courierDefaults: {
    timeoutMs: env.COURIER_HTTP_TIMEOUT_MS,
    retry: {
      maxAttempts: env.COURIER_RETRY_MAX_ATTEMPTS,
      baseDelayMs: env.COURIER_RETRY_BASE_DELAY_MS,
      maxDelayMs: env.COURIER_RETRY_MAX_DELAY_MS,
      jitter: env.COURIER_RETRY_JITTER,
    } satisfies RetryConfig,
  },

  couriers: {
    urbanebolt: {
      enabled: env.URBANEBOLT_ENABLED,
      baseUrl: env.URBANEBOLT_BASE_URL,
      username: env.URBANEBOLT_USERNAME,
      password: env.URBANEBOLT_PASSWORD,
      customerCode: env.URBANEBOLT_CUSTOMER_CODE,
      defaultServiceType: env.URBANEBOLT_DEFAULT_SERVICE_TYPE,
      tokenRefreshSkewSeconds: env.URBANEBOLT_TOKEN_REFRESH_SKEW_S,
    },
    mock: {
      enabled: env.MOCK_COURIER_ENABLED,
      latencyMs: env.MOCK_COURIER_LATENCY_MS,
      failPincode: env.MOCK_COURIER_FAIL_PINCODE,
    },
  },
} as const;

export type AppConfig = typeof config;
