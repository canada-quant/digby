// Prisma 7 configuration — connection URL lives here now (schema datasource
// blocks no longer accept `url`). The CLI does not auto-load .env in v7, so
// load it explicitly; app runtime gets DATABASE_URL from src/config/env.ts.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // '' keeps `prisma generate` working in fresh containers without .env;
    // migrate/db commands then fail with P1001 instead of v6's env-var error.
    url: process.env.DATABASE_URL ?? '',
  },
});
