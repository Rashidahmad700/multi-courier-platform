/** Valid unified-API payloads, used across the integration tests. */
export function orderPayload(
  orderId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    courier_partner: 'mock',
    order_id: orderId,
    payment_mode: 'PREPAID',
    cod_amount: 0,
    declared_value: 1500,
    currency: 'INR',
    pieces: 1,
    pickup_address: {
      name: 'Acme Warehouse',
      address_line: 'Plot 12, Industrial Area Phase II',
      city: 'Gurgaon',
      state: 'Haryana',
      pincode: '122017',
      country: 'INDIA',
      phone: '9425018023',
      email: 'warehouse@acme.test',
      address_type: 'Seller',
    },
    delivery_address: {
      name: 'Priya Menon',
      address_line: '26-27 Om Nagar Society, Sumbhal',
      city: 'Gurgaon',
      state: 'Haryana',
      pincode: '122001',
      country: 'INDIA',
      phone: '8320226438',
      email: 'priya@example.test',
      address_type: 'Home',
    },
    dimensions: { length_cm: 12, breadth_cm: 10, height_cm: 10, weight_kg: 1.1 },
    items: [{ description: 'Paperback books', quantity: 2, value: 750, sku: 'BK-001' }],
    invoice_number: 'INV-0002',
    invoice_date: '2026-08-17',
    ...overrides,
  };
}
