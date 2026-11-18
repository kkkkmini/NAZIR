import { describe, expect, it } from "vitest";
import { DatabaseConfigError } from "../../src/server/config/database-config";
import { assertPrismaCliDatabase } from "../../src/server/config/prisma-cli-guard";

const DEV = "postgresql://nazir:s3cret@localhost:5432/nazir_dev";
const TEST = "postgresql://nazir:s3cret@localhost:5432/nazir_test";

describe("assertPrismaCliDatabase (prisma.config.ts guard)", () => {
  it.each([
    ["local", DEV],
    ["test", TEST],
    ["staging", DEV],
    ["production", DEV],
  ])("allows NAZIR_RUNTIME_ENV=%s with %s", (env, url) => {
    expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: env, DATABASE_URL: url })).toMatchObject({ database: url.endsWith("_test") ? "nazir_test" : "nazir_dev" });
  });

  it.each([
    ["test", DEV, /requires a database whose name ends with "_test"/],
    ["local", TEST, /must not be used with NAZIR_RUNTIME_ENV=local/],
    ["staging", TEST, /must not be used with NAZIR_RUNTIME_ENV=staging/],
    ["production", TEST, /must not be used with NAZIR_RUNTIME_ENV=production/],
  ])("refuses NAZIR_RUNTIME_ENV=%s with %s", (env, url, message) => {
    expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: env, DATABASE_URL: url })).toThrow(message);
    expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: env, DATABASE_URL: url })).toThrow(DatabaseConfigError);
  });

  it.each([
    ["missing", {}],
    ["blank", { NAZIR_RUNTIME_ENV: "  " }],
    ["unknown", { NAZIR_RUNTIME_ENV: "prod" }],
  ])("a %s NAZIR_RUNTIME_ENV is production: a test database is refused and says why, a normal database is allowed", (_label, env) => {
    expect(() => assertPrismaCliDatabase({ ...env, DATABASE_URL: TEST })).toThrow(/must not be used with NAZIR_RUNTIME_ENV=production.*production was assumed/);
    expect(assertPrismaCliDatabase({ ...env, DATABASE_URL: DEV })).toMatchObject({ database: "nazir_dev" });
  });

  it.each([undefined, "", "   "])("does nothing when DATABASE_URL is unset or blank (%j): validate / generate keep working", (value) => {
    expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: value })).toBeNull();
    expect(assertPrismaCliDatabase({ DATABASE_URL: value })).toBeNull();
  });

  it("does not look at SHADOW_DATABASE_URL (it is passed through unchanged)", () => {
    expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: TEST, SHADOW_DATABASE_URL: DEV })).toMatchObject({ database: "nazir_test" });
  });

  it("never echoes the password", () => {
    for (const env of ["test", "local"]) {
      try {
        assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: env, DATABASE_URL: env === "test" ? DEV : TEST });
      } catch (e) {
        expect((e as Error).message).not.toContain("s3cret");
      }
    }
  });
});
