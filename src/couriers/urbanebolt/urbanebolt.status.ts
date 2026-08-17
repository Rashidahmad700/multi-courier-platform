import { ShipmentStatus } from '../../domain/shipment-status';

/**
 * UrbaneBolt status code -> unified status.
 *
 * The codes below were harvested from live UAT tracking responses rather than
 * invented; the description is UrbaneBolt's own `statusCodeDescription`.
 * Anything not listed maps to UNKNOWN and is still persisted with its raw code
 * and description, so a new courier status never disappears silently.
 */
export const URBANEBOLT_STATUS_MAP: Readonly<Record<string, ShipmentStatus>> = {
  MAN: ShipmentStatus.CREATED, // Shipment Manifested
  PKA: ShipmentStatus.CREATED, // Pickup Assigned - rider allocated, parcel not yet collected
  PKD: ShipmentStatus.PICKED_UP, // Picked Up
  RDC: ShipmentStatus.IN_TRANSIT, // Reached at DC
  DDS: ShipmentStatus.IN_TRANSIT, // Delivery Scheduled
  OFD: ShipmentStatus.OUT_FOR_DELIVERY, // Out for Delivery
  DDL: ShipmentStatus.DELIVERED, // Delivered
  UND: ShipmentStatus.UNDELIVERED, // Undelivered / NDR
  RTL: ShipmentStatus.RTO_IN_TRANSIT, // RTO Lock
  RTO: ShipmentStatus.RTO_IN_TRANSIT, // RTO in transit
  RTD: ShipmentStatus.RTO_DELIVERED, // RTO Delivered
  CAN: ShipmentStatus.CANCELLED, // Cancelled
};

export function mapUrbaneBoltStatus(code: string | undefined | null): ShipmentStatus {
  if (!code) return ShipmentStatus.UNKNOWN;
  return URBANEBOLT_STATUS_MAP[code.trim().toUpperCase()] ?? ShipmentStatus.UNKNOWN;
}
