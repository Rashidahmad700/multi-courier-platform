# Multi-Courier Integration Platform

A production-shaped backend that puts **one unified API** in front of many
courier partners. Callers send our normalized order schema plus a
`courier_partner` field; they never see any courier's payload shape.

**UrbaneBolt** is the first live integration, built against the real UAT API and
verified with live calls — every field name, status code and error shape in this
repo was captured from `https://uat.urbanebolt.in`, not guessed. See
[`docs/urbanebolt-uat-samples.md`](docs/urbanebolt-uat-samples.md).
A second **mock courier** ships alongside it to prove the pluggable design.

- Architecture, patterns, schema and trade-offs → [`DESIGN.md`](DESIGN.md)
- Real captured courier request/response pairs → [`docs/urbanebolt-uat-samples.md`](docs/urbanebolt-uat-samples.md)
- Ready-to-import Postman collection → [`postman/`](postman/)

---

## Contents

- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Running](#running)
- [Testing](#testing)
- [API contract](#api-contract)
- [Adding a new courier](#adding-a-new-courier)
- [Project layout](#project-layout)

---

## Quick start

Requirements: **Node.js ≥ 20** and a **MongoDB** instance (local or Atlas).

```bash
git clone <this-repo> && cd multi-courier-platform
npm install
cp .env.example .env          # then fill in the UrbaneBolt credentials
npm run dev                   # API on http://localhost:3000
```

Smoke-test it without any courier credentials — the mock courier needs none:

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/api/v1/couriers

curl -s -X POST http://localhost:3000/api/v1/orders \
  -H 'Content-Type: application/json' \
  -d '{
    "courier_partner": "mock",
    "order_id": "DEMO-1",
    "payment_mode": "PREPAID",
    "cod_amount": 0,
    "declared_value": 1500,
    "pieces": 1,
    "pickup_address":   { "name": "Acme Warehouse", "address_line": "Plot 12, Phase II", "city": "Gurgaon", "state": "Haryana", "pincode": "122017", "country": "INDIA", "phone": "9425018023", "address_type": "Seller" },
    "delivery_address": { "name": "Priya Menon",    "address_line": "26 Om Nagar",       "city": "Gurgaon", "state": "Haryana", "pincode": "122001", "country": "INDIA", "phone": "8320226438", "address_type": "Home" },
    "dimensions": { "length_cm": 12, "breadth_cm": 10, "height_cm": 10, "weight_kg": 1.1 },
    "items": [{ "description": "Paperback books", "quantity": 2, "value": 750 }]
  }'

curl -s http://localhost:3000/api/v1/orders/DEMO-1/track
curl -s -X POST http://localhost:3000/api/v1/orders/DEMO-1/cancel
```

No local MongoDB? The test suite and the UAT smoke script both start an
in-memory MongoDB automatically — see [Testing](#testing).

---

## Environment variables

Every setting is read and validated once at boot ([`src/config/index.ts`](src/config/index.ts));
nothing else in the codebase touches `process.env`. A missing or malformed value
fails startup with a message naming the variable. Full annotated list in
[`.env.example`](.env.example).

### Required

| Variable | Example | Notes |
| -------- | ------- | ----- |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/multi_courier` | The only strictly required variable. |

### Runtime

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | pino level; `silent` in tests |
| `MONGODB_DB_NAME` | *(from URI)* | Overrides the database name in the URI |

### Bulk processing

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `BULK_MAX_ORDERS` | `100` | Max orders per bulk request |
| `BULK_WORKER_CONCURRENCY` | `10` | Orders sent to couriers simultaneously |
| `BULK_WORKER_POLL_INTERVAL_MS` | `500` | Idle poll interval for the worker |
| `BULK_JOB_VISIBILITY_TIMEOUT_MS` | `120000` | Lease on a claimed job; a crashed worker's job is reclaimed after this |
| `BULK_JOB_MAX_ATTEMPTS` | `3` | Job-level retries before a job is parked as `FAILED` |
| `RUN_WORKER_IN_API_PROCESS` | `true` | `true` for local/demo; set `false` in production and run the worker separately |

### Courier defaults (apply to every adapter)

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `COURIER_HTTP_TIMEOUT_MS` | `15000` | Per-request timeout |
| `COURIER_RETRY_MAX_ATTEMPTS` | `3` | Total attempts, including the first |
| `COURIER_RETRY_BASE_DELAY_MS` | `300` | Exponential backoff base |
| `COURIER_RETRY_MAX_DELAY_MS` | `5000` | Backoff cap |
| `COURIER_RETRY_JITTER` | `true` | Full jitter, so workers do not retry in lockstep |

### Courier: UrbaneBolt

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `URBANEBOLT_ENABLED` | `true` | Set `false` to drop it from the registry entirely |
| `URBANEBOLT_BASE_URL` | — | `https://uat.urbanebolt.in` for UAT |
| `URBANEBOLT_USERNAME` | — | From the UrbaneBolt integration team |
| `URBANEBOLT_PASSWORD` | — | From the UrbaneBolt integration team |
| `URBANEBOLT_CUSTOMER_CODE` | — | e.g. `UEBCUS0008` |
| `URBANEBOLT_DEFAULT_SERVICE_TYPE` | `SDD` | Used when a request omits `service_type` |
| `URBANEBOLT_TOKEN_REFRESH_SKEW_S` | `300` | Refresh the token this early |

If `URBANEBOLT_ENABLED=true` but a credential is missing, the failure surfaces
the first time the courier is used — naming the missing variables — rather than
crashing boot for every other courier.

### Courier: Mock

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `MOCK_COURIER_ENABLED` | `true` | |
| `MOCK_COURIER_LATENCY_MS` | `0` | Simulated latency, to observe bulk concurrency |
| `MOCK_COURIER_FAIL_PINCODE` | `000000` | Shipments to this pincode are rejected |

---

## Running

```bash
npm run dev            # API with hot reload (tsx watch)
npm run dev:worker     # bulk worker with hot reload

npm run build          # compile to dist/
npm start              # node dist/index.js
npm run start:worker   # node dist/worker.js
```

**Two processes in production.** Set `RUN_WORKER_IN_API_PROCESS=false` and run
`npm run start:worker` alongside `npm start`, so a slow courier can never block
HTTP request handling. Multiple workers are safe — job claiming is a single
atomic `findOneAndUpdate`. With the default `true`, the API process runs the
worker in-process, which is convenient locally and logs a warning to say so.

**Health:** `GET /health` returns 200 when MongoDB is connected, 503 otherwise,
along with the list of registered couriers.

---

## Testing

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest run (92 tests)
npm run test:watch
```

The suite starts an **in-memory MongoDB** automatically — no local MongoDB, no
Docker, no courier credentials, no network. The first run downloads a MongoDB
binary (cached afterwards).

What is covered:

| Area | File |
| ---- | ---- |
| `ICourierAdapter` contract, run against *every* adapter | `tests/unit/adapter-contract.test.ts` |
| Registry, incl. the unknown-courier error path | `tests/unit/courier-registry.test.ts` |
| Retry / backoff: retryable vs not, exhaustion, recovery, jitter | `tests/unit/retry.test.ts` |
| HTTP transport: 5xx retry, 4xx no-retry, 401 → re-auth → one retry, timeout | `tests/unit/http-client.test.ts` |
| UrbaneBolt mapper, against verbatim live UAT payloads | `tests/unit/urbanebolt.mapper.test.ts` |
| `POST /orders → GET /track → POST /cancel` over real HTTP | `tests/integration/orders.test.ts` |
| Bulk: 100 orders, partial success, three idempotency races | `tests/integration/bulk.test.ts` |

### Live check against a real courier UAT

Separate from `npm test`, because a graded suite must not depend on a third
party's uptime:

```bash
# uses your .env; prints every request/response pair
npm run check:uat

# same flow, fully offline
COURIER=mock npm run check:uat
```

It drives create → idempotent replay → track → cancel → bulk (including an
unknown-courier item, to show partial-success reporting) and starts its own
in-memory MongoDB unless `MONGODB_URI` is already set.

---

## API contract

Base path `/api/v1`. All bodies are JSON. Unknown fields are **rejected**, not
ignored.

### Response envelopes

Success:

```json
{ "success": true, "data": { }, "request_id": "req_9f1c…" }
```

Error — identical shape on every endpoint:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "fields": [{ "field": "delivery_address.pincode", "message": "must be 4-10 digits" }],
    "details": { "supported_couriers": ["mock", "urbanebolt"] }
  },
  "request_id": "req_9f1c…"
}
```

`fields` appears only for validation errors; `details` only when there is
safe-to-expose context. **A courier's raw error is never included** — it is
logged and persisted instead.

`request_id` is echoed in the `X-Request-Id` response header. Send your own
`X-Request-Id` and it will be used, so a caller's trace survives end to end.

### Error codes

| Code | HTTP | Meaning |
| ---- | ---- | ------- |
| `VALIDATION_ERROR` | 400 | Body or params failed the schema; see `fields` |
| `UNSUPPORTED_COURIER` | 400 | Unknown `courier_partner`; `details.supported_couriers` lists valid values |
| `NOT_FOUND` | 404 | Unknown order, batch or route |
| `DUPLICATE_ORDER` | 409 | The courier already has a shipment for this `order_id` |
| `INVALID_STATE` | 409 | Illegal transition, e.g. cancelling a delivered shipment |
| `COURIER_REJECTED` | 422 | The courier rejected the shipment |
| `COURIER_NOT_SERVICEABLE` | 422 | Lane not serviced by this courier |
| `COURIER_AUTH_FAILED` | 502 | Courier credentials rejected after re-authenticating |
| `COURIER_UNAVAILABLE` | 503 | Courier 5xx, timeout or network failure, after retries |
| `COURIER_BAD_RESPONSE` | 502 | Courier answered in a shape we cannot parse |
| `INTERNAL_ERROR` | 500 | Unclassified; logged with a stack trace |

### Shipment statuses

`PENDING`, `CREATED`, `PICKED_UP`, `IN_TRANSIT`, `OUT_FOR_DELIVERY`,
`DELIVERED`, `UNDELIVERED`, `RTO_IN_TRANSIT`, `RTO_DELIVERED`, `CANCELLED`,
`FAILED`, `UNKNOWN`.

Each courier's own codes are mapped onto this list. An unrecognised courier code
becomes `UNKNOWN` and is still stored with its raw value in
`courier_status_code` — nothing is dropped silently.

---

### `GET /api/v1/couriers`

Which `courier_partner` values this deployment accepts, and what each supports.

```json
{
  "success": true,
  "data": {
    "couriers": [
      { "courier_partner": "mock",       "capabilities": { "serviceability": true, "shipping_label": true, "cancellation": true } },
      { "courier_partner": "urbanebolt", "capabilities": { "serviceability": true, "shipping_label": true, "cancellation": true } }
    ]
  },
  "request_id": "req_…"
}
```

---

### `POST /api/v1/orders` — create one shipment

**201** on creation, **200** when the `order_id` was already processed
(idempotent replay — no second shipment is created).

#### Request

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `courier_partner` | string | ✔ | e.g. `"urbanebolt"`, `"mock"`. Case-insensitive |
| `order_id` | string | ✔ | Your business id **and** the idempotency key. `[A-Za-z0-9_-]`, ≤ 80 chars |
| `payment_mode` | `"PREPAID"` \| `"COD"` | ✔ | |
| `cod_amount` | number | | Default `0`. Must be `> 0` for COD, `0` for PREPAID |
| `declared_value` | number | ✔ | Total declared value |
| `currency` | string(3) | | Default `"INR"` |
| `pieces` | integer | | Default `1` |
| `service_type` | string | | Courier tier, e.g. `"SDD"`. Falls back to the courier's configured default |
| `invoice_number` | string | | Defaults to `order_id` at the courier |
| `invoice_date` | string | | `YYYY-MM-DD`; defaults to today |
| `pickup_address` | Address | ✔ | Where the parcel is collected |
| `delivery_address` | Address | ✔ | Destination |
| `return_address` | Address | | Defaults to `pickup_address` |
| `dimensions` | Dimensions | ✔ | |
| `items` | Item[] | ✔ | 1–100 entries |

**Address**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `name` | string | ✔ | ≤ 120 chars |
| `address_line` | string | ✔ | ≤ 500 chars |
| `city` | string | ✔ | |
| `state` | string | ✔ | |
| `pincode` | string | ✔ | 4–10 digits |
| `country` | string | | Default `"INDIA"` |
| `phone` | string | ✔ | 7–15 chars, digits plus `+`, space, `-` |
| `email` | string | | Valid email |
| `address_type` | string | | e.g. `"Home"`, `"Seller"` |

**Dimensions** — `length_cm`, `breadth_cm`, `height_cm`, `weight_kg`: all
positive numbers, all required.

**Item** — `description` (✔), `quantity` (✔, positive integer), `value`
(✔, ≥ 0), `sku`, `hsn_code`.

#### Response `201`

```json
{
  "success": true,
  "data": {
    "order_id": "DEMO-1",
    "internal_order_id": "ord_9bc209e5-65d3-42f6-a467-3e7ed95d2717",
    "courier_partner": "urbanebolt",
    "courier_order_id": "DEMO-1",
    "awb_number": "200000007359",
    "status": "CREATED",
    "courier_status_code": null,
    "status_description": null,
    "label_url": "https://api.uat.urbanebolt.in/api/v1/services/print-label/?key=…",
    "route_code": "GGN/DLHH",
    "estimated_delivery_date": null,
    "batch_id": null,
    "created_at": "2026-08-17T16:32:50.591Z",
    "updated_at": "2026-08-17T16:32:50.591Z",
    "cancelled_at": null,
    "idempotent_replay": false
  },
  "request_id": "req_…"
}
```

An order whose previous attempt failed *before* getting an AWB may be retried on
the same `order_id`; it is adopted and retried in place rather than rejected.

---

### `GET /api/v1/orders/{order_id}/track` — status + history

`{order_id}` accepts either your `order_id` or our `internal_order_id`.

Refreshes from the courier, appends any new scans to the append-only history,
and returns the order plus the full history. If the courier is unreachable, the
last known state is served rather than failing the read.

#### Response `200`

```json
{
  "success": true,
  "data": {
    "order_id": "DEMO-1",
    "internal_order_id": "ord_9bc…",
    "courier_partner": "urbanebolt",
    "awb_number": "200000007359",
    "status": "OUT_FOR_DELIVERY",
    "courier_status_code": "OFD",
    "status_description": "Out for Delivery",
    "estimated_delivery_date": "2026-08-18",
    "history": [
      {
        "status": "CREATED",
        "courier_status_code": "MAN",
        "description": "Shipment Manifested",
        "location": "Gurgaon",
        "reason_code": null,
        "reason_description": null,
        "occurred_at": "2026-08-17T16:11:00.000Z"
      },
      {
        "status": "PICKED_UP",
        "courier_status_code": "PKD",
        "description": "Picked Up",
        "location": "Gurgaon",
        "reason_code": null,
        "reason_description": null,
        "occurred_at": "2026-08-18T03:45:00.000Z"
      }
    ]
  },
  "request_id": "req_…"
}
```

`history` is ordered oldest-first, stored in a separate append-only collection,
and is never overwritten or deleted. Repeated polling does not duplicate it.

---

### `POST /api/v1/orders/{order_id}/cancel`

**200** on success. Idempotent: cancelling an already-cancelled order returns
200 again. Cancelling a `DELIVERED` or `RTO_DELIVERED` shipment returns **409**
`INVALID_STATE`. An order that never reached a courier is cancelled locally.

Response body is the order object (same fields as create), with
`status: "CANCELLED"` and `cancelled_at` set.

---

### `POST /api/v1/orders/bulk` — up to 100 orders

Returns **202 immediately** with a `batch_id`; the orders are processed off the
request path by the worker, with bounded concurrency. Each order in the batch
may target a **different** `courier_partner`.

#### Request

```json
{ "orders": [ { /* same shape as POST /orders */ }, … ] }
```

1–100 entries. `order_id` values must be unique within the batch (400 otherwise).

#### Response `202`

```json
{
  "success": true,
  "data": {
    "batch_id": "batch_af1a5bcc-d0e8-403d-bbe5-3e55974ef456",
    "status": "QUEUED",
    "counts": { "total": 3, "succeeded": 0, "failed": 0, "duplicate": 0, "pending": 3 },
    "created_at": "2026-08-17T16:32:52.383Z",
    "started_at": null,
    "completed_at": null,
    "results": [ { "order_id": "…", "courier_partner": "…", "status": "QUEUED", "…": null } ],
    "status_url": "/api/v1/orders/bulk/batch_af1a5bcc-…"
  },
  "request_id": "req_…"
}
```

---

### `GET /api/v1/orders/bulk/{batch_id}` — batch status

Batch `status`: `QUEUED` → `PROCESSING` → `COMPLETED` or
`COMPLETED_WITH_ERRORS`.
Per-item `status`: `QUEUED`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `DUPLICATE`.

`DUPLICATE` means that `order_id` had already been processed, so **no second
shipment was created** — the idempotency guarantee, visible in the response.

#### Response `200` (partial success)

```json
{
  "success": true,
  "data": {
    "batch_id": "batch_af1a…",
    "status": "COMPLETED_WITH_ERRORS",
    "counts": { "total": 3, "succeeded": 1, "failed": 2, "duplicate": 0, "pending": 0 },
    "started_at": "2026-08-17T16:32:52.391Z",
    "completed_at": "2026-08-17T16:32:53.020Z",
    "results": [
      {
        "order_id": "BULK-1",
        "courier_partner": "urbanebolt",
        "status": "SUCCEEDED",
        "internal_order_id": "ord_…",
        "awb_number": "200000007360",
        "error_code": null,
        "reason": null,
        "processed_at": "2026-08-17T16:32:52.9Z"
      },
      {
        "order_id": "BULK-2",
        "courier_partner": "urbanebolt",
        "status": "FAILED",
        "internal_order_id": null,
        "awb_number": null,
        "error_code": "COURIER_NOT_SERVICEABLE",
        "reason": "The courier does not service this pickup/delivery lane.",
        "processed_at": "2026-08-17T16:32:52.8Z"
      },
      {
        "order_id": "BULK-3",
        "courier_partner": "not-a-real-courier",
        "status": "FAILED",
        "internal_order_id": null,
        "awb_number": null,
        "error_code": "UNSUPPORTED_COURIER",
        "reason": "Unsupported courier_partner \"not-a-real-courier\".",
        "processed_at": "2026-08-17T16:32:52.393Z"
      }
    ]
  },
  "request_id": "req_…"
}
```

Every failed item carries a normalized `error_code` and a human-readable
`reason`. The reason is **our** wording — the courier's raw error is logged and
persisted, never returned.

---

### `GET /health`

200 when MongoDB is connected, 503 otherwise. Reports uptime and the registered
couriers.

---

## Adding a new courier

Concretely, using "Delhivery" as the example. Three files change; **no**
controller, route, DTO, service, model or existing adapter is touched.

**1. Create the folder** `src/couriers/delhivery/`:

```
delhivery.types.ts    # the courier's wire shapes, one interface per endpoint
delhivery.status.ts   # its status codes -> our ShipmentStatus enum
delhivery.mapper.ts   # pure translation both ways; no HTTP, no DB
delhivery.adapter.ts  # implements ICourierAdapter; transport + orchestration
delhivery.auth.ts     # only if it needs token management
```

`delhivery.adapter.ts` implements
[`ICourierAdapter`](src/couriers/courier.interface.ts):

```ts
export class DelhiveryAdapter implements ICourierAdapter {
  readonly name = 'delhivery';
  readonly capabilities = { serviceability: true, shippingLabel: true, cancellation: true };

  private readonly http = new CourierHttpClient({
    courierName: this.name,
    baseUrl: this.options.baseUrl,
    timeoutMs: this.options.timeoutMs,
    retry: this.options.retry,
    getAuthHeader: (forceRefresh) => this.tokens.getAuthHeader(forceRefresh),
  });

  async createShipment(request, context) {
    const { data, audit } = await this.http.request(
      { method: 'POST', url: '/api/v1/shipments', data: toDelhiveryShipment(request) },
      { requestId: context.requestId, orderId: request.orderId, operation: 'createShipment' },
    );
    return { data: fromDelhiveryShipment(data, request.orderId), audit };
  }

  // trackShipment, cancelShipment, optionally checkServiceability
}
```

Retry, backoff, audit capture and re-authenticate-then-retry-once come from
`CourierHttpClient` — do not reimplement them.

**2. Add config** — a block in `src/config/index.ts` under `couriers`, plus the
matching entries in `.env.example`. Never hardcode a URL, key or timeout.

**3. Register it** — one line in `src/couriers/index.ts`:

```ts
if (config.couriers.delhivery.enabled) {
  registry.register('delhivery', () => createDelhiveryAdapter({ /* config */ }));
}
```

**4. Add tests** — add the adapter to the `adapters` array in
`tests/unit/adapter-contract.test.ts` (one line; it is then checked against the
shared contract automatically) and write `tests/unit/delhivery.mapper.test.ts`
using real captured payloads.

That is the whole procedure. Callers start using
`"courier_partner": "delhivery"` immediately, with no client-side change beyond
the string.

---

## Project layout

```
src/
  api/            routes, controller, response presenters
  config/         env parsing + validation (the only place reading process.env)
  couriers/
    courier.interface.ts   ICourierAdapter — the seam
    courier.registry.ts    courier_partner -> adapter
    index.ts               the ONE file listing which couriers exist
    urbanebolt/            adapter · mapper · types · status · auth
    mock/                  bonus adapter proving pluggability
  domain/         unified types + the shipment status enum
  dto/            zod schemas + DTO -> domain mapping
  errors/         AppError, error codes, HTTP mapping
  middleware/     request id, validation, the single error handler
  models/         orders, tracking_events (append-only), batches, jobs
  queue/          MongoDB-backed job queue + bulk worker
  services/       OrderService, BulkService
  utils/          retry/backoff, courier HTTP client, concurrency, logger
  app.ts  container.ts  db.ts  index.ts  worker.ts  shutdown.ts
scripts/          live UAT smoke check
tests/            unit + integration
docs/             captured real UrbaneBolt UAT samples
postman/          importable collection for every endpoint
```
