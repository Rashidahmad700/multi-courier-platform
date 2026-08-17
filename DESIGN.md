# DESIGN

Architecture, the patterns used and why, the database schema, and the trade-offs
behind the bulk-processing and error-handling decisions.

---

## 1. Architecture

```
HTTP client
    │  unified, courier-agnostic JSON  ({ "courier_partner": "urbanebolt", ... })
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ api/          routes → zod validation → controller → presenter  │  no courier knowledge
├─────────────────────────────────────────────────────────────────┤
│ services/     OrderService, BulkService                         │  no courier knowledge
├─────────────────────────────────────────────────────────────────┤
│ couriers/     CourierRegistry  ──►  ICourierAdapter             │  ◄── the only seam
│                 ├── urbanebolt/ (adapter · mapper · types · auth)│
│                 └── mock/       (adapter · status)               │
├─────────────────────────────────────────────────────────────────┤
│ models/       orders · tracking_events · batches · jobs          │
└─────────────────────────────────────────────────────────────────┘
                        ▲
   queue/ JobQueue + BulkWorker (polls `jobs`, runs batches off the request path)
```

Two rules keep the layering honest:

1. **Nothing above `couriers/` may import a courier-specific module.** Services
   and controllers only ever see `ICourierAdapter` and the unified domain types
   in `src/domain/`.
2. **Nothing below `api/` reads `process.env`.** All configuration is validated
   once in `src/config/index.ts` and injected.

### Request flow, single order

```
POST /api/v1/orders
  → zod schema validates the body (400 with field-level detail on failure)
  → OrderService resolves the adapter from the registry (400 if unknown courier)
  → insert the order document        ← unique index on orderId = idempotency
  → adapter.createShipment(unified)  ← mapper translates to the courier's schema
  → persist AWB + status + the raw request/response exchange
  → 201 with the normalized response
```

The order row is written **before** the courier call. That ordering is
deliberate: it is what makes idempotency and failure-reconciliation possible.

---

## 2. Design patterns, and what was rejected

### Adapter + Registry (the core decision)

`ICourierAdapter` (`src/couriers/courier.interface.ts`) defines the contract:
`createShipment`, `trackShipment`, `cancelShipment`, and an optional
`checkServiceability` guarded by a declared `capabilities` object.
`CourierRegistry` maps a `courier_partner` string to a lazily-constructed
singleton adapter.

**Why lazily constructed?** Registration stores a *provider function*, not an
instance. A courier that is enabled but misconfigured therefore fails when it is
first used — with a clear error naming the missing environment variables —
instead of crashing boot for every other courier. This is unit-tested
(`courier-registry.test.ts`).

**"Minimal changes" defined precisely.** Adding a courier touches exactly three
things:

| # | What                                          | Lines |
| - | --------------------------------------------- | ----- |
| 1 | A new folder `src/couriers/<name>/`           | new files only |
| 2 | A settings block in `config/index.ts` + `.env.example` | ~5 |
| 3 | One `registry.register(...)` call in `src/couriers/index.ts` | 1 |

And it touches **zero** lines in: routes, controllers, DTOs, presenters,
`OrderService`, `BulkService`, the models, or any existing adapter. The
`MockCourierAdapter` is the proof — it was added under exactly these rules, and
`adapter-contract.test.ts` plus the whole integration suite run against it.

**Alternatives considered and rejected:**

- **A single `CourierService` with `switch (courier_partner)`.** Rejected: every
  new courier edits shared business logic, so the blast radius of a Delhivery
  bug includes UrbaneBolt. It also makes per-courier capability differences
  (some couriers have no serviceability API) into a growing thicket of
  conditionals.
- **Runtime plugin discovery** (scan `src/couriers/*` and auto-register).
  Rejected: it removes the single explicit list of what this deployment talks
  to, breaks static analysis and tree-shaking, and makes a typo'd folder name a
  silent no-op. One explicit `register` line is cheaper than the debugging it
  saves.
