import { describe, expect, it } from 'vitest';
import { ShipmentStatus } from '../../src/domain/shipment-status';
import type { UnifiedShipmentRequest } from '../../src/domain/unified.types';
import { ErrorCode } from '../../src/errors/error-codes';
import {
  fromCancelResponse,
  fromManifestResponse,
  fromPincodeResponse,
  fromTrackingResponse,
  parseUrbaneBoltDateTime,
  toManifestItem,
} from '../../src/couriers/urbanebolt/urbanebolt.mapper';

/**
 * Every UrbaneBolt payload asserted here is a verbatim capture from a live call
 * to https://uat.urbanebolt.in (see docs/urbanebolt-uat-samples.md), not an
 * invented shape — so this suite fails if the mapper drifts from the real API.
 */

const ctx = { customerCode: 'UEBCUS0008', defaultServiceType: 'SDD' };

const unifiedOrder: UnifiedShipmentRequest = {
  orderId: 'EASE1786983073',
  paymentMode: 'COD',
  codAmount: 1,
  declaredValue: 100,
  currency: 'INR',
  pieces: 1,
  pickup: {
    name: 'Rohit Athaley',
    addressLine: 'HOLY FAITH INTERNATIONAL P LTD, Plot 137-138',
    city: 'Govindpura',
    state: 'BHOPAL',
    pincode: '122001',
    country: 'INDIA',
    phone: '9425018023',
    email: 'bhopal@mbdgroup.com',
    addressType: 'Seller',
  },
  delivery: {
    name: 'Satyam Convent School',
    addressLine: 'Plot No. 26-27, Om Nagar Society, Sumbhal',
    city: 'Surat',
    state: 'GUJRAT',
    pincode: '122017',
    country: 'INDIA',
    phone: '8320226438',
    email: 'TEST2@AIL.COM',
    addressType: 'Home',
  },
  returnAddress: {
    name: 'Rohit Athaley',
    addressLine: 'HOLY FAITH INTERNATIONAL P LTD, Plot 137-138',
    city: 'Govindpura',
    state: 'BHOPAL',
    pincode: '122017',
    country: 'INDIA',
    phone: '9425018023',
    email: 'bhopal@mbdgroup.com',
    addressType: 'Seller',
  },
  dimensions: { lengthCm: 12, breadthCm: 10, heightCm: 10, weightKg: 1.1 },
  items: [
    { description: 'BOOKS', quantity: 1, value: 100 },
    { description: 'PENS', quantity: 2, value: 5 },
  ],
  invoiceNumber: 'INV0002',
  invoiceDate: '2024-10-02',
};

describe('toManifestItem', () => {
  const item = toManifestItem(unifiedOrder, ctx);

  it('emits UrbaneBolt field names, not our domain names', () => {
    expect(item).toMatchObject({
      customerCode: 'UEBCUS0008',
      orderNumber: 'EASE1786983073',
      declaredValue: 100,
      length: 12,
      breadth: 10,
      height: 10,
      weight: 1.1,
      pieces: 1,
      serviceType: 'SDD',
      payMode: 'COD',
    });
  });

  it('maps pickup -> shpr*, delivery -> cons*, return -> rtn*', () => {
    expect(item.shprName).toBe('Rohit Athaley');
    expect(item.shprCity).toBe('Govindpura');
    expect(item.consName).toBe('Satyam Convent School');
    expect(item.consCity).toBe('Surat');
    expect(item.rtnName).toBe('Rohit Athaley');
    expect(item.rtnPincode).toBe(122017);
  });

  it('sends pincodes and mobiles as numbers, as the live API expects', () => {
    expect(item.shprPincode).toBe(122001);
    expect(item.consPincode).toBe(122017);
    expect(item.shprMobile).toBe(9425018023);
    expect(item.consMobile).toBe(8320226438);
  });

  it('strips formatting from phone numbers before converting to a number', () => {
    const formatted = toManifestItem(
      { ...unifiedOrder, pickup: { ...unifiedOrder.pickup, phone: '+91 94250-18023' } },
      ctx,
    );
    expect(formatted.shprMobile).toBe(919425018023);
  });

  it('puts the COD amount in collectableValue for COD orders', () => {
    expect(item.collectableValue).toBe(1);
  });

  it('zeroes collectableValue for prepaid orders so no cash is collected', () => {
    const prepaid = toManifestItem(
      { ...unifiedOrder, paymentMode: 'PREPAID', codAmount: 0 },
      ctx,
    );
    expect(prepaid.payMode).toBe('PPD');
    expect(prepaid.collectableValue).toBe(0);
  });

  it('flattens line items into a description and a total quantity', () => {
    expect(item.itemDescription).toBe('BOOKS, PENS');
    expect(item.itemQuantity).toBe(3);
  });

  it('falls back to the configured service type when the caller omits one', () => {
    expect(toManifestItem({ ...unifiedOrder, serviceType: undefined }, ctx).serviceType).toBe('SDD');
    expect(toManifestItem({ ...unifiedOrder, serviceType: 'NDD' }, ctx).serviceType).toBe('NDD');
  });

  it('rejects a non-numeric pincode with a field-level validation error', () => {
    expect(() =>
      toManifestItem(
        { ...unifiedOrder, delivery: { ...unifiedOrder.delivery, pincode: 'ABCDEF' } },
        ctx,
      ),
    ).toThrowError(/consPincode/);
  });
});

