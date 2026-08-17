# UrbaneBolt UAT — captured request/response pairs

Everything below is a **verbatim capture from live calls** to
`https://uat.urbanebolt.in` on 2026-08-17, using the credentials published in the
assignment's Postman collection (`https://bit.ly/ease-commerce-assignment` →
documenter view `19172174/2sAYHzFhxb`). No payload on this page is invented.

These captures are the source of truth for
[`urbanebolt.types.ts`](../src/couriers/urbanebolt/urbanebolt.types.ts),
[`urbanebolt.mapper.ts`](../src/couriers/urbanebolt/urbanebolt.mapper.ts) and
[`urbanebolt.status.ts`](../src/couriers/urbanebolt/urbanebolt.status.ts), and are
replayed as fixtures in
[`tests/unit/urbanebolt.mapper.test.ts`](../tests/unit/urbanebolt.mapper.test.ts).

Credentials are shown as `$USERNAME` / `$PASSWORD` / `$TOKEN`; the real values
belong in `.env`.

---

## 1. Authentication

`POST /api/v1/auth/getToken/`

```bash
curl -X POST "$URBANEBOLT_BASE_URL/api/v1/auth/getToken/" \
  -H "Content-Type: application/json" \
  -d '{"username":"'"$USERNAME"'","password":"'"$PASSWORD"'"}'
```

Response — HTTP 200:

```json
{
  "access_token": "rLUYvVwhrvg6AJgQzTivk33soP3ltb",
  "expires_in": 86400,
  "token_type": "Bearer",
  "expires": "2026-08-18T18:05:45.803396",
  "status": "Success"
}
```

Notes that shaped the implementation:

- The token lives 24 h. `UrbaneBoltTokenManager` caches it and refreshes
  `URBANEBOLT_TOKEN_REFRESH_SKEW_S` seconds early.
- Concurrent callers share one in-flight refresh, so a 100-order batch triggers
  a single token call.

---

## 2. Create shipment (manifest)

`POST /api/v1/services/manifest/` — **the body is an array**.

```bash
curl -X POST "$URBANEBOLT_BASE_URL/api/v1/services/manifest/" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{
    "customerCode": "UEBCUS0008",
    "orderNumber": "EASE1786983073",
    "declaredValue": 100,
    "itemDescription": "BOOKS",
    "collectableValue": 1,
    "height": 10, "length": 12, "breadth": 10, "weight": 1.1, "pieces": 1,
    "serviceType": "SDD",
    "payMode": "COD",
    "shprName": "Rohit Athaley",
    "shprAddress": "HOLY FAITH INTERNATIONAL P LTD,Plot No.l37-138-139",
    "shprAddressType": "Seller",
    "shprCity": "Govindpura", "shprState": "BHOPAL", "shprCountry": "INDIA",
    "shprPincode": 122001, "shprMobile": 9425018023, "shprEmail": "bhopal@mbdgroup.com",
    "consName": "Satyam Convent School",
    "consAddress": "Plot No. 26-27, Om Nagar Society,Sumbhal, Surat",
    "consAddressType": "Home",
    "consCity": "Surat", "consState": "GUJRAT", "consCountry": "INDIA",
    "consPincode": 122001, "consMobile": 8320226438, "consEmail": "TEST2@AIL.COM",
    "rtnName": "Rohit Athaley",
    "rtnAddress": "HOLY FAITH INTERNATIONAL P LTD,Plot No.l37-138-139",
    "rtnAddressType": "Seller",
    "rtnCity": "Govindpura", "rtnState": "BHOPAL", "rtnCountry": "INDIA",
    "rtnPincode": 122017, "rtnMobile": 9425018023, "rtnEmail": "bhopal@mbdgroup.com",
    "invoiceNumber": "INV0002",
    "invoiceDate": "2024-10-02",
    "invoiceValue": 10,
    "itemQuantity": 1
  }]'
```

Response — HTTP 200:

```json
{
  "status": "Success",
  "successResponse": [
    {
      "status": "Success",
      "orderNumber": "EASE1786983073",
      "awbNumber": 200000007359,
      "routeCode": "GGN/DLHH",
      "shippingLabel": "https://api.uat.urbanebolt.in/api/v1/services/print-label/?key=himPHMijuCAmot7VZq835Xjybl8FN2T5K28xiNRCrEg25LrwZvc5pNnW16Pj4RA5",
      "customerCode": "UEBCUS0008"
    }
  ],
  "errorResponse": []
}
```

**Re-submitting the same `orderNumber`** — still HTTP 200, failure reported per item:

```json
{
  "status": "Success",
  "successResponse": [],
  "errorResponse": [
    {
      "orderNumber": "EASE1786983073",
      "customerCode": "UEBCUS0008",
      "status": "Failed",
      "message": "orderNumber already shipped!"
    }
  ]
}
```

Notes that shaped the implementation:

- **HTTP 200 does not mean success.** The adapter inspects `errorResponse` and
  raises a typed error; `classifyManifestFailure` maps
  `"orderNumber already shipped!"` → `DUPLICATE_ORDER`.
- `awbNumber` is a JSON *number*; we store it as a string to avoid precision and
  leading-zero problems.
- The adapter posts a one-element array per order, so a per-item failure is
  attributable to exactly one of our orders — this is what makes bulk
  partial-success reporting exact.

---

## 3. Track shipment

`GET /api/v1/services/tracking-pub/?awb=200000007359`

Response — HTTP 200:

```json
{
  "status": "Success",
  "message": "Tracking",
  "data": {
    "awbNumber": 200000007359,
    "orderNumber": "EASE1786983073",
    "pieces": 1,
    "addedOn": "17 Aug 2026",
    "invoiceDate": "02 Oct 2024",
    "invoiceNumber": "INV0002",
    "remarks": null,
    "shipperName": "Rohit Athaley",
    "origin": "Gurgaon",
    "destination": "Gurgaon",
    "currentLocation": "Gurgaon",
    "edd": "2026-08-18",
    "currentStatusDateTime": "17 Aug 2026, 21:41",
    "currentStatusCode": "MAN",
    "currentStatusCodeDescription": "Shipment Manifested",
    "currentReasonCode": "",
    "currentReasonCodeDescription": "",
    "isRto": false,
    "weight": 1.1,
    "referenceAwb": null,
    "lat": 0.0,
    "lng": 0.0,
    "productType": "COD",
    "delOtpVerified": false,
    "pickupOtpVerified": false,
    "rtoOtpVerified": false,
    "delPod": "",
    "pickupPod": "",
    "rto_status": 0,
    "scans": [
      {
        "statusDateTime": "17 Aug 2026, 21:41",
        "statusCode": "MAN",
        "statusCodeDescription": "Shipment Manifested",
        "reasonCode": "",
        "reasonCodeDescription": "",
        "currentLocation": "Gurgaon"
      }
    ]
  }
}
```

**Unknown AWB** — also HTTP 200:

```json
{ "status": "Failed", "message": "Data Not Found", "data": [] }
```

Notes that shaped the implementation:

- `data` is an object on success and an **empty array** on "not found"; the
  mapper checks for that and raises `NOT_FOUND` rather than crashing.
- `statusDateTime` has no timezone (`"17 Aug 2026, 21:41"`). It is parsed
  explicitly as IST (UTC+5:30) instead of relying on `new Date()`.

---

## 4. Cancel shipment

`POST /api/v1/services/cancel/` with `{"awbs": "200000007359"}`

Response — HTTP 200:

```json
{
  "status": "Success",
  "message": "Cancellation Proccess",
  "successResponse": [
    { "orderNumber": "EASE1786983073", "awb": "200000007359", "message": "Cancelled" }
  ],
  "failureResponse": []
}
```

**Cancelling twice** — HTTP 200:

```json
{
  "status": "Success",
  "message": "Cancellation Proccess",
  "successResponse": [],
  "failureResponse": [
    {
      "orderNumber": "EASE1786983073",
      "awb": "200000007359",
      "message": "Shipment already cancelled!"
    }
  ]
}
```