- **Per-courier HTTP clients inside each adapter.** Rejected: retry, backoff,
  audit capture and re-authentication would be reimplemented (and get subtly
  wrong) per courier. They live once in `CourierHttpClient`; adapters supply
  only a `getAuthHeader` callback.

### Mapper isolation

All UrbaneBolt field names live in exactly two files —
`urbanebolt.types.ts` (wire shapes) and `urbanebolt.mapper.ts` (translation).
The adapter class handles transport and orchestration only. When UrbaneBolt
changes a field, the diff is confined to those two files, and
`urbanebolt.mapper.test.ts` — which asserts against verbatim live UAT payloads —
fails immediately if the mapping drifts.

### Composition root

`src/container.ts` wires services together. Tests build a container with a
registry containing only the mock courier, so the integration suite exercises
the real HTTP layer, real Mongoose models and real services with no network.

---

## 3. Database schema

MongoDB via Mongoose. Four collections.

### `orders` — one document per shipment

| Field | Purpose |
| ----- | ------- |
| `orderId` | Client-supplied business id. **Unique index** — the idempotency key. |
| `internalOrderId` | Our surrogate id (`ord_<uuid>`), unique, exposed in responses. |
| `courierPartner` | Which courier handled it. Indexed. |
| `courierOrderId` | The courier's own order reference. |
| `awbNumber` | Tracking number. Indexed. |
| `status` | Unified status enum. Indexed. |
| `courierStatusCode`, `statusDescription` | The courier's own last-reported code, unmapped. |
| `unifiedRequest` | The normalized payload the client sent. |
| `courierExchanges[]` | **Full raw request + raw response** for every courier round-trip, with endpoint, HTTP status and duration. |
| `lastFailure` | `{ errorCode, message, raw, attempts, at }` — survives the failed request. |
| `reconciled` | Ops flag for failed orders. Indexed with `status`. |
| `labelUrl`, `routeCode`, `estimatedDeliveryDate`, `batchId`, `requestId`, `cancelledAt` | Supporting fields. |
| `createdAt` / `updatedAt` | Mongoose timestamps. |

Compound index `{ status, reconciled, createdAt }` serves the one query
operations actually runs: "what failed and has not been dealt with?"

### `tracking_events` — append-only history

Every courier-reported scan, one document each, with `status` (unified),
`courierStatusCode` (raw), `description`, `location`, `reasonCode`,
`occurredAt`, `recordedAt`, and the `rawPayload` it came from.

- **Nothing in the codebase updates or deletes a document here.** The only write
  path is `insertMany(..., { ordered: false })`.
- A unique index `{ awbNumber, courierStatusCode, occurredAt }` makes repeated
  polling naturally idempotent: replayed scans are rejected by the database and
  skipped, while genuinely new scans are inserted in the same call.
- The collection holds **courier-reported scans only**. Platform-side
  transitions (we created it; we asked for cancellation) are recorded on the
  order document and in `courierExchanges`. Mixing the two produced duplicate
  `CREATED` rows — an integration test caught it, and the design was fixed
  rather than the test.

### `batches` — bulk submissions

`batchId`, overall `status`, roll-up counts, and an embedded `items[]` array
holding per-order `status` (`QUEUED` / `PROCESSING` / `SUCCEEDED` / `FAILED` /
`DUPLICATE`), `awbNumber`, `errorCode` and a human-readable `reason`.

Items are embedded rather than kept in a separate collection: a batch is capped
at 100 items, is always read as a whole, and per-item updates use positional
`arrayFilters`, so the document stays far below the 16 MB limit and reads are a
single lookup.

### `jobs` — the work queue

`type`, `status`, `payload`, `attempts`, `maxAttempts`, `availableAt`,
`lockedUntil`, `lastError`. Indexed on `{ type, status, availableAt }` to match
the claim query exactly.

---

## 4. Bulk processing (requirement 3.4)

