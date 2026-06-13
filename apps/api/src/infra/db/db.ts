import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

/**
 * RAW DB handle. Importing this anywhere except with-actor.ts is an ESLint error
 * (architecture invariant #1). All access must go through withActor().
 *
 * The pool is created LAZILY on first use, not at import, so DATABASE_URL is read
 * when the first query runs — not whenever this module first loads. This matters
 * for the integration harness: a test file's top-level `import AppModule` pulls in
 * this module before beforeAll points DATABASE_URL at the throwaway Testcontainers
 * DB; eager binding would have captured the default (localhost) URL and silently
 * run the whole suite against the dev database.
 */
type Sql = ReturnType<typeof postgres>;
type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let _sql: Sql | undefined;
let _db: DrizzleDb | undefined;

function ensure(): void {
  if (!_sql) {
    const connectionString =
      process.env.DATABASE_URL ?? 'postgres://hris:hris@localhost:5432/hris';
    // max connections: keep room for web concurrency + worker.
    _sql = postgres(connectionString, { max: 10 });
    _db = drizzle(_sql, { schema });
  }
}

function lazyMember(get: () => object, prop: PropertyKey): unknown {
  ensure();
  const target = get();
  const value = Reflect.get(target, prop);
  return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
}

// `sql` is callable (tagged template) AND has methods (.end, .unsafe…) → function-target proxy.
export const sql: Sql = new Proxy(function () {} as unknown as Sql, {
  apply(_t, _thisArg, args) {
    ensure();
    return (_sql as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get: (_t, prop) => lazyMember(() => _sql as object, prop),
}) as Sql;

export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get: (_t, prop) => lazyMember(() => _db as object, prop),
}) as DrizzleDb;

export type Db = DrizzleDb;
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
