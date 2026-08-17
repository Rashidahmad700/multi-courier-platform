import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ShipmentStatus } from '../../src/domain/shipment-status';
import { ErrorCode } from '../../src/errors/error-codes';
import { OrderModel } from '../../src/models/order.model';
import { TrackingEventModel } from '../../src/models/tracking-event.model';
import { orderPayload } from '../helpers/fixtures';
import { startTestHarness, type TestHarness } from '../helpers/test-app';

let harness: TestHarness;

beforeAll(async () => {
  harness = await startTestHarness();
});
afterAll(async () => {
  await harness.stop();
});
beforeEach(async () => {
  await harness.reset();
});

describe('POST /api/v1/orders -> GET track -> POST cancel', () => {
  it('runs the full lifecycle through the real HTTP layer', async () => {
    const created = await request(harness.app)
      .post('/api/v1/orders')
      .send(orderPayload('ORD-LIFECYCLE-1'))
      .expect(201);

    expect(created.body).toMatchObject({
      success: true,
      data: {
        order_id: 'ORD-LIFECYCLE-1',
        courier_partner: 'mock',
        status: ShipmentStatus.CREATED,
        idempotent_replay: false,
      },
    });
    expect(created.body.data.awb_number).toMatch(/^MOCK/);
    expect(created.body.data.internal_order_id).toMatch(/^ord_/);
    expect(created.body.request_id).toBeTruthy();
    expect(created.headers['x-request-id']).toBe(created.body.request_id);

    const awb = created.body.data.awb_number as string;

    // Move the shipment along at the courier so tracking has real history.
    harness.mock.advanceTo(awb, 'COLLECTED', 'Gurgaon Hub');
    harness.mock.advanceTo(awb, 'LAST_MILE', 'Gurgaon DC');

    const tracked = await request(harness.app)
      .get('/api/v1/orders/ORD-LIFECYCLE-1/track')
      .expect(200);

    expect(tracked.body.data.status).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
    expect(tracked.body.data.courier_status_code).toBe('LAST_MILE');
    expect(tracked.body.data.history.map((event: { status: string }) => event.status)).toEqual([
      ShipmentStatus.CREATED,
      ShipmentStatus.PICKED_UP,
      ShipmentStatus.OUT_FOR_DELIVERY,
    ]);

    const cancelled = await request(harness.app)
      .post('/api/v1/orders/ORD-LIFECYCLE-1/cancel')
      .expect(200);

    expect(cancelled.body.data.status).toBe(ShipmentStatus.CANCELLED);
    expect(cancelled.body.data.cancelled_at).toBeTruthy();
  });

  it('accepts the internal order id as well as the client order_id', async () => {
    const created = await request(harness.app)
      .post('/api/v1/orders')
      .send(orderPayload('ORD-REF-1'))
      .expect(201);

    await request(harness.app)
      .get(`/api/v1/orders/${created.body.data.internal_order_id}/track`)
      .expect(200);
  });

  it('persists the full raw courier request and response for audit', async () => {
    await request(harness.app).post('/api/v1/orders').send(orderPayload('ORD-AUDIT-1')).expect(201);

    const order = await OrderModel.findOne({ orderId: 'ORD-AUDIT-1' }).lean();
    expect(order!.courierExchanges).toHaveLength(1);
    expect(order!.courierExchanges[0]).toMatchObject({
      operation: 'createShipment',
      method: 'POST',
    });
    expect(order!.courierExchanges[0]!.requestPayload).toBeTruthy();
    expect(order!.courierExchanges[0]!.responsePayload).toBeTruthy();
    expect(order!.unifiedRequest).toBeTruthy();
    expect(order!.createdAt).toBeInstanceOf(Date);
    expect(order!.updatedAt).toBeInstanceOf(Date);
  });

  it('stores tracking history append-only, never overwriting earlier scans', async () => {
    const created = await request(harness.app)
      .post('/api/v1/orders')
      .send(orderPayload('ORD-APPEND-1'))
      .expect(201);
    const awb = created.body.data.awb_number as string;

    harness.mock.advanceTo(awb, 'COLLECTED');
    await request(harness.app).get('/api/v1/orders/ORD-APPEND-1/track').expect(200);

    // Polling again with no new scans must not duplicate history.
    await request(harness.app).get('/api/v1/orders/ORD-APPEND-1/track').expect(200);

    harness.mock.advanceTo(awb, 'DELIVERY_DONE');
    const final = await request(harness.app).get('/api/v1/orders/ORD-APPEND-1/track').expect(200);

    const stored = await TrackingEventModel.find({ awbNumber: awb }).sort({ occurredAt: 1 }).lean();
    expect(stored.map((event) => event.courierStatusCode)).toEqual([
      'SHIPMENT_BOOKED',
      'COLLECTED',
      'DELIVERY_DONE',
    ]);
    // The earliest event is still present and untouched.
    expect(stored[0]!.status).toBe(ShipmentStatus.CREATED);
    expect(final.body.data.status).toBe(ShipmentStatus.DELIVERED);
  });

  it('is idempotent for a repeated single create: one shipment, HTTP 200', async () => {
    const first = await request(harness.app)
      .post('/api/v1/orders')
      .send(orderPayload('ORD-IDEM-1'))
      .expect(201);

    const second = await request(harness.app)
      .post('/api/v1/orders')
      .send(orderPayload('ORD-IDEM-1'))
      .expect(200);

    expect(second.body.data.idempotent_replay).toBe(true);
    expect(second.body.data.awb_number).toBe(first.body.data.awb_number);
    expect(await OrderModel.countDocuments({ orderId: 'ORD-IDEM-1' })).toBe(1);
  });

  it('refuses to cancel a delivered shipment', async () => {
    const created = await request(harness.app)
      .post('/api/v1/orders')
      .send(orderPayload('ORD-DELIVERED-1'))
      .expect(201);

    harness.mock.advanceTo(created.body.data.awb_number as string, 'DELIVERY_DONE');
    await request(harness.app).get('/api/v1/orders/ORD-DELIVERED-1/track').expect(200);

    const response = await request(harness.app)
      .post('/api/v1/orders/ORD-DELIVERED-1/cancel')
      .expect(409);

    expect(response.body.error.code).toBe(ErrorCode.INVALID_STATE);
  });

  it('treats a repeated cancel as a no-op rather than an error', async () => {
    await request(harness.app).post('/api/v1/orders').send(orderPayload('ORD-CAN-2')).expect(201);
    await request(harness.app).post('/api/v1/orders/ORD-CAN-2/cancel').expect(200);
    await request(harness.app).post('/api/v1/orders/ORD-CAN-2/cancel').expect(200);
  });
});

