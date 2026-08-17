/**
 * The unified shipment lifecycle. Courier-specific status codes are mapped onto
 * this enum by each adapter; anything a courier sends that we do not recognise
 * becomes `UNKNOWN` — it is still persisted with its raw code so nothing is
 * silently dropped (requirement 3.3).
 */
export const ShipmentStatus = {
  /** Accepted by us, not yet handed to the courier (bulk jobs start here). */
  PENDING: 'PENDING',
  /** Courier accepted the shipment and issued an AWB. */
  CREATED: 'CREATED',
  PICKED_UP: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  /** Delivery attempted and failed; may be re-attempted or turn into RTO. */
  UNDELIVERED: 'UNDELIVERED',
  RTO_IN_TRANSIT: 'RTO_IN_TRANSIT',
  RTO_DELIVERED: 'RTO_DELIVERED',
  CANCELLED: 'CANCELLED',
  /** We could not get the shipment created at the courier at all. */
  FAILED: 'FAILED',
  /** Courier reported a status code we have no mapping for. */
  UNKNOWN: 'UNKNOWN',
} as const;

export type ShipmentStatus = (typeof ShipmentStatus)[keyof typeof ShipmentStatus];

export const SHIPMENT_STATUSES = Object.values(ShipmentStatus) as ShipmentStatus[];

/** Statuses past which a cancellation request is pointless. */
const NON_CANCELLABLE: ReadonlySet<ShipmentStatus> = new Set<ShipmentStatus>([
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RTO_DELIVERED,
  ShipmentStatus.CANCELLED,
]);

export function isCancellable(status: ShipmentStatus): boolean {
  return !NON_CANCELLABLE.has(status);
}

/** Terminal states — no further courier updates are expected. */
export function isTerminal(status: ShipmentStatus): boolean {
  return (
    status === ShipmentStatus.DELIVERED ||
    status === ShipmentStatus.RTO_DELIVERED ||
    status === ShipmentStatus.CANCELLED ||
    status === ShipmentStatus.FAILED
  );
}
