/**
 * Prisma CLI configuration (Prisma 7).
 *
 * - The CLI does not load .env files by itself in Prisma 7, so we load `.env.local`
 *   then `.env` here (values already present in the process environment win).
 * - `DATABASE_URL` is read lazily: commands that need no database (`generate`, `validate`)
 *   work without it. `migrate deploy` / `db seed` fail with a clear message when it is unset.
 * - Shared environments must only use `prisma migrate deploy` (never `db push`;
 *   DATABASE.md §14.1, CLAUDE_HANDOFF §8).
 */
import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

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
