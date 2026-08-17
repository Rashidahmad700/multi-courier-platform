import type { Express } from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../../src/app';
import { buildContainer, type Container } from '../../src/container';
import { CourierRegistry } from '../../src/couriers/courier.registry';
import { MockCourierAdapter } from '../../src/couriers/mock/mock.adapter';
import { connectDatabase, disconnectDatabase } from '../../src/db';
import type { ICourierAdapter } from '../../src/couriers/courier.interface';

export interface TestHarness {
  app: Express;
  container: Container;
  registry: CourierRegistry;
  mock: MockCourierAdapter;
  stop: () => Promise<void>;
  reset: () => Promise<void>;
}

/**
 * Boots an in-memory MongoDB and a fully wired app whose courier registry
 * contains only deterministic, network-free adapters. Tests therefore exercise
 * the real HTTP layer, real Mongoose models and real services — everything
 * except the courier's network.
 */
export async function startTestHarness(
  extraCouriers: Record<string, ICourierAdapter> = {},
): Promise<TestHarness> {
  const mongod = await MongoMemoryServer.create();
  await connectDatabase(mongod.getUri());

  const mock = new MockCourierAdapter({ latencyMs: 0, failPincode: '000000' });
  const registry = new CourierRegistry();
  registry.register('mock', () => mock);
  for (const [name, adapter] of Object.entries(extraCouriers)) {
    registry.register(name, () => adapter);
  }

  const container = buildContainer(registry);
  const app = createApp(container);

  return {
    app,
    container,
    registry,
    mock,
    async reset() {
      const collections = await mongoose.connection.db!.collections();
      await Promise.all(collections.map((collection) => collection.deleteMany({})));
    },
    async stop() {
      await disconnectDatabase();
      await mongod.stop();
    },
  };
}
