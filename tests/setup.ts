/**
 * Runs before any test module is imported, so `src/config` (which validates the
 * environment at import time) always sees a complete, test-safe configuration.
 *
 * No real credentials appear here: the integration tests use the in-process
 * mock courier, and the UrbaneBolt adapter is disabled for the suite.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/multi_courier_test';
process.env.URBANEBOLT_ENABLED = 'false';
process.env.MOCK_COURIER_ENABLED = 'true';
process.env.MOCK_COURIER_FAIL_PINCODE = '000000';
process.env.RUN_WORKER_IN_API_PROCESS = 'false';
process.env.BULK_WORKER_CONCURRENCY ??= '10';
process.env.COURIER_RETRY_BASE_DELAY_MS = '1';
process.env.COURIER_RETRY_MAX_DELAY_MS = '2';