### The decision: accept → persist → enqueue → 202 with a `batch_id`

`POST /api/v1/orders/bulk` validates the payload, writes a `batches` document,
enqueues one job, and returns HTTP **202** with a `batch_id` and a `status_url`.
It never waits on a courier. A worker then claims the job and processes the
orders with bounded concurrency (`BULK_WORKER_CONCURRENCY`, default 10).

Why bounded rather than `Promise.all` over all 100: couriers rate-limit, and
firing 100 simultaneous connections at a courier is the fastest way to get
throttled or blocked. Concurrency is a config value so it can be tuned per
courier contract.

### Alternatives considered and rejected

- **Streamed results (NDJSON / chunked response).** Genuinely tempting — the
  caller learns outcomes as they happen with no polling. Rejected because the
  work then only lives for as long as the HTTP connection: a client timeout,
  proxy idle-timeout or dropped connection at order 60 loses the remaining 40
  with no record. The queue makes the batch durable, restartable, and
  observable by *any* client, not just the one that submitted it. Streaming
  remains a reasonable future addition **on top of** the queue.
- **Synchronous processing inside the request** (even concurrently). Rejected:
  100 orders × a courier that occasionally takes 15 s puts the request well past
  any sane gateway timeout, and holds a Node request slot the whole time.
- **BullMQ / Redis.** The standard answer, and better than what we built if
  Redis is already in the stack: it gives push-based delivery, rate limiting and
  a UI for free. Rejected here because the assignment fixes MongoDB as the
  datastore and adding Redis doubles the operational surface for one queue. The
  cost of our choice is stated plainly below.
- **MongoDB change streams / capped-collection tailing** instead of polling.
  Rejected: change streams require a replica set, which a single-node dev
  MongoDB is not, so it would make local setup harder for no gain at this scale.

### Trade-offs we accept

| Trade-off | Consequence | Mitigation |
| --------- | ----------- | ---------- |
| Polling, not push | Pickup latency up to `BULK_WORKER_POLL_INTERVAL_MS` (default 500 ms) | Tunable; negligible against courier latency |
| No priority queue | All batches are FIFO | Fine for one job family; add a `priority` field + sort key if that changes |
| At-least-once delivery | A worker that dies after calling the courier but before recording it will retry the order | Safe because the courier call is idempotent on `orderId`: the retry is recorded as `DUPLICATE`, not a second shipment |
| Results are polled, not pushed | Client needs `GET /orders/bulk/:batch_id` | `status_url` is returned in the 202 |

### Idempotency (the guarantee that matters most)

The order document is inserted **before** the courier is called, and
`orders.orderId` carries a unique index. Two concurrent submissions of the same
`order_id` therefore race in the database; exactly one wins, and the loser never
reaches the courier. Idempotency is enforced by the database, not by an
application-level check-then-act, which would be racy by construction.

Three tests prove it: a repeated batch, two batches racing under three
concurrent worker drains, and a single create racing a bulk submission. Each
asserts `countDocuments({ orderId }) === 1` and that exactly one
`createShipment` exchange was recorded.

One deliberate exception: an order whose previous attempt **failed before
getting an AWB** is adopted and retried in place. Without this, a transient
courier outage would permanently poison an `order_id`.

---

## 5. Error handling (requirement 3.5)

### One response shape, everywhere

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
safe-to-expose context. Success responses are the mirror image:
`{ "success": true, "data": { … }, "request_id": "…" }`.

`errorHandler` is the single place an error becomes a response, so the shape
cannot drift between endpoints — including 404s for unmatched routes and 400s
for malformed JSON.

### Normalized error codes

