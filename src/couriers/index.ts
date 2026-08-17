import { config } from '../config';
import { CourierRegistry } from './courier.registry';
import { createMockCourierAdapter } from './mock/mock.adapter';
import { createUrbaneBoltAdapter } from './urbanebolt/urbanebolt.adapter';

/**
 * THE ONLY FILE THAT KNOWS WHICH COURIERS EXIST.
 *
 * To add a courier:
 *   1. create `src/couriers/<name>/` implementing ICourierAdapter,
 *   2. add its settings block to `src/config/index.ts` + `.env.example`,
 *   3. add one `registry.register(...)` line below.
 *
 * Controllers, routes, DTOs, services and existing adapters stay untouched.
 */
export function buildCourierRegistry(): CourierRegistry {
  const registry = new CourierRegistry();

  if (config.couriers.urbanebolt.enabled) {
    registry.register('urbanebolt', () =>
      createUrbaneBoltAdapter({
        baseUrl: config.couriers.urbanebolt.baseUrl,
        username: config.couriers.urbanebolt.username,
        password: config.couriers.urbanebolt.password,
        customerCode: config.couriers.urbanebolt.customerCode,
        defaultServiceType: config.couriers.urbanebolt.defaultServiceType,
        tokenRefreshSkewSeconds: config.couriers.urbanebolt.tokenRefreshSkewSeconds,
        timeoutMs: config.courierDefaults.timeoutMs,
        retry: config.courierDefaults.retry,
      }),
    );
  }

  if (config.couriers.mock.enabled) {
    registry.register('mock', () =>
      createMockCourierAdapter({
        latencyMs: config.couriers.mock.latencyMs,
        failPincode: config.couriers.mock.failPincode,
      }),
    );
  }

  return registry;
}

/** Process-wide registry. Adapters are lazily constructed on first use. */
export const courierRegistry = buildCourierRegistry();

export { CourierRegistry } from './courier.registry';
export type { ICourierAdapter } from './courier.interface';
