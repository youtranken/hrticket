import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

/**
 * RAW DB handle. Importing this anywhere except with-actor.ts is an ESLint error
 * (architecture invariant #1). All access must go through withActor().
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgres://hris:hris@localhost:5432/hris';

// max connections: keep room for web concurrency + worker (blocking #5 from validation).
export const sql = postgres(connectionString, { max: 10 });

export const db = drizzle(sql, { schema });

export type Db = typeof db;
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
