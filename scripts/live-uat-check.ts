/**
 * Live smoke test against a real courier UAT environment.
 *
 * Unlike the test suite (which is deterministic and offline), this script
 * drives create -> replay -> track -> cancel -> bulk through the unified API
 * with a real courier behind it, and prints every request/response pair. Use it
 * to confirm credentials and field mappings after a courier changes its schema.
 *
 *   npm run check:uat                      # uses COURIER from env, default urbanebolt
 *   COURIER=mock npm run check:uat         # offline dry run of the same flow
 *
 * Credentials are read from the environment only — nothing is hardcoded here.
 */
import request from 'supertest';

const COURIER = process.env.COURIER ?? 'urbanebolt';

async function main(): Promise<void> {
  // An ephemeral database keeps the check side-effect-free locally; set
  // MONGODB_URI beforehand to run it against a real one instead.
  let stopDatabase: () => Promise<void> = async () => {};
  if (!process.env.MONGODB_URI) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongod.getUri();
    stopDatabase = () => mongod.stop().then(() => undefined);
  }

  // Imported after MONGODB_URI is set: config validates the environment on import.
  const { createApp } = await import('../src/app');
  const { buildContainer } = await import('../src/container');
  const { connectDatabase, disconnectDatabase } = await import('../src/db');

  await connectDatabase();
  const container = buildContainer();
  const app = createApp(container);

  const orderId = `EASE${Date.now()}`;
  const payload = buildPayload(orderId);

  const created = await show('POST /api/v1/orders', request(app).post('/api/v1/orders').send(payload));
  await show(
    'POST /api/v1/orders (same order_id -> idempotent replay)',
    request(app).post('/api/v1/orders').send(payload),
  );
  await show(`GET /api/v1/orders/${orderId}/track`, request(app).get(`/api/v1/orders/${orderId}/track`));
  await show(
    `POST /api/v1/orders/${orderId}/cancel`,
    request(app).post(`/api/v1/orders/${orderId}/cancel`),
  );

  const bulk = await show(
    'POST /api/v1/orders/bulk',
    request(app)
      .post('/api/v1/orders/bulk')
      .send({
        orders: [
          buildPayload(`${orderId}B1`),
          buildPayload(`${orderId}B2`),
          { ...buildPayload(`${orderId}B3`), courier_partner: 'not-a-real-courier' },
        ],
      }),
  );

  await container.worker.drain();
  const batchId = (bulk.body as { data?: { batch_id?: string } }).data?.batch_id;
  if (batchId) {
    await show(
      `GET /api/v1/orders/bulk/${batchId}`,
      request(app).get(`/api/v1/orders/bulk/${batchId}`),
    );
  }

  const failed = created.status !== 201;
  await disconnectDatabase();
  await stopDatabase();
  process.exitCode = failed ? 1 : 0;
}

async function show(
  label: string,
  pending: request.Test,
): Promise<{ status: number; body: unknown }> {
  const response = await pending;
  console.log(`\n=== ${label} -> HTTP ${response.status} ===`);
  console.log(JSON.stringify(response.body, null, 2));
  return response;
}

function buildPayload(orderId: string): Record<string, unknown> {
  return {
    courier_partner: COURIER,
    order_id: orderId,
    payment_mode: 'COD',
    cod_amount: 1,
    declared_value: 100,
    currency: 'INR',
    pieces: 1,
    service_type: 'SDD',
    invoice_number: 'INV0002',
    invoice_date: '2024-10-02',
    pickup_address: {
      name: 'Rohit Athaley',
      address_line: 'HOLY FAITH INTERNATIONAL P LTD, Plot 137-138-139 Sector-I Govindpura',
      city: 'Govindpura',
      state: 'BHOPAL',
      pincode: '122001',
      country: 'INDIA',
      phone: '9425018023',
      email: 'bhopal@mbdgroup.com',
      address_type: 'Seller',
    },
    delivery_address: {
      name: 'Satyam Convent School',
      address_line: 'Plot No. 26-27, Om Nagar Society, Sumbhal, Surat',
      city: 'Surat',
      state: 'GUJRAT',
      pincode: '122001',
      country: 'INDIA',
      phone: '8320226438',
      email: 'TEST2@AIL.COM',
      address_type: 'Home',
    },
    return_address: {
      name: 'Rohit Athaley',
      address_line: 'HOLY FAITH INTERNATIONAL P LTD, Plot 137-138-139 Sector-I Govindpura',
      city: 'Govindpura',
      state: 'BHOPAL',
      pincode: '122017',
      country: 'INDIA',
      phone: '9425018023',
      email: 'bhopal@mbdgroup.com',
      address_type: 'Seller',
    },
    dimensions: { length_cm: 12, breadth_cm: 10, height_cm: 10, weight_kg: 1.1 },
    items: [{ description: 'BOOKS', quantity: 1, value: 100 }],
  };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
