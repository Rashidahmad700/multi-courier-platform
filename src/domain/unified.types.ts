import type { ShipmentStatus } from './shipment-status';

/**
 * The normalized, courier-agnostic domain model. Adapters translate to and from
 * these shapes; nothing above the adapter layer ever sees a courier's own
 * field names.
 */

export type PayMode = 'PREPAID' | 'COD';

export interface Address {
  name: string;
  /** Free-form single-line or multi-line street address. */
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  phone: string;
  email?: string;
  /** e.g. "Home", "Office", "Seller". Couriers use this for delivery routing hints. */
  addressType?: string;
}

export interface PackageDimensions {
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  weightKg: number;
}

export interface OrderItem {
  description: string;
  quantity: number;
  /** Per-unit declared value in the order currency. */
  value: number;
  sku?: string;
  hsnCode?: string;
}

export interface UnifiedShipmentRequest {
  /** Client-supplied idempotency key and business identifier. */
  orderId: string;
  paymentMode: PayMode;
  /** Amount to collect on delivery. Must be 0 for PREPAID. */
  codAmount: number;
  declaredValue: number;
  currency: string;
  pickup: Address;
  delivery: Address;
  /** Where the shipment goes if delivery fails. Defaults to `pickup`. */
  returnAddress: Address;
  dimensions: PackageDimensions;
  pieces: number;
  items: OrderItem[];
  invoiceNumber?: string;
  /** ISO date (YYYY-MM-DD). */
  invoiceDate?: string;
  /** Courier service tier, e.g. "SDD"/"NDD". Adapter falls back to its configured default. */
  serviceType?: string;
}

export interface UnifiedShipmentResponse {
  /** The courier's own order reference, when it issues one distinct from the AWB. */
  courierOrderId?: string;
  /** Tracking number. */
  awbNumber: string;
  status: ShipmentStatus;
  labelUrl?: string;
  routeCode?: string;
  estimatedDeliveryDate?: string;
}

export interface UnifiedTrackingEvent {
  status: ShipmentStatus;
  /** The courier's own status code, preserved verbatim. */
  courierStatusCode: string;
  description: string;
  location?: string;
  occurredAt: Date;
  reasonCode?: string;
  reasonDescription?: string;
}

export interface UnifiedTrackingResponse {
  awbNumber: string;
  courierOrderId?: string;
  currentStatus: ShipmentStatus;
  courierStatusCode: string;
  statusDescription: string;
  currentLocation?: string;
  estimatedDeliveryDate?: string;
  /** Ordered oldest-first. */
  events: UnifiedTrackingEvent[];
}

export interface UnifiedCancelResponse {
  awbNumber: string;
  cancelled: boolean;
  /** Human-readable courier message, already normalized (never a raw error blob). */
  message: string;
}

export interface UnifiedServiceabilityRequest {
  pickupPincode: string;
  deliveryPincode: string;
}

export interface UnifiedServiceabilityResponse {
  serviceable: boolean;
  /** Service tiers available on this lane, e.g. ["SDD","NDD"]. */
  availableServiceTypes: string[];
  reason?: string;
}

/**
 * Every adapter call returns the parsed result alongside the exact bytes we
 * sent and received, so the service layer can persist a full audit trail
 * without knowing anything about the courier's wire format (requirement 3.3).
 */
export interface CourierCallAudit {
  endpoint: string;
  method: string;
  requestPayload: unknown;
  responsePayload: unknown;
  httpStatus?: number;
  durationMs: number;
}

export interface AdapterResult<T> {
  data: T;
  audit: CourierCallAudit;
}