| Code | HTTP | Raised when |
| ---- | ---- | ----------- |
| `VALIDATION_ERROR` | 400 | Body/params failed the schema |
| `UNSUPPORTED_COURIER` | 400 | Unknown `courier_partner`; response lists the supported ones |
| `NOT_FOUND` | 404 | Unknown order, batch or route |
| `DUPLICATE_ORDER` | 409 | Courier already has a shipment for this `order_id` |
| `INVALID_STATE` | 409 | e.g. cancelling a delivered shipment |
| `COURIER_REJECTED` | 422 | Courier 4xx / per-item rejection |
| `COURIER_NOT_SERVICEABLE` | 422 | Lane not serviced |
| `COURIER_AUTH_FAILED` | 502 | Credentials rejected after re-authenticating |
| `COURIER_UNAVAILABLE` | 503 | Courier 5xx, timeout, network failure |
| `COURIER_BAD_RESPONSE` | 502 | Courier answered in a shape we cannot parse |
| `INTERNAL_ERROR` | 500 | Anything unclassified; always logged with a stack trace |

### The courier's raw error never reaches the client

`AppError` carries a `raw` field. It is **absent from `toClientJSON`** by
construction, and instead is (a) logged under `courier_raw`, and (b) persisted
in `orders.lastFailure.raw` and `orders.courierExchanges`. Where a courier's
free-text message carries real signal, it is *classified* into one of our codes
rather than forwarded — `classifyManifestFailure` turns
`"orderNumber already shipped!"` into `DUPLICATE_ORDER` with our own wording.
Two tests assert that an invented courier string appears in `raw` but not in the
client-facing message.

### Retries

`withRetry` + `computeBackoffDelay` implement exponential backoff with **full
jitter**, entirely driven by config (`COURIER_RETRY_MAX_ATTEMPTS`,
`_BASE_DELAY_MS`, `_MAX_DELAY_MS`, `_JITTER`). Only `COURIER_UNAVAILABLE` is
retryable — retrying a rejected payload just burns the courier's rate limit.
Full jitter (uniform in `[0, capped]`) rather than plain exponential is chosen so
a fleet of workers does not re-hit a recovering courier in lockstep.

### Auth failure → re-authenticate → exactly one retry

`CourierHttpClient.sendWithAuthRecovery` catches a 401/403, calls
`getAuthHeader(forceRefresh: true)`, and retries **once**. A second failure
raises `COURIER_AUTH_FAILED`, which is explicitly non-retryable so genuinely bad
credentials fail fast instead of hammering the courier's auth endpoint. Both
paths are tested against a real local HTTP server.

### Failures are persisted, never lost

A failed creation writes `status: FAILED` plus `lastFailure` (code, message, raw,
attempt count, timestamp) to the order *before* the error propagates. Combined
with the `{ status, reconciled }` index, that turns "we 500'd and lost it" into a
queryable reconciliation backlog. This was demonstrated live: during development
the UrbaneBolt UAT host returned HTTP 503 for several minutes, and the platform
retried, backed off, persisted every failure and reported per-item reasons in
the batch status — see `docs/urbanebolt-uat-samples.md` §7.

### Logging

Every failure log line carries `order_id`, `courier_partner`, `request_id`,
`error_type` and a stack trace, via `logFailure`. `request_id` is generated per
request (or taken from an inbound `X-Request-Id`), returned in the response body
and header, stamped on the order document, and threaded into every adapter call.
Pino redaction strips `password` and `authorization` at the logger level, so an
adapter cannot leak a credential by logging a request object.

---

## 6. Library choices

| Concern | Choice | Why |
| ------- | ------ | --- |
| Validation | **zod** | Schema *is* the TypeScript type — one definition, no drift between the DTO and its validator. `.strict()` rejects unknown fields, which stops silent typos in client payloads. |
| HTTP client | **axios** | `validateStatus: () => true` lets us capture the audit record for failures too, instead of losing the body inside a thrown error. |
| Logger | **pino** | Structured JSON by default and fast enough to leave on in production; built-in redaction for credentials. |
| Queue | **MongoDB collection + polling worker** | Keeps the dependency set at one datastore, as the assignment requires. Full reasoning and rejected alternatives in §4. |
| Concurrency limiter | **hand-rolled (20 lines)** | `p-limit` is ESM-only, which is friction in a CommonJS build, and we want guaranteed input/output ordering. |
| Test runner | **vitest** | Runs TypeScript with no separate transform config, and `mongodb-memory-server` gives real MongoDB semantics (including unique-index races) without Docker. |
| ORM/ODM | **mongoose** | Schema-level enums, indexes and `strict: 'throw'` on the audit collection are cheap guard rails against a future accidental mutating write. |

