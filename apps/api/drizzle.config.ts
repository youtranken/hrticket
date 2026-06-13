import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/infra/db/schema/index.ts',
  out: './src/infra/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://hris:hris@localhost:5432/hris',
  },
});
