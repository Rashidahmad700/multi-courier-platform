import { OrderController } from './api/order.controller';
import { courierRegistry } from './couriers';
import type { CourierRegistry } from './couriers/courier.registry';
import { BulkWorker } from './queue/bulk.worker';
import { jobQueue } from './queue/job.queue';
import { BulkService } from './services/bulk.service';
import { OrderService } from './services/order.service';

/**
 * Composition root. Wiring lives here rather than inside modules so tests can
 * build a container with a substituted registry (e.g. mock courier only)
 * without touching production code.
 */
export interface Container {
  registry: CourierRegistry;
  orderService: OrderService;
  bulkService: BulkService;
  controller: OrderController;
  worker: BulkWorker;
}

export function buildContainer(registry: CourierRegistry = courierRegistry): Container {
  const orderService = new OrderService(registry);
  const bulkService = new BulkService(orderService, jobQueue);
  const controller = new OrderController(orderService, bulkService);
  const worker = new BulkWorker(bulkService, jobQueue);

  return { registry, orderService, bulkService, controller, worker };
}
