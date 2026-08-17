import type { NextFunction, Request, Response } from 'express';
import {
  bulkCreateSchema,
  createOrderSchema,
  toBulkOrderInputs,
  toUnifiedShipmentRequest,
  type BulkCreateDto,
  type CreateOrderDto,
} from '../dto/order.dto';
import type { BulkService } from '../services/bulk.service';
import type { OrderService } from '../services/order.service';
import { presentBatch, presentOrder, presentTracking, success } from './presenters';

/**
 * HTTP edge. Contains no courier knowledge whatsoever — it forwards
 * `courier_partner` straight through to the service layer, which is what lets
 * a new courier ship without touching this file (requirement 3.2).
 */
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly bulkService: BulkService,
  ) {}

  createOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dto = req.body as CreateOrderDto;
      const result = await this.orderService.createOrder(
        dto.courier_partner,
        toUnifiedShipmentRequest(dto),
        { requestId: req.requestId },
      );

      // 200 (not 201) on an idempotent replay: nothing new was created.
      res.status(result.idempotentReplay ? 200 : 201).json(
        success(
          { ...presentOrder(result.order), idempotent_replay: result.idempotentReplay },
          req.requestId,
        ),
      );
    } catch (error) {
      next(error);
    }
  };

  trackOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { order_id: orderRef } = req.params as { order_id: string };
      const { order, events } = await this.orderService.trackOrder(orderRef, {
        requestId: req.requestId,
      });
      res.status(200).json(success(presentTracking(order, events), req.requestId));
    } catch (error) {
      next(error);
    }
  };

  cancelOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { order_id: orderRef } = req.params as { order_id: string };
      const order = await this.orderService.cancelOrder(orderRef, { requestId: req.requestId });
      res.status(200).json(success(presentOrder(order), req.requestId));
    } catch (error) {
      next(error);
    }
  };

  createBulk = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dto = req.body as BulkCreateDto;
      const batch = await this.bulkService.submit(toBulkOrderInputs(dto), req.requestId);

      // 202: accepted and durably queued; poll the batch endpoint for outcomes.
      res.status(202).json(
        success(
          {
            ...presentBatch(batch),
            status_url: `/api/v1/orders/bulk/${batch.batchId}`,
          },
          req.requestId,
        ),
      );
    } catch (error) {
      next(error);
    }
  };

  getBatch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { batch_id: batchId } = req.params as { batch_id: string };
      const batch = await this.bulkService.getBatch(batchId);
      res.status(200).json(success(presentBatch(batch), req.requestId));
    } catch (error) {
      next(error);
    }
  };
}

export const orderSchemas = { createOrderSchema, bulkCreateSchema };