describe('fromManifestResponse', () => {
  // Verbatim live UAT response.
  const successBody = {
    status: 'Success',
    successResponse: [
      {
        status: 'Success',
        orderNumber: 'EASE1786983073',
        awbNumber: 200000007359,
        routeCode: 'GGN/DLHH',
        shippingLabel: 'https://api.uat.urbanebolt.in/api/v1/services/print-label/?key=<redacted-label-key>',
        customerCode: 'UEBCUS0008',
      },
    ],
    errorResponse: [],
  };

  it('extracts the AWB as a string and marks the shipment CREATED', () => {
    expect(fromManifestResponse(successBody, 'EASE1786983073')).toEqual({
      courierOrderId: 'EASE1786983073',
      awbNumber: '200000007359',
      status: ShipmentStatus.CREATED,
      labelUrl: 'https://api.uat.urbanebolt.in/api/v1/services/print-label/?key=<redacted-label-key>',
      routeCode: 'GGN/DLHH',
    });
  });

  it('turns a per-item errorResponse into a real error despite the HTTP 200', () => {
    // Verbatim live UAT response for a re-submitted orderNumber.
    const duplicateBody = {
      status: 'Success',
      successResponse: [],
      errorResponse: [
        {
          orderNumber: 'EASE1786983073',
          customerCode: 'UEBCUS0008',
          status: 'Failed',
          message: 'orderNumber already shipped!',
        },
      ],
    };

    expect(() => fromManifestResponse(duplicateBody, 'EASE1786983073')).toThrowError(
      expect.objectContaining({ code: ErrorCode.DUPLICATE_ORDER }),
    );
  });

  it('never leaks the courier wording into the client-facing message', () => {
    const body = {
      status: 'Success',
      successResponse: [],
      errorResponse: [{ orderNumber: 'X1', status: 'Failed', message: 'internal db constraint 4711' }],
    };

    try {
      fromManifestResponse(body, 'X1');
      expect.unreachable('should have thrown');
    } catch (error) {
      const appError = error as { code: string; message: string; raw: unknown };
      expect(appError.code).toBe(ErrorCode.COURIER_REJECTED);
      expect(appError.message).not.toContain('internal db constraint');
      // ...but it is preserved for logs and reconciliation.
      expect(JSON.stringify(appError.raw)).toContain('internal db constraint 4711');
    }
  });

  it('classifies a serviceability rejection distinctly', () => {
    const body = {
      status: 'Success',
      successResponse: [],
      errorResponse: [{ orderNumber: 'X1', message: 'Destination pincode not serviceable' }],
    };
    expect(() => fromManifestResponse(body, 'X1')).toThrowError(
      expect.objectContaining({ code: ErrorCode.COURIER_NOT_SERVICEABLE }),
    );
  });

  it('fails loudly when the courier reports success but returns no AWB', () => {
    const body = { status: 'Success', successResponse: [{ status: 'Success', orderNumber: 'X1' }] };
    expect(() => fromManifestResponse(body as never, 'X1')).toThrowError(
      expect.objectContaining({ code: ErrorCode.COURIER_BAD_RESPONSE }),
    );
  });
});

describe('fromTrackingResponse', () => {
  // Verbatim live UAT response.
  const body = {
    status: 'Success',
    message: 'Tracking',
    data: {
      awbNumber: 200000007359,
      orderNumber: 'EASE1786983073',
      pieces: 1,
      currentLocation: 'Gurgaon',
      edd: '2026-08-18',
      currentStatusDateTime: '17 Aug 2026, 21:41',
      currentStatusCode: 'MAN',
      currentStatusCodeDescription: 'Shipment Manifested',
      currentReasonCode: '',
      scans: [
        {
          statusDateTime: '17 Aug 2026, 21:41',
          statusCode: 'MAN',
          statusCodeDescription: 'Shipment Manifested',
          reasonCode: '',
          reasonCodeDescription: '',
          currentLocation: 'Gurgaon',
        },
      ],
    },
  };

  it('maps the courier status code onto the unified status', () => {
    const result = fromTrackingResponse(body, '200000007359');
    expect(result.currentStatus).toBe(ShipmentStatus.CREATED);
    expect(result.courierStatusCode).toBe('MAN');
    expect(result.awbNumber).toBe('200000007359');
    expect(result.estimatedDeliveryDate).toBe('2026-08-18');
  });

  it('preserves an unmapped courier code instead of dropping it', () => {
    const unmapped = {
      ...body,
      data: {
        ...body.data,
        currentStatusCode: 'ZZQ',
        scans: [{ ...body.data.scans[0]!, statusCode: 'ZZQ' }],
      },
    };
    const result = fromTrackingResponse(unmapped, '200000007359');

    expect(result.currentStatus).toBe(ShipmentStatus.UNKNOWN);
    expect(result.courierStatusCode).toBe('ZZQ');
    expect(result.events[0]!.courierStatusCode).toBe('ZZQ');
  });

  it('sorts scan history oldest-first', () => {
    const multi = {
      ...body,
      data: {
        ...body.data,
        currentStatusCode: 'PKD',
        scans: [
          { ...body.data.scans[0]!, statusCode: 'PKD', statusDateTime: '18 Aug 2026, 09:15' },
          { ...body.data.scans[0]!, statusCode: 'MAN', statusDateTime: '17 Aug 2026, 21:41' },
        ],
      },
    };
    const events = fromTrackingResponse(multi, '200000007359').events;

    expect(events.map((event) => event.courierStatusCode)).toEqual(['MAN', 'PKD']);
    expect(events[0]!.occurredAt.getTime()).toBeLessThan(events[1]!.occurredAt.getTime());
  });

  it('treats the HTTP-200 "Data Not Found" body as a 404', () => {
    // Verbatim live UAT response for an unknown AWB.
    const notFound = { status: 'Failed', message: 'Data Not Found', data: [] };
    expect(() => fromTrackingResponse(notFound, '999999999999')).toThrowError(
      expect.objectContaining({ code: ErrorCode.NOT_FOUND }),
    );
  });
});

