import { AppError } from '../../errors/app-error';
import { ErrorCode } from '../../errors/error-codes';
import { ShipmentStatus } from '../../domain/shipment-status';
import type {
  Address,
  UnifiedCancelResponse,
  UnifiedServiceabilityResponse,
  UnifiedShipmentRequest,
  UnifiedShipmentResponse,
  UnifiedTrackingEvent,
  UnifiedTrackingResponse,
} from '../../domain/unified.types';
import { mapUrbaneBoltStatus } from './urbanebolt.status';
import type {
  UrbaneBoltCancelResponse,
  UrbaneBoltManifestItem,
  UrbaneBoltManifestResponse,
  UrbaneBoltPincodeResponse,
  UrbaneBoltScan,
  UrbaneBoltTrackingData,
  UrbaneBoltTrackingResponse,
} from './urbanebolt.types';

/**
 * Pure translation between our unified domain model and UrbaneBolt's wire
 * format. No HTTP, no persistence, no config lookups beyond what is passed in —
 * which is what makes it directly unit-testable.
 */

export interface MapperContext {
  customerCode: string;
  defaultServiceType: string;
}

// ---------------------------------------------------------------------------
// Outbound: unified -> UrbaneBolt
// ---------------------------------------------------------------------------

export function toManifestItem(
  order: UnifiedShipmentRequest,
  ctx: MapperContext,
): UrbaneBoltManifestItem {
  const totalQuantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const itemDescription = order.items.map((item) => item.description).join(', ').slice(0, 250);

  return {
    customerCode: ctx.customerCode,
    orderNumber: order.orderId,
    declaredValue: order.declaredValue,
    itemDescription,
    // UrbaneBolt reads the amount to collect from `collectableValue`; it must be
    // zero for prepaid or the courier will try to collect cash.
    collectableValue: order.paymentMode === 'COD' ? order.codAmount : 0,
    height: order.dimensions.heightCm,
    length: order.dimensions.lengthCm,
    breadth: order.dimensions.breadthCm,
    weight: order.dimensions.weightKg,
    pieces: order.pieces,
    serviceType: order.serviceType ?? ctx.defaultServiceType,
    payMode: order.paymentMode === 'COD' ? 'COD' : 'PPD',

    ...prefixAddress('shpr', order.pickup),
    ...prefixAddress('cons', order.delivery),
    ...prefixAddress('rtn', order.returnAddress),

    invoiceNumber: order.invoiceNumber ?? order.orderId,
    invoiceDate: order.invoiceDate ?? todayIso(),
    invoiceValue: order.declaredValue,
    itemQuantity: totalQuantity,
  };
}

type AddressPrefix = 'shpr' | 'cons' | 'rtn';

/**
 * The nine prefixed fields UrbaneBolt expects per address block. Typing them as
 * a mapped type (rather than `Record<string, unknown>`) is what lets the
 * compiler still verify that `toManifestItem` produces a complete
 * `UrbaneBoltManifestItem` after the spread.
 */
type AddressBlock<P extends AddressPrefix> = Record<
  `${P}Name` | `${P}Address` | `${P}AddressType` | `${P}City` | `${P}State` | `${P}Country` | `${P}Email`,
  string
> &
  Record<`${P}Pincode` | `${P}Mobile`, number>;

/**
 * UrbaneBolt repeats the same nine address fields three times with a prefix.
 * Building them programmatically keeps the three blocks provably identical.
 */
function prefixAddress<P extends AddressPrefix>(prefix: P, address: Address): AddressBlock<P> {
  return {
    [`${prefix}Name`]: address.name,
    [`${prefix}Address`]: address.addressLine,
    [`${prefix}AddressType`]: address.addressType ?? (prefix === 'cons' ? 'Home' : 'Seller'),
    [`${prefix}City`]: address.city,
    [`${prefix}State`]: address.state,
    [`${prefix}Country`]: address.country,
    // Pincode and mobile go over the wire as numbers, per the published collection.
    [`${prefix}Pincode`]: toNumeric(address.pincode, `${prefix}Pincode`),
    [`${prefix}Mobile`]: toNumeric(address.phone, `${prefix}Mobile`),
    [`${prefix}Email`]: address.email ?? '',
    // The computed keys above are provably exhaustive for AddressBlock<P>, but
    // TypeScript cannot infer that from a template-literal object literal.
  } as AddressBlock<P>;
}

