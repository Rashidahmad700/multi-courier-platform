import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';
import { logFailure } from '../utils/logger';
import { toFieldErrors } from './validate';

/**
 * The single place an error becomes an HTTP response. Guarantees:
 *  - one normalized JSON error shape for every endpoint,
 *  - the courier's raw error is logged, never serialised to the client,
 *  - every failure log line carries request_id, error_type and a stack trace.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const appError = normalise(error);

  logFailure(
    {
      request_id: req.requestId,
      order_id: extractOrderId(req),
      courier_partner: extractCourier(req),
      error_type: appError.code,
      method: req.method,
      path: req.originalUrl,
      http_status: appError.httpStatus,
      // The courier's own error body — captured here and nowhere else.
      courier_raw: appError.raw ?? null,
    },
    appError,
    'request failed',
  );

  res.status(appError.httpStatus).json(appError.toClientJSON(req.requestId));
}

/** 404 for unmatched routes, in the same normalized shape. */
export function notFoundHandler(req: Request, res: Response): void {
  const error = AppError.notFound(`Route ${req.method} ${req.originalUrl}`);
  res.status(error.httpStatus).json(error.toClientJSON(req.requestId));
}

function normalise(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return AppError.validation('Request validation failed.', toFieldErrors(error));
  }
  // Express' JSON body parser signals malformed JSON this way.
  if (isBodyParserError(error)) {
    return AppError.validation('Request body is not valid JSON.', [
      { field: 'body', message: 'malformed JSON' },
    ]);
  }
  return new AppError(
    ErrorCode.INTERNAL_ERROR,
    'An unexpected error occurred. The incident has been logged.',
    { cause: error, raw: error },
  );
}

function isBodyParserError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as { type?: string }).type === 'entity.parse.failed'
  );
}

function extractOrderId(req: Request): string | undefined {
  const fromParams = (req.params as Record<string, string> | undefined)?.order_id;
  const fromBody = (req.body as { order_id?: unknown } | undefined)?.order_id;
  return fromParams ?? (typeof fromBody === 'string' ? fromBody : undefined);
}

function extractCourier(req: Request): string | undefined {
  const value = (req.body as { courier_partner?: unknown } | undefined)?.courier_partner;
  return typeof value === 'string' ? value : undefined;
}