describe('parseUrbaneBoltDateTime', () => {
  it('parses the courier format as IST', () => {
    // 21:41 IST on 17 Aug 2026 == 16:11 UTC.
    expect(parseUrbaneBoltDateTime('17 Aug 2026, 21:41').toISOString()).toBe(
      '2026-08-17T16:11:00.000Z',
    );
  });

  it('handles a date without a time component', () => {
    expect(parseUrbaneBoltDateTime('02 Oct 2024').toISOString()).toBe('2024-10-01T18:30:00.000Z');
  });

  it('falls back to now rather than producing an Invalid Date', () => {
    expect(Number.isNaN(parseUrbaneBoltDateTime('not a date').getTime())).toBe(false);
    expect(Number.isNaN(parseUrbaneBoltDateTime(undefined).getTime())).toBe(false);
  });
});

describe('fromCancelResponse', () => {
  it('reports a successful cancellation', () => {
    // Verbatim live UAT response.
    const body = {
      status: 'Success',
      message: 'Cancellation Proccess',
      successResponse: [
        { orderNumber: 'EASE1786983073', awb: '200000007359', message: 'Cancelled' },
      ],
      failureResponse: [],
    };
    expect(fromCancelResponse(body, '200000007359')).toEqual({
      awbNumber: '200000007359',
      cancelled: true,
      message: 'Shipment cancelled at the courier.',
    });
  });

  it('treats "already cancelled" as success, so cancel is idempotent', () => {
    // Verbatim live UAT response for a repeated cancellation.
    const body = {
      status: 'Success',
      message: 'Cancellation Proccess',
      successResponse: [],
      failureResponse: [
        {
          orderNumber: 'EASE1786983073',
          awb: '200000007359',
          message: 'Shipment already cancelled!',
        },
      ],
    };
    expect(fromCancelResponse(body, '200000007359')).toMatchObject({ cancelled: true });
  });

  it('maps a too-late cancellation to INVALID_STATE', () => {
    const body = {
      status: 'Success',
      successResponse: [],
      failureResponse: [{ awb: '200000007359', message: 'Shipment already picked up' }],
    };
    expect(() => fromCancelResponse(body, '200000007359')).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_STATE }),
    );
  });
});

describe('fromPincodeResponse', () => {
  // Verbatim live UAT response.
  const body = {
    status: 'Success',
    message: 'Pincodes',
    data: [
      {
        id: 1,
        pincode: 122001,
        inbound: true,
        outbound: true,
        rtn: true,
        isActive: true,
        serviceType: 'SDD,NDD,ATA,PTP,2HR',
      },
      {
        id: 2,
        pincode: 122017,
        inbound: true,
        outbound: true,
        rtn: true,
        isActive: true,
        serviceType: 'SDD,NDD,ATA,PTP,2HR,IMP',
      },
    ],
    errorPincodes: [],
  };

  it('reports the service tiers common to both ends of the lane', () => {
    expect(fromPincodeResponse(body, '122017', '122001')).toEqual({
      serviceable: true,
      availableServiceTypes: ['SDD', 'NDD', 'ATA', 'PTP', '2HR'],
    });
  });

  it('reports the delivery pincode as unserviceable when it is missing', () => {
    const result = fromPincodeResponse(body, '122017', '999999');
    expect(result.serviceable).toBe(false);
    expect(result.reason).toMatch(/999999/);
  });

  it('reports the pickup pincode as unserviceable when outbound is disabled', () => {
    const noOutbound = {
      ...body,
      data: [{ ...body.data[0]!, outbound: false }, body.data[1]!],
    };
    const result = fromPincodeResponse(noOutbound, '122001', '122017');
    expect(result.serviceable).toBe(false);
    expect(result.reason).toMatch(/122001/);
  });
});
