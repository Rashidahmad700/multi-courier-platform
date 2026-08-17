import { z } from 'zod';
import { config } from '../config';
import type { BulkOrderInput } from '../services/bulk.service';
import type { Address, UnifiedShipmentRequest } from '../domain/unified.types';

/**
 * The unified, courier-agnostic request contract.
 *
 * These DTOs never change when a courier is added — that is the whole point of
 * requirement 3.2. `courier_partner` is validated as a non-empty string here
 * and resolved against the registry in the service layer, so the schema has no
 * knowledge of which couriers exist.
 */

const pincodeSchema = z
  .string()
  .trim()
  .regex(/^\d{4,10}$/, 'must be 4-10 digits');

const phoneSchema = z
  .string()
  .trim()
  .regex(/^[+]?[\d\s-]{7,15}$/, 'must be a valid phone number');

const addressSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address_line: z.string().trim().min(1).max(500),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().min(1).max(80),
  pincode: pincodeSchema,
  country: z.string().trim().min(1).max(80).default('INDIA'),
  phone: phoneSchema,
  email: z.string().trim().email().max(200).optional(),
  address_type: z.string().trim().max(40).optional(),
});

const dimensionsSchema = z.object({
  length_cm: z.number().positive().max(500),
  breadth_cm: z.number().positive().max(500),
  height_cm: z.number().positive().max(500),
  weight_kg: z.number().positive().max(1000),
});

const itemSchema = z.object({
  description: z.string().trim().min(1).max(250),
  quantity: z.number().int().positive().max(10_000),
  value: z.number().nonnegative(),
  sku: z.string().trim().max(80).optional(),
  hsn_code: z.string().trim().max(20).optional(),
});

export const createOrderSchema = z
  .object({
    courier_partner: z.string().trim().min(1, 'courier_partner is required'),
    order_id: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/, 'may contain letters, digits, hyphen and underscore only'),
    payment_mode: z.enum(['PREPAID', 'COD']),
    cod_amount: z.number().nonnegative().default(0),
    declared_value: z.number().nonnegative(),
    currency: z.string().trim().length(3).default('INR'),
    pieces: z.number().int().positive().max(100).default(1),
    service_type: z.string().trim().max(20).optional(),
    invoice_number: z.string().trim().max(80).optional(),
    invoice_date: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
      .optional(),
    pickup_address: addressSchema,
    delivery_address: addressSchema,
    /** Defaults to the pickup address when omitted. */
    return_address: addressSchema.optional(),
    dimensions: dimensionsSchema,
    items: z.array(itemSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.payment_mode === 'COD' && value.cod_amount <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cod_amount'],
        message: 'must be greater than 0 for COD orders',
      });
    }
    if (value.payment_mode === 'PREPAID' && value.cod_amount !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cod_amount'],
        message: 'must be 0 for PREPAID orders',
      });
    }
  });

export type CreateOrderDto = z.infer<typeof createOrderSchema>;

export const bulkCreateSchema = z
  .object({
    orders: z.array(createOrderSchema).min(1).max(config.bulk.maxOrders),
  })
  .strict();

export type BulkCreateDto = z.infer<typeof bulkCreateSchema>;

export const orderRefSchema = z.object({
  order_id: z.string().trim().min(1).max(120),
});

export const batchRefSchema = z.object({
  batch_id: z.string().trim().min(1).max(120),
});

// ---------------------------------------------------------------------------
// DTO -> domain
// ---------------------------------------------------------------------------

export function toUnifiedShipmentRequest(dto: CreateOrderDto): UnifiedShipmentRequest {
  const pickup = toAddress(dto.pickup_address);
  return {
    orderId: dto.order_id,
    paymentMode: dto.payment_mode,
    codAmount: dto.cod_amount,
    declaredValue: dto.declared_value,
    currency: dto.currency,
    pickup,
    delivery: toAddress(dto.delivery_address),
    returnAddress: dto.return_address ? toAddress(dto.return_address) : pickup,
    dimensions: {
      lengthCm: dto.dimensions.length_cm,
      breadthCm: dto.dimensions.breadth_cm,
      heightCm: dto.dimensions.height_cm,
      weightKg: dto.dimensions.weight_kg,
    },
    pieces: dto.pieces,
    items: dto.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      value: item.value,
      ...(item.sku ? { sku: item.sku } : {}),
      ...(item.hsn_code ? { hsnCode: item.hsn_code } : {}),
    })),
    ...(dto.invoice_number ? { invoiceNumber: dto.invoice_number } : {}),
    ...(dto.invoice_date ? { invoiceDate: dto.invoice_date } : {}),
    ...(dto.service_type ? { serviceType: dto.service_type } : {}),
  };
}

export function toBulkOrderInputs(dto: BulkCreateDto): BulkOrderInput[] {
  return dto.orders.map((order) => ({
    courierPartner: order.courier_partner,
    order: toUnifiedShipmentRequest(order),
  }));
}

function toAddress(dto: z.infer<typeof addressSchema>): Address {
  return {
    name: dto.name,
    addressLine: dto.address_line,
    city: dto.city,
    state: dto.state,
    pincode: dto.pincode,
    country: dto.country,
    phone: dto.phone,
    ...(dto.email ? { email: dto.email } : {}),
    ...(dto.address_type ? { addressType: dto.address_type } : {}),
  };
}
