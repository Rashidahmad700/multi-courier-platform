import { ShipmentStatus } from '../../domain/shipment-status';

/**
 * The mock courier speaks its own status vocabulary on purpose — if it reused
 * our unified enum, the status-mapping seam would never be exercised and the
 * "pluggable" claim would be untested.
 */
export const MOCK_STATUS_MAP: Readonly<
  Record<string, { status: ShipmentStatus; description: string }>
> = {
  SHIPMENT_BOOKED: { status: ShipmentStatus.CREATED, description: 'Shipment booked' },
  COLLECTED: { status: ShipmentStatus.PICKED_UP, description: 'Collected from seller' },
  IN_NETWORK: { status: ShipmentStatus.IN_TRANSIT, description: 'Moving through the network' },
  LAST_MILE: { status: ShipmentStatus.OUT_FOR_DELIVERY, description: 'Out with the rider' },
  DELIVERY_DONE: { status: ShipmentStatus.DELIVERED, description: 'Delivered to consignee' },
  DELIVERY_MISSED: { status: ShipmentStatus.UNDELIVERED, description: 'Delivery attempt failed' },
  RETURNING: { status: ShipmentStatus.RTO_IN_TRANSIT, description: 'Returning to origin' },
  RETURNED: { status: ShipmentStatus.RTO_DELIVERED, description: 'Returned to origin' },
  SHIPMENT_VOID: { status: ShipmentStatus.CANCELLED, description: 'Shipment cancelled' },
};

export function mapMockStatus(code: string | undefined | null): ShipmentStatus {
  if (!code) return ShipmentStatus.UNKNOWN;
  return MOCK_STATUS_MAP[code]?.status ?? ShipmentStatus.UNKNOWN;
}
