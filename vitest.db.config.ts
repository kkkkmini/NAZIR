import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Same convenience as prisma.config.ts: `cp .env.example .env.local` is enough. Variables already
// present in the environment (e.g. CI) win.
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

// Schema contract / migration tests (TEST_PLAN §2) against a REAL PostgreSQL server.
// Requires TEST_DATABASE_URL (see README "Database"). Never skipped silently: global setup fails loudly.
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: { "server-only": fileURLToPath(new URL("./tests/contract/schema/helpers/server-only-stub.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/contract/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/contract/schema/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
