import { describe, expect, it } from 'vitest';
import type { ICourierAdapter } from '../../src/couriers/courier.interface';
import { MockCourierAdapter } from '../../src/couriers/mock/mock.adapter';
import { UrbaneBoltAdapter } from '../../src/couriers/urbanebolt/urbanebolt.adapter';
import { ShipmentStatus } from '../../src/domain/shipment-status';
import { ErrorCode } from '../../src/errors/error-codes';
import type { UnifiedShipmentRequest } from '../../src/domain/unified.types';

/**
 * The contract every adapter must honour. Adding a courier means adding it to
 * `adapters` below — if the new adapter breaks the shared contract, this fails
 * without any other test being touched.
 */
const adapters: Array<[string, ICourierAdapter]> = [
  ['mock', new MockCourierAdapter({ latencyMs: 0, failPincode: '000000' })],
  [
    'urbanebolt',
    new UrbaneBoltAdapter({
      baseUrl: 'https://uat.urbanebolt.invalid',
      username: 'u',
      password: 'p',
      customerCode: 'C1',
      defaultServiceType: 'SDD',
      timeoutMs: 100,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
      tokenRefreshSkewSeconds: 60,
    }),
  ],
];

describe.each(adapters)('ICourierAdapter contract: %s', (name, adapter) => {
  it('exposes a name matching its registry key', () => {
    expect(adapter.name).toBe(name);
  });

  it('implements every mandatory operation', () => {
    expect(typeof adapter.createShipment).toBe('function');
    expect(typeof adapter.trackShipment).toBe('function');
    expect(typeof adapter.cancelShipment).toBe('function');
  });

  it('declares its capabilities explicitly', () => {
    expect(adapter.capabilities).toEqual({
      serviceability: expect.any(Boolean),
      shippingLabel: expect.any(Boolean),
      cancellation: expect.any(Boolean),
    });
  });

  it('provides checkServiceability exactly when it claims the capability', () => {
    expect(typeof adapter.checkServiceability === 'function').toBe(
      adapter.capabilities.serviceability,
    );
  });
});

const order: UnifiedShipmentRequest = {
  orderId: 'CONTRACT-1',
  paymentMode: 'PREPAID',
  codAmount: 0,
  declaredValue: 500,
  currency: 'INR',
  pieces: 1,
  pickup: {
    name: 'WH',
    addressLine: 'Line 1',
    city: 'Gurgaon',
    state: 'HR',
    pincode: '122017',
    country: 'INDIA',
    phone: '9000000001',
  },
  delivery: {
    name: 'Customer',
    addressLine: 'Line 2',
    city: 'Gurgaon',
    state: 'HR',
    pincode: '122001',
    country: 'INDIA',
    phone: '9000000002',
  },
  returnAddress: {
    name: 'WH',
    addressLine: 'Line 1',
    city: 'Gurgaon',
    state: 'HR',
    pincode: '122017',
    country: 'INDIA',
    phone: '9000000001',
  },
  dimensions: { lengthCm: 10, breadthCm: 10, heightCm: 10, weightKg: 1 },
  items: [{ description: 'Widget', quantity: 1, value: 500 }],
};

const ctx = { requestId: 'req_contract' };

describe('MockCourierAdapter behaviour', () => {
  it('runs create -> track -> cancel and returns audit data at every step', async () => {
    const adapter = new MockCourierAdapter({ latencyMs: 0, failPincode: '000000' });

    const created = await adapter.createShipment(order, ctx);
    expect(created.data.awbNumber).toMatch(/^MOCK[0-9A-F]{12}$/);
    expect(created.data.status).toBe(ShipmentStatus.CREATED);
    expect(created.audit.requestPayload).toBeDefined();
    expect(created.audit.responsePayload).toBeDefined();

    const tracked = await adapter.trackShipment(created.data.awbNumber, ctx);
    expect(tracked.data.currentStatus).toBe(ShipmentStatus.CREATED);
    expect(tracked.data.events).toHaveLength(1);

    const cancelled = await adapter.cancelShipment(created.data.awbNumber, ctx);
    expect(cancelled.data.cancelled).toBe(true);

    const afterCancel = await adapter.trackShipment(created.data.awbNumber, ctx);
    expect(afterCancel.data.currentStatus).toBe(ShipmentStatus.CANCELLED);
    expect(afterCancel.data.events).toHaveLength(2);
  });

  it('maps its own vocabulary onto the unified status enum', async () => {
    const adapter = new MockCourierAdapter({ latencyMs: 0, failPincode: '000000' });
    const created = await adapter.createShipment(order, ctx);

    adapter.advanceTo(created.data.awbNumber, 'LAST_MILE');
    const tracked = await adapter.trackShipment(created.data.awbNumber, ctx);

    expect(tracked.data.courierStatusCode).toBe('LAST_MILE');
    expect(tracked.data.currentStatus).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
  });

  it('records an unmapped courier code as UNKNOWN without losing it', async () => {
    const adapter = new MockCourierAdapter({ latencyMs: 0, failPincode: '000000' });
    const created = await adapter.createShipment(order, ctx);

    adapter.advanceTo(created.data.awbNumber, 'TELEPORTED');
    const tracked = await adapter.trackShipment(created.data.awbNumber, ctx);

    expect(tracked.data.currentStatus).toBe(ShipmentStatus.UNKNOWN);
    expect(tracked.data.courierStatusCode).toBe('TELEPORTED');
  });

  it('rejects the configured failure pincode with a typed error', async () => {
    const adapter = new MockCourierAdapter({ latencyMs: 0, failPincode: '000000' });
    const failing = { ...order, delivery: { ...order.delivery, pincode: '000000' } };

    await expect(adapter.createShipment(failing, ctx)).rejects.toMatchObject({
      code: ErrorCode.COURIER_NOT_SERVICEABLE,
    });
  });

  it('reports an unknown AWB as NOT_FOUND', async () => {
    const adapter = new MockCourierAdapter({ latencyMs: 0, failPincode: '000000' });
    await expect(adapter.trackShipment('MOCKDOESNOTEXIST', ctx)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });
});