The mapper treats "already cancelled" as a successful no-op, which is what makes
`POST /orders/{id}/cancel` idempotent.

---

## 5. Serviceability (pincode lookup)

`GET /api/v1/location/pincodes/?pincodes=122001,122017`

Response — HTTP 200:

```json
{
  "status": "Success",
  "message": "Pincodes",
  "data": [
    {
      "id": 1, "pincode": 122001,
      "inbound": true, "outbound": true, "rtn": true, "isActive": true,
      "serviceCenter": "Gurgaon DC - GGN", "city": "Gurgaon - GGN",
      "state": "Haryana - HR", "region": "Central", "zone": "Zone5",
      "routeCode": "GGN/DLHH", "serviceType": "SDD,NDD,ATA,PTP,2HR"
    },
    {
      "id": 2, "pincode": 122017,
      "inbound": true, "outbound": true, "rtn": true, "isActive": true,
      "serviceCenter": "Gurgaon DC - GDC", "city": "Gurgaon - GGN",
      "state": "Haryana - HR", "region": "Central", "zone": "Zone5",
      "routeCode": "GDC/GGNH", "serviceType": "SDD,NDD,ATA,PTP,2HR,IMP"
    }
  ],
  "errorPincodes": []
}
```

This is why `ICourierAdapter` carries an optional `checkServiceability`: the
capability is real for UrbaneBolt, but not universal across couriers.

---

## 6. Authentication failure

Any authenticated endpoint with a bad or expired token — HTTP **401**:

```json
{ "detail": "Authentication credentials were not provided." }
```

This is the only endpoint family observed to use a real 4xx status. It drives
the re-authenticate-and-retry-once path in `CourierHttpClient`.

---

## 7. Courier outage

Observed live during development — the whole UAT host answered HTTP **503** with
an nginx error page (not JSON) for several minutes:

```
HTTP/2 503
<html><head><title>503 Service Temporarily Unavailable</title></head>...
```

The platform classified this as `COURIER_UNAVAILABLE`, retried with exponential
backoff, then persisted the failure on the order (`lastFailure`) and reported it
per item in the batch status — exactly the behaviour requirement 3.5 asks for.

---

## 8. Status codes observed on UAT

Harvested by tracking a range of real UAT AWBs. `statusCodeDescription` is
UrbaneBolt's own wording.

| UrbaneBolt code | Description         | Unified status     |
| --------------- | ------------------- | ------------------ |
| `MAN`           | Shipment Manifested | `CREATED`          |
| `PKA`           | Pickup Assigned     | `CREATED`          |
| `PKD`           | Picked Up           | `PICKED_UP`        |
| `RDC`           | Reached at DC       | `IN_TRANSIT`       |
| `DDS`           | Delivery Scheduled  | `IN_TRANSIT`       |
| `OFD`           | Out for Delivery    | `OUT_FOR_DELIVERY` |
| `DDL`           | Delivered           | `DELIVERED`        |
| `RTL`           | RTO Lock            | `RTO_IN_TRANSIT`   |
| `CAN`           | Cancelled           | `CANCELLED`        |

Three further codes (`UND`, `RTO`, `RTD`) are mapped from UrbaneBolt's NDR/RTO
documentation but were **not** observed on a live UAT shipment; they are flagged
as such in `DESIGN.md` under "Known gaps". Any code outside this table maps to
`UNKNOWN` and is stored with its raw value, so nothing is dropped silently.

---

## 9. Endpoints in the collection that are **not** integrated

`print-label`, `epod`, `ndr` (RTO / re-attempt), `update-paymode` and
`global-manifest` exist in the collection but are outside the assignment's
scope (auth, create, track, cancel). They are deliberately excluded rather than
force-fitted into `ICourierAdapter` — see "Known gaps" in `DESIGN.md`. The
shipping label is still surfaced: `manifest` returns a `shippingLabel` URL,
which we persist and expose as `label_url`.