---

## 7. Testing strategy

92 tests, all offline and deterministic.

- **Unit** — adapter contract (`describe.each` over every adapter, so a new
  courier is checked by adding one line), registry incl. the unknown-courier
  path, retry/backoff (retryable vs not, exhaustion, recovery, jitter bounds),
  the UrbaneBolt mapper against **verbatim live UAT payloads**, and the HTTP
  transport against a real ephemeral local server (5xx retry, 4xx no-retry,
  401 → re-auth → one retry, timeout).
- **Integration** — real Express + real Mongoose + in-memory MongoDB, driving
  `POST /orders → GET /track → POST /cancel`, the append-only history guarantee,
  the audit trail, the full error contract, bulk partial success, and three
  distinct idempotency races.
- **Live** — `npm run check:uat` drives the same flow against a real courier UAT
  and prints every exchange. Not part of `npm test`, because a graded test suite
  must not depend on a third party's uptime.

---

## 8. Known gaps

Stated rather than silently dropped.

1. **Three UrbaneBolt status codes are mapped from documentation, not observed.**
   `UND`, `RTO` and `RTD` are in `URBANEBOLT_STATUS_MAP` but never appeared on a
   live UAT shipment (which cannot be driven to an undelivered/RTO state from
   the customer API). Nine codes *were* observed live and are confirmed. Any
   unlisted code maps to `UNKNOWN` and is stored with its raw value, so the risk
   is a mislabelled status, never a lost one. **Next:** ask UrbaneBolt for the
   authoritative code list and add a scheduled job that alerts on `UNKNOWN`.
2. **No scheduled tracking poller.** Status refreshes happen when someone calls
   `GET /track`. A production deployment wants a periodic job polling
   non-terminal shipments (and, better, a webhook receiver if UrbaneBolt offers
   one). The queue and the append-only history are already in place for it — it
   needs a second job type. **Next:** add a `track-refresh` job enqueued on a
   cron, reusing `OrderService.trackOrder`.
3. **No authentication on our own API.** The assignment specifies the courier
   integration, not the platform's edge security, and inventing an auth scheme
   would have been scope creep. **Next:** API-key middleware plus per-key rate
   limiting; `request_id` plumbing is already in place to support it.
4. **Reconciliation is queryable but not automated.** Failed orders are
   persisted with `reconciled: false` and indexed for retrieval, but there is no
   worker that retries them and no ops endpoint that lists them. **Next:** a
   `reconcile` job type reusing the same adoption logic that already lets a
   failed `order_id` be retried in place.
5. **Endpoints outside the required four are not integrated.** `print-label`,
   `epod`, `ndr` (RTO / re-attempt), `update-paymode` and `global-manifest`
   exist in the collection. They were left out deliberately: NDR and ePOD have
   no meaningful cross-courier abstraction yet (a second courier's NDR model
   would likely reshape the interface), and forcing them into `ICourierAdapter`
   now would bake in UrbaneBolt's model as the universal one. Serviceability
   *was* added, because it is genuinely common across couriers and strengthens
   the pre-flight path. The shipping label is surfaced as `label_url` from the
   create response.
6. **Bulk retries re-run the whole batch.** If a `bulk-order` job fails at the
   job level (not the item level), the retry reprocesses all items. This is safe
   — already-created orders come back as `DUPLICATE` — but wasteful.
   **Next:** skip items already in a terminal state when reprocessing.
