import { AppError } from '../errors/app-error';
import { logger } from '../utils/logger';
import type { ICourierAdapter } from './courier.interface';

/**
 * Registry + factory. Maps the client-facing `courier_partner` value to a
 * singleton adapter instance.
 *
 * Adapters are registered by a *provider function* rather than eagerly
 * constructed, so a courier that is disabled or misconfigured in this
 * environment costs nothing and cannot break boot for the others.
 */
export type CourierProvider = () => ICourierAdapter;

export class CourierRegistry {
  private readonly providers = new Map<string, CourierProvider>();
  private readonly instances = new Map<string, ICourierAdapter>();

  register(name: string, provider: CourierProvider): this {
    const key = normalize(name);
    if (this.providers.has(key)) {
      throw new Error(`Courier "${key}" is already registered.`);
    }
    this.providers.set(key, provider);
    logger.debug({ courier_partner: key }, 'courier adapter registered');
    return this;
  }

  has(name: string): boolean {
    return this.providers.has(normalize(name));
  }

  /** Registered courier keys, sorted for stable API responses and docs. */
  list(): string[] {
    return [...this.providers.keys()].sort();
  }

  /**
   * Resolve an adapter. Throws a client-safe `UNSUPPORTED_COURIER` error that
   * already carries the list of couriers this deployment supports (3.5).
   */
  get(name: string): ICourierAdapter {
    const key = normalize(name);
    const cached = this.instances.get(key);
    if (cached) return cached;

    const provider = this.providers.get(key);
    if (!provider) {
      throw AppError.unsupportedCourier(name, this.list());
    }

    const instance = provider();
    this.instances.set(key, instance);
    return instance;
  }

  /** Test seam: drop memoised instances so config changes take effect. */
  reset(): void {
    this.instances.clear();
  }
}

function normalize(name: string): string {
  return String(name).trim().toLowerCase();
}