function toNumeric(value: string, field: string): number {
  const digits = value.replace(/\D/g, '');
  const parsed = Number(digits);
  if (!digits || Number.isNaN(parsed)) {
    throw AppError.validation(`Field "${field}" must contain digits.`, [
      { field, message: `"${value}" is not a numeric value` },
    ]);
  }
  return parsed;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Inbound: UrbaneBolt -> unified
// ---------------------------------------------------------------------------

/**
 * UrbaneBolt returns HTTP 200 for rejected items, reporting them in
 * `errorResponse`. We surface that as a real, non-retryable error.
 */
export function fromManifestResponse(
  response: UrbaneBoltManifestResponse,
  orderId: string,
): UnifiedShipmentResponse {
  const failure = (response.errorResponse ?? []).find(
    (entry) => !entry.orderNumber || entry.orderNumber === orderId,
  );
  if (failure) {
    const { code, message } = classifyManifestFailure(failure.message);
    // The courier's own wording stays in `raw` (logged + persisted) and never
    // reaches the client; the client gets our normalized message.
    throw new AppError(code, message.replace('{orderId}', orderId), {
      raw: response,
      retryable: false,
    });
  }

  const success = (response.successResponse ?? []).find(
    (entry) => !entry.orderNumber || entry.orderNumber === orderId,
  );
  if (!success?.awbNumber) {
    throw new AppError(
      ErrorCode.COURIER_BAD_RESPONSE,
      `Courier accepted order "${orderId}" but returned no AWB number.`,
      { raw: response, retryable: false },
    );
  }

  return {
    courierOrderId: success.orderNumber,
    awbNumber: String(success.awbNumber),
    status: ShipmentStatus.CREATED,
    ...(success.shippingLabel ? { labelUrl: success.shippingLabel } : {}),
    ...(success.routeCode ? { routeCode: success.routeCode } : {}),
  };
}

/**
 * Translate UrbaneBolt's free-text rejection reason into one of our own error
 * codes plus our own wording. Unrecognised text degrades to a generic
 * COURIER_REJECTED — never to the courier's raw string.
 */
function classifyManifestFailure(courierMessage: string | undefined): {
  code: ErrorCode;
  message: string;
} {
  const text = (courierMessage ?? '').toLowerCase();

  if (/already\s+ship|duplicate|already\s+exist/.test(text)) {
    return {
      code: ErrorCode.DUPLICATE_ORDER,
      message: 'Order "{orderId}" already has a shipment at this courier.',
    };
  }
  if (/pincode|serviceab|not\s+served|no\s+route/.test(text)) {
    return {
      code: ErrorCode.COURIER_NOT_SERVICEABLE,
      message: 'The courier does not service this pickup/delivery lane.',
    };
  }
  if (/customer\s*code|account|not\s+authori/.test(text)) {
    return {
      code: ErrorCode.COURIER_AUTH_FAILED,
      message: 'The configured courier account is not permitted to create this shipment.',
    };
  }
  return {
    code: ErrorCode.COURIER_REJECTED,
    message: 'The courier rejected order "{orderId}". See server logs for the courier detail.',
  };
}

export function fromTrackingResponse(
  response: UrbaneBoltTrackingResponse,
  awbNumber: string,
): UnifiedTrackingResponse {
  const data = response.data;
  // "Data Not Found" comes back as HTTP 200 with status "Failed" and data: [].
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    throw AppError.notFound(`Shipment "${awbNumber}" at courier`);
  }

  const tracking = data as UrbaneBoltTrackingData;
  const events = (tracking.scans ?? [])
    .map(toTrackingEvent)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  return {
    awbNumber: String(tracking.awbNumber ?? awbNumber),
    ...(tracking.orderNumber ? { courierOrderId: tracking.orderNumber } : {}),
    currentStatus: mapUrbaneBoltStatus(tracking.currentStatusCode),
    courierStatusCode: tracking.currentStatusCode ?? '',
    statusDescription: tracking.currentStatusCodeDescription ?? '',
    ...(tracking.currentLocation ? { currentLocation: tracking.currentLocation } : {}),
    ...(tracking.edd ? { estimatedDeliveryDate: tracking.edd } : {}),
    events,
  };
}

