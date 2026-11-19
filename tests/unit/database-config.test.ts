import { describe, expect, it } from "vitest";
import {
  DatabaseConfigError,
  assertDatabaseMatchesEnv,
  describeDatabase,
  parseDatabaseUrl,
} from "../../src/server/config/database-config";
import { SeedNotAllowedError, assertDevSeedAllowed } from "../../src/server/db/seed-guard";

const DEV = "postgresql://nazir:s3cret@localhost:5432/nazir_dev";
const TEST = "postgresql://nazir:s3cret@localhost:5432/nazir_test";

describe("parseDatabaseUrl", () => {
  it("extracts non-secret parts and recognises *_test databases", () => {
    expect(parseDatabaseUrl(DEV)).toEqual({ host: "localhost", port: "5432", database: "nazir_dev", user: "nazir", isTestDatabase: false });
    expect(parseDatabaseUrl(TEST).isTestDatabase).toBe(true);
    expect(parseDatabaseUrl("postgres://u@h/db").port).toBe("5432");
  });

  it.each([undefined, "", "   "])("rejects a missing URL (%j)", (v) => {
    expect(() => parseDatabaseUrl(v)).toThrow(DatabaseConfigError);
  });

  it("rejects non-postgres URLs and URLs without a database, never echoing the password", () => {
    expect(() => parseDatabaseUrl("mysql://u:s3cret@h/db")).toThrow(/postgresql/);
    expect(() => parseDatabaseUrl("postgresql://u:s3cret@h")).toThrow(/name a database/);
    try {
      parseDatabaseUrl("not a url with s3cret");
    } catch (e) {
      expect((e as Error).message).not.toContain("s3cret");
    }
  });

  it("describeDatabase never contains credentials", () => {
    expect(JSON.stringify(describeDatabase(parseDatabaseUrl(DEV)))).not.toContain("s3cret");
  });
});

describe("assertDatabaseMatchesEnv (dev / test / shared separation)", () => {
  it("test environment only accepts *_test databases", () => {
    expect(assertDatabaseMatchesEnv("test", TEST).database).toBe("nazir_test");
    expect(() => assertDatabaseMatchesEnv("test", DEV)).toThrow(/requires a database whose name ends with "_test"/);
  });

  it.each(["local", "staging", "production"] as const)("%s refuses a *_test database", (env) => {
    expect(() => assertDatabaseMatchesEnv(env, TEST)).toThrow(/must not be used/);
    expect(assertDatabaseMatchesEnv(env, DEV).database).toBe("nazir_dev");
  });

  it("requires DATABASE_URL", () => {
    expect(() => assertDatabaseMatchesEnv("local", undefined)).toThrow(/DATABASE_URL is not set/);
  });
});

describe("assertDevSeedAllowed", () => {
  it("allows local with a dev database and test with a test database", () => {
    expect(assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV }).runtimeEnv).toBe("local");
    expect(assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: TEST }).runtimeEnv).toBe("test");
  });

  it.each([
    ["production", { NAZIR_RUNTIME_ENV: "production", DATABASE_URL: DEV }],
    ["staging", { NAZIR_RUNTIME_ENV: "staging", DATABASE_URL: DEV }],
    ["missing env => production", { DATABASE_URL: DEV }],
    ["unknown env => production", { NAZIR_RUNTIME_ENV: "prod", DATABASE_URL: DEV }],
  ])("refuses %s", (_label, env) => {
    expect(() => assertDevSeedAllowed(env)).toThrow(SeedNotAllowedError);
  });

  it("refuses mismatched database/environment pairs", () => {
    expect(() => assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: TEST })).toThrow(DatabaseConfigError);
    expect(() => assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: DEV })).toThrow(DatabaseConfigError);
    expect(() => assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "local" })).toThrow(/DATABASE_URL is not set/);
  });
});
