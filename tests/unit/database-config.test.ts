import { describe, expect, it } from "vitest";
import {
  DatabaseConfigError,
  assertDatabaseMatchesEnv,
  assertRuntimeDatabaseConfig,
  canonicalDatabaseHost,
  describeDatabase,
  isSameDatabase,
  parseDatabaseUrl,
  selectDirectDatabaseUrl,
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

// ── Neon pooled / direct pair (DB-04) ──────────────────────────────────────────────────────────────────────────────
// Host names are made-up examples in Neon's format; the password is a fake.
const NEON_DIRECT = "postgresql://nazir:s3cret@ep-quiet-sun-a1b2c3d4.ap-southeast-1.aws.neon.tech/nazir_preview_test?sslmode=require";
const NEON_POOLED = "postgresql://nazir:s3cret@ep-quiet-sun-a1b2c3d4-pooler.ap-southeast-1.aws.neon.tech/nazir_preview_test?sslmode=require";
const info = (url: string) => parseDatabaseUrl(url);

describe("DB-04 canonicalDatabaseHost / isSameDatabase (Neon pooler-aware)", () => {
  it.each([
    ["ep-quiet-sun-a1b2c3d4-pooler.ap-southeast-1.aws.neon.tech", "ep-quiet-sun-a1b2c3d4.ap-southeast-1.aws.neon.tech"],
    ["EP-QUIET-SUN-A1B2C3D4-POOLER.AP-SOUTHEAST-1.AWS.NEON.TECH", "ep-quiet-sun-a1b2c3d4.ap-southeast-1.aws.neon.tech"],
    ["ep-quiet-sun-a1b2c3d4.ap-southeast-1.aws.neon.tech", "ep-quiet-sun-a1b2c3d4.ap-southeast-1.aws.neon.tech"],
    ["127.0.0.1", "localhost"],
    // only Neon hosts, and only the endpoint label, lose "-pooler"
    ["db-pooler.example.com", "db-pooler.example.com"],
    ["ep-x.ap-southeast-1-pooler.aws.neon.tech", "ep-x.ap-southeast-1-pooler.aws.neon.tech"],
    ["-pooler.neon.tech", "-pooler.neon.tech"],
  ])("%s → %s", (host, canonical) => {
    expect(canonicalDatabaseHost(host)).toBe(canonical);
  });

  it("a Neon pooled URL and its direct URL are the same database", () => {
    expect(isSameDatabase(info(NEON_POOLED), info(NEON_DIRECT))).toBe(true);
  });

  it.each([
    ["another endpoint", NEON_POOLED.replace("ep-quiet-sun-a1b2c3d4-pooler", "ep-other-moon-e5f6a7b8-pooler")],
    ["another region", NEON_POOLED.replace("ap-southeast-1", "us-east-2")],
    ["another database", NEON_POOLED.replace("nazir_preview_test", "nazir_other_test")],
    ["another port", NEON_POOLED.replace(".neon.tech/", ".neon.tech:6543/")],
  ])("is NOT the same database on %s", (_label, other) => {
    expect(isSameDatabase(info(other), info(NEON_DIRECT))).toBe(false);
  });

  it("a non-Neon host with '-pooler' in its name is not equated with the host without it", () => {
    expect(isSameDatabase(info("postgresql://u:p@db-pooler.example.com/x"), info("postgresql://u:p@db.example.com/x"))).toBe(false);
  });
});

describe("DB-04 selectDirectDatabaseUrl (DATABASE_URL pooled, DATABASE_URL_UNPOOLED direct)", () => {
  it("prefers DATABASE_URL_UNPOOLED and returns exactly the validated, trimmed string", () => {
    const s = selectDirectDatabaseUrl("test", { DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: `  ${NEON_DIRECT}\n` });
    expect(s).toMatchObject({ variable: "DATABASE_URL_UNPOOLED", url: NEON_DIRECT, database: { database: "nazir_preview_test" } });
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("falls back to DATABASE_URL when DATABASE_URL_UNPOOLED is %s (local development)", (_label, direct) => {
    expect(selectDirectDatabaseUrl("local", { DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: direct })).toMatchObject({
      variable: "DATABASE_URL",
      url: DEV,
      database: { database: "nazir_dev" },
    });
  });

  it("uses DATABASE_URL_UNPOOLED alone when DATABASE_URL is unset, and returns null when neither is set", () => {
    expect(selectDirectDatabaseUrl("test", { DATABASE_URL_UNPOOLED: NEON_DIRECT })).toMatchObject({ variable: "DATABASE_URL_UNPOOLED" });
    expect(selectDirectDatabaseUrl("test", {})).toBeNull();
    expect(selectDirectDatabaseUrl("test", { DATABASE_URL: " ", DATABASE_URL_UNPOOLED: "" })).toBeNull();
  });

  it.each([
    ["direct on another database", { DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_DIRECT.replace("nazir_preview_test", "nazir_other_test") }],
    ["direct on another endpoint", { DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_DIRECT.replace("ep-quiet-sun-a1b2c3d4", "ep-other-moon-e5f6a7b8") }],
    ["local pair on different databases", { DATABASE_URL: TEST, DATABASE_URL_UNPOOLED: "postgresql://nazir:s3cret@localhost:5432/other_test" }],
  ])("refuses a pair that is not the same database (%s)", (_label, env) => {
    expect(() => selectDirectDatabaseUrl("test", env)).toThrow(/must name the same database/);
  });

  it.each([
    ["direct is a test database in local", "local", { DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: TEST }, /DATABASE_URL_UNPOOLED|must not be used/],
    ["pooled is a dev database in test", "test", { DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: NEON_DIRECT }, /requires a database whose name ends with "_test"/],
    ["direct is a dev database in test", "test", { DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: DEV }, /requires a database whose name ends with "_test"/],
    ["direct is a test database in production", "production", { DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: NEON_DIRECT }, /must not be used with NAZIR_RUNTIME_ENV=production/],
    ["direct is malformed", "local", { DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: "not a url s3cret" }, /DATABASE_URL_UNPOOLED is not a valid URL/],
  ] as const)("refuses when either URL breaks the environment rule (%s)", (_label, runtimeEnv, env, message) => {
    expect(() => selectDirectDatabaseUrl(runtimeEnv, env)).toThrow(message);
    expect(() => selectDirectDatabaseUrl(runtimeEnv, env)).toThrow(DatabaseConfigError);
  });

  it("never echoes a password or host in its errors", () => {
    const cases: [Parameters<typeof selectDirectDatabaseUrl>[0], Record<string, string>][] = [
      ["test", { DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_DIRECT.replace("nazir_preview_test", "nazir_other_test") }],
      ["local", { DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: NEON_DIRECT }],
      ["local", { DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: "mysql://u:s3cret@h/db" }],
      ["local", { DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: "not a url s3cret" }],
    ];
    for (const [runtimeEnv, env] of cases) {
      let message = "";
      try {
        selectDirectDatabaseUrl(runtimeEnv, env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("s3cret");
      expect(message).not.toContain("neon.tech");
    }
  });
});

describe("DB-04 assertDevSeedAllowed selects the direct connection", () => {
  it("uses DATABASE_URL_UNPOOLED when set, DATABASE_URL otherwise", () => {
    expect(assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_DIRECT })).toMatchObject({
      runtimeEnv: "test",
      variable: "DATABASE_URL_UNPOOLED",
      url: NEON_DIRECT,
    });
    expect(assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV })).toMatchObject({ variable: "DATABASE_URL", url: DEV });
  });

  it("refuses a mismatched pair and a direct URL from another environment; the environment rule still comes first", () => {
    expect(() =>
      assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_DIRECT.replace("nazir_preview_test", "x_test") }),
    ).toThrow(/must name the same database/);
    expect(() => assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: TEST })).toThrow(DatabaseConfigError);
    expect(() => assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "staging", DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: DEV })).toThrow(SeedNotAllowedError);
    expect(() => assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "test" })).toThrow(/DATABASE_URL is not set/);
  });
});

