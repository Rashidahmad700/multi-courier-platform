import { Router } from 'express';
import { bulkCreateSchema, batchRefSchema, createOrderSchema, orderRefSchema } from '../dto/order.dto';
import type { CourierRegistry } from '../couriers/courier.registry';
import { validate } from '../middleware/validate';
import type { OrderController } from './order.controller';
import { success } from './presenters';

export function buildRouter(controller: OrderController, registry: CourierRegistry): Router {
  const router = Router();

  /** Discovery: what `courier_partner` values this deployment accepts. */
  router.get('/couriers', (req, res) => {
    res.status(200).json(
      success(
        {
          couriers: registry.list().map((name) => {
            const adapter = registry.get(name);
            return {
              courier_partner: adapter.name,
              capabilities: {
                serviceability: adapter.capabilities.serviceability,
                shipping_label: adapter.capabilities.shippingLabel,
                cancellation: adapter.capabilities.cancellation,
              },
            };
          }),
        },
        req.requestId,
      ),
    );
  });

  // Bulk routes are declared before the parameterised order routes so that
  // "bulk" can never be swallowed as an :order_id.
  router.post('/orders/bulk', validate(bulkCreateSchema), controller.createBulk);
  router.get('/orders/bulk/:batch_id', validate(batchRefSchema, 'params'), controller.getBatch);

  router.post('/orders', validate(createOrderSchema), controller.createOrder);
  router.get('/orders/:order_id/track', validate(orderRefSchema, 'params'), controller.trackOrder);
  router.post('/orders/:order_id/cancel', validate(orderRefSchema, 'params'), controller.cancelOrder);

  return router;
}
