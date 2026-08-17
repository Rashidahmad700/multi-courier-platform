import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError, type FieldError } from '../errors/app-error';

export type ValidationTarget = 'body' | 'params' | 'query';

/**
 * Schema validation at the trust boundary. Parsed output replaces the raw
 * input, so downstream code only ever sees data that matched the schema.
 */
export function validate<S extends ZodTypeAny>(schema: S, target: ValidationTarget = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      next(AppError.validation('Request validation failed.', toFieldErrors(result.error)));
      return;
    }
    // `req.query`/`req.params` are getter-only on some Express versions.
    Object.defineProperty(req, target, { value: result.data as z.infer<S>, writable: true });
    next();
  };
}

export function toFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}
