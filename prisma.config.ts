/**
 * Prisma CLI configuration (Prisma 7).
 *
 * - The CLI does not load .env files by itself in Prisma 7, so we load `.env.local`
 *   then `.env` here (values already present in the process environment win).
 * - `DATABASE_URL` is read lazily: commands that need no database (`generate`, `validate`)
 *   work without it. `migrate deploy` / `db seed` fail with a clear message when it is unset.
 * - When it (or SHADOW_DATABASE_URL) is set, it must match NAZIR_RUNTIME_ENV (src/server/config/prisma-cli-guard.ts): a `*_test` database only with
 *   NAZIR_RUNTIME_ENV=test, and never a non-test database with it. A missing/unknown NAZIR_RUNTIME_ENV counts as production.
 * - Shared environments must only use `prisma migrate deploy` (never `db push`;
 *   DATABASE.md §14.1, CLAUDE_HANDOFF §8).
 */
import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";
import { assertPrismaCliDatabase } from "./src/server/config/prisma-cli-guard";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

// Before any command runs: DATABASE_URL and SHADOW_DATABASE_URL must belong to NAZIR_RUNTIME_ENV (test <=> *_test; missing
// env => production) and must not be the same database. Nothing happens when they are unset, so `prisma validate` /
// `prisma generate` are unaffected.
assertPrismaCliDatabase(process.env);

const url = process.env.DATABASE_URL;
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  // An empty string makes commands that need a database fail with a connection error
  // instead of silently connecting somewhere unintended.
  datasource: { url: url ?? "", ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}) },
});
