/**
 * Wire types for the UrbaneBolt UAT API.
 *
 * Every field below was confirmed against the published Postman collection
 * (https://bit.ly/ease-commerce-assignment -> documenter view 19172174) and by
 * live calls to https://uat.urbanebolt.in — see docs/urbanebolt-uat-samples.md
 * for the captured request/response pairs. Nothing here is guessed.
 */

// ---------------------------------------------------------------------------
// POST /api/v1/auth/getToken/
// ---------------------------------------------------------------------------

export interface UrbaneBoltAuthRequest {
  username: string;
  password: string;
}

export interface UrbaneBoltAuthResponse {
  access_token: string;
  /** Lifetime in seconds (observed: 86400). */
  expires_in: number;
  token_type: string;
  /** ISO-ish absolute expiry, e.g. "2026-08-18T18:05:45.803396". */
  expires: string;
  status: string;
}

// ---------------------------------------------------------------------------
// POST /api/v1/services/manifest/   (create shipment; body is an ARRAY)
// ---------------------------------------------------------------------------

export interface UrbaneBoltManifestItem {
  customerCode: string;
  orderNumber: string;
  declaredValue: number;
  itemDescription: string;
  collectableValue: number;
  height: number;
  length: number;
  breadth: number;
  weight: number;
  pieces: number;
  serviceType: string;
  payMode: 'COD' | 'PPD';

  // Shipper (where the parcel is collected from)
  shprName: string;
  shprAddress: string;
  shprAddressType: string;
  shprCity: string;
  shprState: string;
  shprCountry: string;
  shprPincode: number;
  shprMobile: number;
  shprEmail: string;

  // Consignee (destination)
  consName: string;
  consAddress: string;
  consAddressType: string;
  consCity: string;
  consState: string;
  consCountry: string;
  consPincode: number;
  consMobile: number;
  consEmail: string;

  // Return-to address (used on RTO)
  rtnName: string;
  rtnAddress: string;
  rtnAddressType: string;
  rtnCity: string;
  rtnState: string;
  rtnCountry: string;
  rtnPincode: number;
  rtnMobile: number;
  rtnEmail: string;

  invoiceNumber: string;
  /** YYYY-MM-DD */
  invoiceDate: string;
  invoiceValue: number;
  itemQuantity: number;
}

export interface UrbaneBoltManifestSuccessEntry {
  status: string;
  orderNumber: string;
  /** Returned as a JSON number, e.g. 200000007359. */
  awbNumber: number;
  routeCode?: string;
  shippingLabel?: string;
  customerCode?: string;
}

export interface UrbaneBoltManifestErrorEntry {
  orderNumber?: string;
  customerCode?: string;
  status?: string;
  message?: string;
}

/**
 * Note: UrbaneBolt answers HTTP 200 even when an item fails — per-item outcomes
 * live in `errorResponse`. The adapter is responsible for turning that into a
 * real error rather than a silent success.
 */
export interface UrbaneBoltManifestResponse {
  status: string;
  successResponse?: UrbaneBoltManifestSuccessEntry[];
  errorResponse?: UrbaneBoltManifestErrorEntry[];
}

// ---------------------------------------------------------------------------
// GET /api/v1/services/tracking-pub/?awb=
// ---------------------------------------------------------------------------

export interface UrbaneBoltScan {
  /** "17 Aug 2026, 21:41" */
  statusDateTime: string;
  statusCode: string;
  statusCodeDescription: string;
  reasonCode?: string;
  reasonCodeDescription?: string;
  currentLocation?: string;
}

export interface UrbaneBoltTrackingData {
  awbNumber: number;
  orderNumber: string;
  pieces?: number;
  /** "17 Aug 2026" */
  addedOn?: string;
  invoiceDate?: string;
  invoiceNumber?: string;
  remarks?: string | null;
  shipperName?: string;
  origin?: string;
  destination?: string;
  currentLocation?: string;
  /** YYYY-MM-DD */
  edd?: string;
  currentStatusDateTime?: string;
  currentStatusCode: string;
  currentStatusCodeDescription?: string;
  currentReasonCode?: string;
  currentReasonCodeDescription?: string;
  isRto?: boolean;
  weight?: number;
  referenceAwb?: string | null;
  lat?: number;
  lng?: number;
  productType?: string;
  scans?: UrbaneBoltScan[];
}

/** On "Data Not Found" the API returns status "Failed" and `data: []`. */
export interface UrbaneBoltTrackingResponse {
  status: string;
  message?: string;
  data?: UrbaneBoltTrackingData | unknown[];
}

// ---------------------------------------------------------------------------
// POST /api/v1/services/cancel/
// ---------------------------------------------------------------------------

export interface UrbaneBoltCancelRequest {
  /** Comma-separated AWB list. */
  awbs: string;
}

export interface UrbaneBoltCancelEntry {
  orderNumber?: string;
  awb?: string;
  message?: string;
}

export interface UrbaneBoltCancelResponse {
  status: string;
  message?: string;
  successResponse?: UrbaneBoltCancelEntry[];
  failureResponse?: UrbaneBoltCancelEntry[];
}

// ---------------------------------------------------------------------------
// GET /api/v1/location/pincodes/?pincodes=
// ---------------------------------------------------------------------------

export interface UrbaneBoltPincodeEntry {
  id: number;
  pincode: number;
  inbound: boolean;
  outbound: boolean;
  rtn: boolean;
  isActive: boolean;
  serviceCenter?: string;
  city?: string;
  state?: string;
  region?: string;
  zone?: string;
  routeCode?: string;
  /** Comma-separated tiers, e.g. "SDD,NDD,ATA,PTP,2HR". */
  serviceType?: string;
}

export interface UrbaneBoltPincodeResponse {
  status: string;
  message?: string;
  data?: UrbaneBoltPincodeEntry[];
  errorPincodes?: unknown[];
}
