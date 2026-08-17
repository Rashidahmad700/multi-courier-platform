import type {
  AdapterResult,
  UnifiedCancelResponse,
  UnifiedServiceabilityRequest,
  UnifiedServiceabilityResponse,
  UnifiedShipmentRequest,
  UnifiedShipmentResponse,
  UnifiedTrackingResponse,
} from '../domain/unified.types';

/** Per-call context threaded through for logging and correlation. */
export interface CourierCallContext {
  requestId: string;
  orderId?: string;
}

/**
 * The contract every courier integration implements. This is the *only* seam
 * between the platform and a courier: services, controllers and DTOs are
 * written against this interface and never against a specific courier.
 *
 * Adding a courier = implement this interface in its own folder + register it
 * once. Nothing else changes (requirement 3.2).
 */
export interface ICourierAdapter {
  /** Registry key, matching the `courier_partner` value clients send. */
  readonly name: string;

  /**
   * Optional capabilities are declared rather than assumed, so the service
   * layer can answer "this courier does not do serviceability checks" with a
   * clean 4xx instead of a crash.
   */
  readonly capabilities: CourierCapabilities;

  /** Create a shipment and obtain an AWB. */
  createShipment(
    request: UnifiedShipmentRequest,
    context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedShipmentResponse>>;

  /** Fetch current status plus full scan history for an AWB. */
  trackShipment(
    awbNumber: string,
    context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedTrackingResponse>>;

  /** Cancel a shipment before pickup. */
  cancelShipment(
    awbNumber: string,
    context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedCancelResponse>>;

  /**
   * Check whether a pickup → delivery lane is serviceable. Present only when
   * `capabilities.serviceability` is true.
   */
  checkServiceability?(
    request: UnifiedServiceabilityRequest,
    context: CourierCallContext,
  ): Promise<AdapterResult<UnifiedServiceabilityResponse>>;
}

export interface CourierCapabilities {
  serviceability: boolean;
  /** True when the courier returns a printable label URL on creation. */
  shippingLabel: boolean;
  /** True when cancellation is supported at all. */
  cancellation: boolean;
}

/** Method names on ICourierAdapter that perform a courier round-trip. */
export type CourierOperation =
  | 'createShipment'
  | 'trackShipment'
  | 'cancelShipment'
  | 'checkServiceability';