describe("DB-04 assertRuntimeDatabaseConfig (app runtime: DATABASE_URL only)", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("refuses DATABASE_URL_UNPOOLED without DATABASE_URL (%s)", (_label, pooled) => {
    const env = { DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: NEON_DIRECT };
    expect(() => assertRuntimeDatabaseConfig("test", env)).toThrow(DatabaseConfigError);
    expect(() => assertRuntimeDatabaseConfig("test", env)).toThrow(/DATABASE_URL_UNPOOLED is set but DATABASE_URL is not/);
  });

  it("… while the Prisma CLI / seed selection still accepts DATABASE_URL_UNPOOLED alone", () => {
    expect(selectDirectDatabaseUrl("test", { DATABASE_URL_UNPOOLED: NEON_DIRECT })).toMatchObject({ variable: "DATABASE_URL_UNPOOLED" });
    expect(assertDevSeedAllowed({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL_UNPOOLED: NEON_DIRECT })).toMatchObject({ variable: "DATABASE_URL_UNPOOLED" });
  });

  it("returns the pooled database (and the direct one when set)", () => {
    expect(assertRuntimeDatabaseConfig("test", { DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_DIRECT })).toMatchObject({
      pooled: { database: "nazir_preview_test", host: "ep-quiet-sun-a1b2c3d4-pooler.ap-southeast-1.aws.neon.tech" },
      direct: { database: "nazir_preview_test", host: "ep-quiet-sun-a1b2c3d4.ap-southeast-1.aws.neon.tech" },
    });
    expect(assertRuntimeDatabaseConfig("local", { DATABASE_URL: DEV })).toMatchObject({ pooled: { database: "nazir_dev" }, direct: null });
    expect(assertRuntimeDatabaseConfig("local", { DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: "  " })).toMatchObject({ direct: null });
  });

  it("returns null when neither is set (no database required at startup yet)", () => {
    expect(assertRuntimeDatabaseConfig("production", {})).toBeNull();
    expect(assertRuntimeDatabaseConfig("production", { DATABASE_URL: "", DATABASE_URL_UNPOOLED: " " })).toBeNull();
  });

  it("keeps the startup check's blank rule: a whitespace-only DATABASE_URL is refused", () => {
    expect(() => assertRuntimeDatabaseConfig("local", { DATABASE_URL: "   " })).toThrow(/DATABASE_URL is not set/);
  });

  it.each([
    ["the pair names different databases", "test", { DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_DIRECT.replace("nazir_preview_test", "nazir_other_test") }, /must name the same database/],
    ["the direct URL is a dev database in a test run", "test", { DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: DEV }, /requires a database whose name ends with "_test"/],
    ["the direct URL is a test database in local", "local", { DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: TEST }, /must not be used with NAZIR_RUNTIME_ENV=local/],
    ["the pooled URL is a test database in production", "production", { DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_DIRECT }, /must not be used with NAZIR_RUNTIME_ENV=production/],
  ] as const)("refuses when %s", (_label, runtimeEnv, env, message) => {
    expect(() => assertRuntimeDatabaseConfig(runtimeEnv, env)).toThrow(message);
    expect(() => assertRuntimeDatabaseConfig(runtimeEnv, env)).toThrow(DatabaseConfigError);
  });

  it("never echoes a password or host in its errors", () => {
    for (const env of [
      { DATABASE_URL_UNPOOLED: NEON_DIRECT },
      { DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_DIRECT.replace("nazir_preview_test", "nazir_other_test") },
      { DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: DEV },
    ]) {
      let message = "";
      try {
        assertRuntimeDatabaseConfig("test", env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("s3cret");
      expect(message).not.toContain("neon.tech");
    }
  });
});
