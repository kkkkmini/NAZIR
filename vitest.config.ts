import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Unit tests only: no database needed (`npm test`). Schema contract tests need a real
// PostgreSQL and live in vitest.db.config.ts (`npm run test:db`).
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
