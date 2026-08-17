/**
 * The complete, closed set of error codes this platform emits. Courier-specific
 * error strings are mapped onto these before they ever reach a client, so the
 * unified API surface stays stable no matter which courier is behind it.
 */
export const ErrorCode = {
  /** Request body/params failed schema validation. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** `courier_partner` is not a registered/enabled courier. */
  UNSUPPORTED_COURIER: 'UNSUPPORTED_COURIER',
  /** Referenced order / batch does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** Order already exists with the same client-supplied order_id. */
  DUPLICATE_ORDER: 'DUPLICATE_ORDER',
  /** Operation is not legal for the order's current state (e.g. cancel a delivered shipment). */
  INVALID_STATE: 'INVALID_STATE',

  /** Courier rejected the payload (its 4xx / per-item failure). */
  COURIER_REJECTED: 'COURIER_REJECTED',
  /** Destination/origin not serviceable by the courier. */
  COURIER_NOT_SERVICEABLE: 'COURIER_NOT_SERVICEABLE',
  /** Courier credentials were rejected even after a re-authentication attempt. */
  COURIER_AUTH_FAILED: 'COURIER_AUTH_FAILED',
  /** Courier returned 5xx, or the call timed out / failed at the network layer. */
  COURIER_UNAVAILABLE: 'COURIER_UNAVAILABLE',
  /** Courier answered, but with a shape we cannot parse into our domain model. */
  COURIER_BAD_RESPONSE: 'COURIER_BAD_RESPONSE',

  /** Anything we failed to classify. Always accompanied by a logged stack trace. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** HTTP status each error code maps to at the edge. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNSUPPORTED_COURIER: 400,
  NOT_FOUND: 404,
  DUPLICATE_ORDER: 409,
  INVALID_STATE: 409,
  COURIER_REJECTED: 422,
  COURIER_NOT_SERVICEABLE: 422,
  COURIER_AUTH_FAILED: 502,
  COURIER_UNAVAILABLE: 503,
  COURIER_BAD_RESPONSE: 502,
  INTERNAL_ERROR: 500,
};

/**
 * Codes worth retrying with backoff. Everything else is a deterministic
 * failure — retrying a rejected payload just burns the courier's rate limit.
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.COURIER_UNAVAILABLE,
]);