describe('error contract', () => {
  it('rejects an unknown courier with 400 and the supported list', async () => {
    const response = await request(harness.app)
      .post('/api/v1/orders')
      .send(orderPayload('ORD-BADCOURIER-1', { courier_partner: 'delhivery' }))
      .expect(400);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: ErrorCode.UNSUPPORTED_COURIER,
        details: { supported_couriers: ['mock'] },
      },
    });
    expect(response.body.request_id).toBeTruthy();
    // Nothing was persisted for an unroutable courier.
    expect(await OrderModel.countDocuments({ orderId: 'ORD-BADCOURIER-1' })).toBe(0);
  });

  it('returns field-level detail for a validation failure', async () => {
    const payload = orderPayload('ORD-BAD-1') as Record<string, unknown>;
    delete payload.delivery_address;
    payload.declared_value = -5;

    const response = await request(harness.app).post('/api/v1/orders').send(payload).expect(400);

    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    const fields = response.body.error.fields.map((field: { field: string }) => field.field);
    expect(fields).toContain('delivery_address');
    expect(fields).toContain('declared_value');
  });

  it('enforces the COD invariant between payment_mode and cod_amount', async () => {
    const response = await request(harness.app)
      .post('/api/v1/orders')
      .send(orderPayload('ORD-COD-1', { payment_mode: 'COD', cod_amount: 0 }))
      .expect(400);

    expect(response.body.error.fields[0]).toMatchObject({ field: 'cod_amount' });
  });

  it('rejects unknown fields instead of silently ignoring them', async () => {
    const response = await request(harness.app)
      .post('/api/v1/orders')
      .send(orderPayload('ORD-EXTRA-1', { secret_flag: true }))
      .expect(400);

    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('maps a courier rejection to a normalized code and persists the failure', async () => {
    const payload = orderPayload('ORD-FAIL-1');
    (payload.delivery_address as Record<string, unknown>).pincode = '000000';

    const response = await request(harness.app).post('/api/v1/orders').send(payload).expect(422);

    expect(response.body.error.code).toBe(ErrorCode.COURIER_NOT_SERVICEABLE);
    expect(JSON.stringify(response.body)).not.toContain('PINCODE_BLACKLISTED');

    // The failure survives the request so it can be reconciled later.
    const order = await OrderModel.findOne({ orderId: 'ORD-FAIL-1' }).lean();
    expect(order!.status).toBe(ShipmentStatus.FAILED);
    expect(order!.lastFailure).toMatchObject({ errorCode: ErrorCode.COURIER_NOT_SERVICEABLE });
    expect(JSON.stringify(order!.lastFailure!.raw)).toContain('PINCODE_BLACKLISTED');
  });

  it('lets a previously failed order be retried on the same order_id', async () => {
    const failing = orderPayload('ORD-RETRY-1');
    (failing.delivery_address as Record<string, unknown>).pincode = '000000';
    await request(harness.app).post('/api/v1/orders').send(failing).expect(422);

    const succeeding = await request(harness.app)
      .post('/api/v1/orders')
      .send(orderPayload('ORD-RETRY-1'))
      .expect(201);

    expect(succeeding.body.data.status).toBe(ShipmentStatus.CREATED);
    expect(await OrderModel.countDocuments({ orderId: 'ORD-RETRY-1' })).toBe(1);
  });

  it('returns a normalized 404 for an unknown order', async () => {
    const response = await request(harness.app).get('/api/v1/orders/nope/track').expect(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('returns a normalized 404 for an unmatched route', async () => {
    const response = await request(harness.app).get('/api/v1/nothing-here').expect(404);
    expect(response.body).toMatchObject({ success: false, error: { code: ErrorCode.NOT_FOUND } });
  });

  it('rejects malformed JSON with a 400 in the same error shape', async () => {
    const response = await request(harness.app)
      .post('/api/v1/orders')
      .set('Content-Type', 'application/json')
      .send('{"order_id":')
      .expect(400);

    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('echoes an inbound X-Request-Id so caller traces survive', async () => {
    const response = await request(harness.app)
      .get('/api/v1/orders/nope/track')
      .set('X-Request-Id', 'caller-trace-123')
      .expect(404);

    expect(response.body.request_id).toBe('caller-trace-123');
  });
});

describe('GET /api/v1/couriers', () => {
  it('advertises the couriers this deployment supports', async () => {
    const response = await request(harness.app).get('/api/v1/couriers').expect(200);
    expect(response.body.data.couriers).toEqual([
      {
        courier_partner: 'mock',
        capabilities: { serviceability: true, shipping_label: true, cancellation: true },
      },
    ]);
  });
});