function toTrackingEvent(scan: UrbaneBoltScan): UnifiedTrackingEvent {
  return {
    status: mapUrbaneBoltStatus(scan.statusCode),
    courierStatusCode: scan.statusCode ?? '',
    description: scan.statusCodeDescription ?? '',
    ...(scan.currentLocation ? { location: scan.currentLocation } : {}),
    occurredAt: parseUrbaneBoltDateTime(scan.statusDateTime),
    ...(scan.reasonCode ? { reasonCode: scan.reasonCode } : {}),
    ...(scan.reasonCodeDescription ? { reasonDescription: scan.reasonCodeDescription } : {}),
  };
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * UrbaneBolt timestamps look like "17 Aug 2026, 21:41" — no timezone, no
 * offset. `new Date(...)` parses this inconsistently across engines, so we
 * parse it explicitly and treat it as IST (Asia/Kolkata, UTC+5:30), which is
 * the operating timezone of the network. Unparseable values fall back to
 * "now" rather than producing an Invalid Date that would poison sorting.
 */
export function parseUrbaneBoltDateTime(value: string | undefined | null): Date {
  if (!value) return new Date();
  const match = /^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?/.exec(value.trim());
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
  }
  const [, day, monthName, year, hour = '0', minute = '0'] = match;
  const month = MONTHS[monthName!.toLowerCase()];
  if (month === undefined) return new Date();

  const IST_OFFSET_MINUTES = 330;
  const utcMillis = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute));
  return new Date(utcMillis - IST_OFFSET_MINUTES * 60_000);
}

export function fromCancelResponse(
  response: UrbaneBoltCancelResponse,
  awbNumber: string,
): UnifiedCancelResponse {
  const success = (response.successResponse ?? []).find(
    (entry) => !entry.awb || String(entry.awb) === awbNumber,
  );
  if (success) {
    return { awbNumber, cancelled: true, message: 'Shipment cancelled at the courier.' };
  }

  const failure = (response.failureResponse ?? []).find(
    (entry) => !entry.awb || String(entry.awb) === awbNumber,
  );
  const courierText = (failure?.message ?? '').toLowerCase();

  // "Shipment already cancelled!" is the courier being idempotent, not a
  // failure — treat it as a successful (no-op) cancellation.
  if (/already\s+cancel/.test(courierText)) {
    return { awbNumber, cancelled: true, message: 'Shipment was already cancelled.' };
  }

  const message = /picked|transit|deliver|out\s+for/.test(courierText)
    ? `AWB "${awbNumber}" has already moved past pickup and can no longer be cancelled.`
    : `The courier refused to cancel AWB "${awbNumber}". See server logs for the courier detail.`;

  throw new AppError(
    /picked|transit|deliver|out\s+for/.test(courierText)
      ? ErrorCode.INVALID_STATE
      : ErrorCode.COURIER_REJECTED,
    message,
    { raw: response, retryable: false },
  );
}

export function fromPincodeResponse(
  response: UrbaneBoltPincodeResponse,
  pickupPincode: string,
  deliveryPincode: string,
): UnifiedServiceabilityResponse {
  const entries = response.data ?? [];
  const pickup = entries.find((entry) => String(entry.pincode) === pickupPincode);
  const delivery = entries.find((entry) => String(entry.pincode) === deliveryPincode);

  if (!pickup || !pickup.isActive || !pickup.outbound) {
    return {
      serviceable: false,
      availableServiceTypes: [],
      reason: `Pickup pincode ${pickupPincode} is not serviceable for outbound shipments.`,
    };
  }
  if (!delivery || !delivery.isActive || !delivery.inbound) {
    return {
      serviceable: false,
      availableServiceTypes: [],
      reason: `Delivery pincode ${deliveryPincode} is not serviceable for inbound shipments.`,
    };
  }

  // A lane supports only the tiers both ends support.
  const pickupTypes = splitServiceTypes(pickup.serviceType);
  const deliveryTypes = new Set(splitServiceTypes(delivery.serviceType));
  const shared = pickupTypes.filter((type) => deliveryTypes.has(type));

  return shared.length > 0
    ? { serviceable: true, availableServiceTypes: shared }
    : {
        serviceable: false,
        availableServiceTypes: [],
        reason: 'No common service type between the pickup and delivery pincodes.',
      };
}

function splitServiceTypes(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((type) => type.trim().toUpperCase())
    .filter(Boolean);
}
