import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Every request carries a correlation id, echoed back in the response and
 * stamped on every log line and every persisted failure (requirement 3.5).
 * An inbound `X-Request-Id` is honoured so a caller's trace id survives.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-request-id');
  req.requestId = inbound && inbound.length <= 120 ? inbound : `req_${randomUUID()}`;
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
