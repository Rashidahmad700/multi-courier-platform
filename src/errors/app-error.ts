import { ErrorCode, ERROR_HTTP_STATUS, RETRYABLE_ERROR_CODES } from './error-codes';

export interface FieldError {
  field: string;
  message: string;
}

export interface AppErrorOptions {
  /** Field-level detail, surfaced to the client for validation failures only. */
  fields?: FieldError[];
  /** Extra safe-to-expose context, e.g. the list of supported couriers. */
  details?: Record<string, unknown>;
  /**
   * The courier's own raw error. Logged, persisted for reconciliation, and
   * NEVER serialised into a client response.
   */
  raw?: unknown;
  cause?: unknown;
  /** Override the default retryability implied by the code. */
  retryable?: boolean;
}

/**
 * The single error type that crosses layer boundaries. Adapters translate
 * courier failures into this; the error middleware is the only place that
 * turns it into an HTTP response.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly fields?: FieldError[];
  readonly details?: Record<string, unknown>;
  readonly raw?: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
    this.fields = options.fields;
    this.details = options.details;
    this.raw = options.raw;
    this.retryable = options.retryable ?? RETRYABLE_ERROR_CODES.has(code);
    Error.captureStackTrace?.(this, AppError);
  }

  static validation(message: string, fields: FieldError[] = []): AppError {
    return new AppError(ErrorCode.VALIDATION_ERROR, message, { fields });
  }

  static unsupportedCourier(courier: string, supported: string[]): AppError {
    return new AppError(
      ErrorCode.UNSUPPORTED_COURIER,
      `Unsupported courier_partner "${courier}".`,
      { details: { supported_couriers: supported } },
    );
  }

  static notFound(what: string): AppError {
    return new AppError(ErrorCode.NOT_FOUND, `${what} not found.`);
  }

  /** Wrap anything thrown into an AppError without losing the original. */
  static from(err: unknown): AppError {
    if (err instanceof AppError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new AppError(ErrorCode.INTERNAL_ERROR, message, { cause: err, raw: err });
  }

  /** Client-safe projection. Note: `raw` is deliberately absent. */
  toClientJSON(requestId: string): {
    success: false;
    error: {
      code: ErrorCode;
      message: string;
      fields?: FieldError[];
      details?: Record<string, unknown>;
    };
    request_id: string;
  } {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields?.length ? { fields: this.fields } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
      request_id: requestId,
    };
  }
}
