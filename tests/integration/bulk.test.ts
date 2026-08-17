import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/errors/error-codes';
import { BatchItemStatus, BatchStatus } from '../../src/models/batch.model';
import { OrderModel } from '../../src/models/order.model';
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

/** Submit a batch and run the worker until the queue is empty. */
async function submitAndDrain(orders: unknown[]): Promise<string> {
  const response = await request(harness.app)
    .post('/api/v1/orders/bulk')
    .send({ orders })
    .expect(202);

  const batchId = response.body.data.batch_id as string;
  expect(response.body.data.status).toBe(BatchStatus.QUEUED);
  expect(response.body.data.status_url).toBe(`/api/v1/orders/bulk/${batchId}`);

  await harness.container.worker.drain();
  return batchId;
}

describe('POST /api/v1/orders/bulk', () => {
  it('accepts 100 orders, returns a batch_id immediately, and processes them off the request', async () => {
    const orders = Array.from({ length: 100 }, (_, index) =>
      orderPayload(`BULK-100-${String(index).padStart(3, '0')}`),
    );

    const accepted = await request(harness.app)
      .post('/api/v1/orders/bulk')
      .send({ orders })
      .expect(202);

    // Nothing has been sent to any courier yet — the request returned first.
    expect(accepted.body.data.counts).toMatchObject({ total: 100, succeeded: 0, failed: 0 });
    expect(await OrderModel.countDocuments({})).toBe(0);

    await harness.container.worker.drain();

    const status = await request(harness.app)
      .get(`/api/v1/orders/bulk/${accepted.body.data.batch_id}`)
      .expect(200);

    expect(status.body.data.status).toBe(BatchStatus.COMPLETED);
    expect(status.body.data.counts).toMatchObject({ total: 100, succeeded: 100, failed: 0 });
    expect(await OrderModel.countDocuments({})).toBe(100);
  });

  it('rejects more than the configured maximum', async () => {
    const orders = Array.from({ length: 101 }, (_, index) => orderPayload(`BULK-OVER-${index}`));
    const response = await request(harness.app)
      .post('/api/v1/orders/bulk')
      .send({ orders })
      .expect(400);

    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('routes each order to its own courier partner within one batch', async () => {
    // A second courier registered under a different key, same adapter contract.
    const batchId = await submitAndDrain([
      orderPayload('BULK-MULTI-1', { courier_partner: 'mock' }),
      orderPayload('BULK-MULTI-2', { courier_partner: 'MOCK' }), // case-insensitive
      orderPayload('BULK-MULTI-3', { courier_partner: 'fedex' }), // not registered
    ]);

    const status = await request(harness.app).get(`/api/v1/orders/bulk/${batchId}`).expect(200);
    const byOrder = Object.fromEntries(
      status.body.data.results.map((item: { order_id: string }) => [item.order_id, item]),
    );

    expect(byOrder['BULK-MULTI-1'].status).toBe(BatchItemStatus.SUCCEEDED);
    expect(byOrder['BULK-MULTI-2'].status).toBe(BatchItemStatus.SUCCEEDED);
    expect(byOrder['BULK-MULTI-3'].status).toBe(BatchItemStatus.FAILED);
    expect(byOrder['BULK-MULTI-3'].error_code).toBe(ErrorCode.UNSUPPORTED_COURIER);
  });

  it('reports partial success with a human-readable reason per failed order', async () => {
    const unserviceable = orderPayload('BULK-PARTIAL-FAIL');
    (unserviceable.delivery_address as Record<string, unknown>).pincode = '000000';

    const batchId = await submitAndDrain([
      orderPayload('BULK-PARTIAL-OK-1'),
      orderPayload('BULK-PARTIAL-OK-2'),
      unserviceable,
      orderPayload('BULK-PARTIAL-UNKNOWN', { courier_partner: 'bluedart' }),
    ]);

    const status = await request(harness.app).get(`/api/v1/orders/bulk/${batchId}`).expect(200);

    expect(status.body.data.status).toBe(BatchStatus.COMPLETED_WITH_ERRORS);
    expect(status.body.data.counts).toMatchObject({ total: 4, succeeded: 2, failed: 2 });

    const results = status.body.data.results as Array<{
      order_id: string;
      status: string;
      error_code: string | null;
      reason: string | null;
      awb_number: string | null;
    }>;

    const succeeded = results.filter((item) => item.status === BatchItemStatus.SUCCEEDED);
    const failed = results.filter((item) => item.status === BatchItemStatus.FAILED);

    expect(succeeded.map((item) => item.order_id).sort()).toEqual([
      'BULK-PARTIAL-OK-1',
      'BULK-PARTIAL-OK-2',
    ]);
    expect(succeeded.every((item) => item.awb_number?.startsWith('MOCK'))).toBe(true);

    for (const item of failed) {
      expect(item.error_code).toBeTruthy();
      expect(item.reason).toBeTruthy();
      expect(item.reason!.length).toBeGreaterThan(10); // an actual sentence
    }
    expect(failed.find((item) => item.order_id === 'BULK-PARTIAL-UNKNOWN')!.reason).toMatch(
      /bluedart/i,
    );
    // The courier's internal error text never reaches the client.
    expect(JSON.stringify(results)).not.toContain('PINCODE_BLACKLISTED');
  });

  it('rejects a batch containing the same order_id twice', async () => {
    const response = await request(harness.app)
      .post('/api/v1/orders/bulk')
      .send({ orders: [orderPayload('BULK-DUP-1'), orderPayload('BULK-DUP-1')] })
      .expect(400);

    expect(response.body.error.fields[0].message).toMatch(/BULK-DUP-1/);
  });
});

describe('bulk idempotency', () => {
  it('never creates a second shipment when a batch is resubmitted', async () => {
    const orders = [orderPayload('BULK-IDEM-1'), orderPayload('BULK-IDEM-2')];

    const firstBatch = await submitAndDrain(orders);
    const secondBatch = await submitAndDrain(orders);

    expect(await OrderModel.countDocuments({})).toBe(2);
    expect(await OrderModel.countDocuments({ orderId: 'BULK-IDEM-1' })).toBe(1);

    const second = await request(harness.app).get(`/api/v1/orders/bulk/${secondBatch}`).expect(200);
    expect(second.body.data.counts).toMatchObject({ total: 2, succeeded: 0, duplicate: 2 });
    for (const item of second.body.data.results) {
      expect(item.status).toBe(BatchItemStatus.DUPLICATE);
      expect(item.reason).toMatch(/already existed/i);
    }

    // The first batch's AWBs are unchanged.
    const first = await request(harness.app).get(`/api/v1/orders/bulk/${firstBatch}`).expect(200);
    expect(first.body.data.counts).toMatchObject({ succeeded: 2 });
  });

  it('creates exactly one shipment when the same order_id is submitted concurrently', async () => {
    // Two batches racing on the same order_id, processed by two concurrent
    // worker drains — the unique index on orders.orderId is the arbiter.
    const payload = [orderPayload('BULK-RACE-1')];

    await request(harness.app).post('/api/v1/orders/bulk').send({ orders: payload }).expect(202);
    await request(harness.app).post('/api/v1/orders/bulk').send({ orders: payload }).expect(202);

    await Promise.all([
      harness.container.worker.drain(),
      harness.container.worker.drain(),
      harness.container.worker.drain(),
    ]);

    expect(await OrderModel.countDocuments({ orderId: 'BULK-RACE-1' })).toBe(1);

    const order = await OrderModel.findOne({ orderId: 'BULK-RACE-1' }).lean();
    // Exactly one courier call was made for this order.
    expect(order!.courierExchanges.filter((e) => e.operation === 'createShipment')).toHaveLength(1);
  });

  it('does not create a duplicate when a single create races a bulk submission', async () => {
    await request(harness.app)
      .post('/api/v1/orders/bulk')
      .send({ orders: [orderPayload('BULK-MIXED-1')] })
      .expect(202);

    const [single] = await Promise.all([
      request(harness.app).post('/api/v1/orders').send(orderPayload('BULK-MIXED-1')),
      harness.container.worker.drain(),
    ]);

    expect([200, 201]).toContain(single.status);
    expect(await OrderModel.countDocuments({ orderId: 'BULK-MIXED-1' })).toBe(1);
  });
});

describe('GET /api/v1/orders/bulk/:batch_id', () => {
  it('returns a normalized 404 for an unknown batch', async () => {
    const response = await request(harness.app).get('/api/v1/orders/bulk/batch_nope').expect(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});
