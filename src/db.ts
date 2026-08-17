import mongoose from 'mongoose';
import { config } from './config';
import { logger } from './utils/logger';
// Side-effect import: registers every model so `syncIndexes` below covers all.
import './models';

export async function connectDatabase(uri: string = config.mongo.uri): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    ...(config.mongo.dbName ? { dbName: config.mongo.dbName } : {}),
    serverSelectionTimeoutMS: 10_000,
  });
  // Indexes carry correctness weight here — the unique index on orders.orderId
  // is what makes idempotency real — so we wait for them before serving.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).syncIndexes()));
  logger.info({ db: mongoose.connection.name }, 'connected to MongoDB');
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
