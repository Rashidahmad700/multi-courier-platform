import express, { type Express } from 'express';
import mongoose from 'mongoose';
import { buildRouter } from './api/routes';
import { success } from './api/presenters';
import type { Container } from './container';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestId } from './middleware/request-id';

export function createApp(container: Container): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' })); // 100 orders of normalized payload
  app.use(requestId);

  app.get('/health', (req, res) => {
    const dbState = mongoose.connection.readyState; // 1 = connected
    res.status(dbState === 1 ? 200 : 503).json(
      success(
        {
          status: dbState === 1 ? 'ok' : 'degraded',
          database: dbState === 1 ? 'connected' : 'disconnected',
          couriers: container.registry.list(),
          uptime_s: Math.round(process.uptime()),
        },
        req.requestId,
      ),
    );
  });

  app.use('/api/v1', buildRouter(container.controller, container.registry));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
