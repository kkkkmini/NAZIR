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

  // SHADOW_DATABASE_URL is checked with the same rule (PR #2 review): the CLI resets the shadow database.
  describe("SHADOW_DATABASE_URL", () => {
    const SHADOW_DEV = "postgresql://nazir:s3cret@localhost:5432/nazir_shadow";
    const SHADOW_TEST = "postgresql://nazir:s3cret@localhost:5432/nazir_shadow_test";

    it.each([
      ["local", DEV, SHADOW_DEV],
      ["test", TEST, SHADOW_TEST],
      ["staging", DEV, SHADOW_DEV],
      ["production", DEV, SHADOW_DEV],
    ])("allows NAZIR_RUNTIME_ENV=%s with database %s and shadow %s", (env, url, shadow) => {
      expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: env, DATABASE_URL: url, SHADOW_DATABASE_URL: shadow })).toMatchObject({ database: url.endsWith("_test") ? "nazir_test" : "nazir_dev" });
    });

    it.each([
      ["local", DEV, SHADOW_TEST, /SHADOW_DATABASE_URL: .*must not be used with NAZIR_RUNTIME_ENV=local/],
      ["staging", DEV, SHADOW_TEST, /SHADOW_DATABASE_URL: .*must not be used with NAZIR_RUNTIME_ENV=staging/],
      ["production", DEV, SHADOW_TEST, /SHADOW_DATABASE_URL: .*must not be used with NAZIR_RUNTIME_ENV=production/],
      ["test", TEST, SHADOW_DEV, /SHADOW_DATABASE_URL: .*requires a database whose name ends with "_test"/],
    ])("refuses NAZIR_RUNTIME_ENV=%s with database %s and shadow %s", (env, url, shadow, message) => {
      expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: env, DATABASE_URL: url, SHADOW_DATABASE_URL: shadow })).toThrow(message);
      expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: env, DATABASE_URL: url, SHADOW_DATABASE_URL: shadow })).toThrow(DatabaseConfigError);
    });

    it.each([
      ["missing", {}],
      ["unknown", { NAZIR_RUNTIME_ENV: "prod" }],
    ])("a %s NAZIR_RUNTIME_ENV is production: a test shadow is refused and says so", (_label, env) => {
      expect(() => assertPrismaCliDatabase({ ...env, DATABASE_URL: DEV, SHADOW_DATABASE_URL: SHADOW_TEST })).toThrow(/SHADOW_DATABASE_URL: .*production was assumed/);
    });

    it("an unset or empty shadow keeps the old behaviour (nothing extra is checked)", () => {
      for (const shadow of [undefined, ""]) {
        expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV, SHADOW_DATABASE_URL: shadow })).toMatchObject({ database: "nazir_dev" });
        expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: TEST, SHADOW_DATABASE_URL: shadow })).toMatchObject({ database: "nazir_test" });
      }
    });

    it("is validated even when DATABASE_URL is unset (a shadow alone is still a database the CLI will reset)", () => {
      expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "local", SHADOW_DATABASE_URL: SHADOW_TEST })).toThrow(/SHADOW_DATABASE_URL/);
      expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "local", SHADOW_DATABASE_URL: SHADOW_DEV })).toBeNull();
    });

    it("a whitespace-only or malformed shadow is refused (fail closed), a non-postgres one too", () => {
      for (const bad of ["   ", "not a url", "mysql://u:s3cret@h/db"]) {
        expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV, SHADOW_DATABASE_URL: bad })).toThrow(DatabaseConfigError);
      }
    });

    it.each([
      ["the identical URL", DEV, DEV],
      ["other credentials", DEV, "postgresql://other:pw@localhost:5432/nazir_dev"],
      ["another spelling of localhost", DEV, "postgresql://nazir:s3cret@127.0.0.1:5432/nazir_dev"],
      ["the default port written out", "postgresql://nazir:s3cret@localhost/nazir_dev", "postgresql://nazir:s3cret@localhost:5432/nazir_dev"],
      ["query parameters", DEV, "postgresql://nazir:s3cret@localhost:5432/nazir_dev?schema=public"],
    ])("refuses a shadow that is the same database as DATABASE_URL (%s)", (_label, url, shadow) => {
      expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: url, SHADOW_DATABASE_URL: shadow })).toThrow(/must not be the same database as DATABASE_URL/);
    });

    it("refuses the same test database in a test run", () => {
      expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: TEST, SHADOW_DATABASE_URL: TEST })).toThrow(/must not be the same database/);
    });

    it.each([
      ["another database name", "postgresql://nazir:s3cret@localhost:5432/nazir_other"],
      ["another port", "postgresql://nazir:s3cret@localhost:5433/nazir_dev"],
      ["another server", "postgresql://nazir:s3cret@db.example.test:5432/nazir_dev"],
    ])("allows a shadow on %s", (_label, shadow) => {
      expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV, SHADOW_DATABASE_URL: shadow })).toMatchObject({ database: "nazir_dev" });
    });

    it("never echoes a password, for either URL", () => {
      const cases: Record<string, string>[] = [
        { NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV, SHADOW_DATABASE_URL: SHADOW_TEST },
        { NAZIR_RUNTIME_ENV: "test", DATABASE_URL: TEST, SHADOW_DATABASE_URL: SHADOW_DEV },
        { NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV, SHADOW_DATABASE_URL: DEV },
        { NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV, SHADOW_DATABASE_URL: "not a url with s3cret" },
        { NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV, SHADOW_DATABASE_URL: "mysql://u:s3cret@h/db" },
      ];
      for (const env of cases) {
        let message = "";
        try {
          assertPrismaCliDatabase(env);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message, JSON.stringify(Object.keys(env))).not.toBe("");
        expect(message).not.toContain("s3cret");
        expect(message).not.toContain("pw@");
      }
    });
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

  // DB-04: Neon pooled (DATABASE_URL) / direct (DATABASE_URL_UNPOOLED). Made-up host names, fake password.
  describe("DATABASE_URL_UNPOOLED", () => {
    const DIRECT = "postgresql://nazir:s3cret@ep-quiet-sun-a1b2c3d4.ap-southeast-1.aws.neon.tech/nazir_preview_test?sslmode=require";
    const POOLED = "postgresql://nazir:s3cret@ep-quiet-sun-a1b2c3d4-pooler.ap-southeast-1.aws.neon.tech/nazir_preview_test?sslmode=require";

    it("the CLI uses the direct URL when it is set, and validates the pooled one as well", () => {
      expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT })).toMatchObject({
        variable: "DATABASE_URL_UNPOOLED",
        url: DIRECT,
        database: "nazir_preview_test",
      });
    });

    it("DATABASE_URL alone keeps working exactly as before (local development)", () => {
      expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV })).toMatchObject({ variable: "DATABASE_URL", url: DEV, database: "nazir_dev" });
      expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: "" })).toMatchObject({ variable: "DATABASE_URL" });
    });

    it.each([
      ["direct points at another database", { DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT.replace("nazir_preview_test", "nazir_other_test") }, /must name the same database/],
      ["direct points at another endpoint", { DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT.replace("ep-quiet-sun-a1b2c3d4", "ep-other-moon-e5f6a7b8") }, /must name the same database/],
      ["direct is a development database", { DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DEV }, /DATABASE_URL_UNPOOLED: .*requires a database whose name ends with "_test"/],
      ["pooled is a development database", { DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: DIRECT }, /DATABASE_URL: .*requires a database whose name ends with "_test"/],
    ])("refuses in a test run when %s", (_label, env, message) => {
      expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "test", ...env })).toThrow(message);
      expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "test", ...env })).toThrow(/^Prisma CLI refused before running any command/);
    });

    it("a missing NAZIR_RUNTIME_ENV is production: a test direct URL is refused and says why", () => {
      expect(() => assertPrismaCliDatabase({ DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: TEST })).toThrow(
        /DATABASE_URL_UNPOOLED: .*must not be used with NAZIR_RUNTIME_ENV=production.*production was assumed/,
      );
    });

    it.each([
      ["the direct URL", DIRECT, "DATABASE_URL"],
      ["the pooled spelling of the main database", POOLED, "DATABASE_URL"],
    ])("a shadow equal to %s is refused", (_label, shadow, variable) => {
      expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT, SHADOW_DATABASE_URL: shadow })).toThrow(
        new RegExp(`SHADOW_DATABASE_URL must not be the same database as ${variable}`),
      );
    });

    it("a shadow equal to the direct URL is refused even when only DATABASE_URL_UNPOOLED is set", () => {
      expect(() => assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL_UNPOOLED: DIRECT, SHADOW_DATABASE_URL: POOLED })).toThrow(
        /must not be the same database as DATABASE_URL_UNPOOLED/,
      );
    });

    it("a separate shadow database is allowed", () => {
      const shadow = DIRECT.replace("nazir_preview_test", "nazir_shadow_test");
      expect(assertPrismaCliDatabase({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT, SHADOW_DATABASE_URL: shadow })).toMatchObject({
        variable: "DATABASE_URL_UNPOOLED",
      });
    });

    it("never echoes a password or a host, whichever URL is wrong", () => {
      const cases: Record<string, string>[] = [
        { NAZIR_RUNTIME_ENV: "test", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT.replace("nazir_preview_test", "nazir_other_test") },
        { NAZIR_RUNTIME_ENV: "test", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DEV },
        { NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV, DATABASE_URL_UNPOOLED: "not a url s3cret" },
        { NAZIR_RUNTIME_ENV: "test", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT, SHADOW_DATABASE_URL: POOLED },
      ];
      for (const env of cases) {
        let message = "";
        try {
          assertPrismaCliDatabase(env);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message, JSON.stringify(Object.keys(env))).not.toBe("");
        expect(message).not.toContain("s3cret");
        expect(message).not.toContain("neon.tech");
      }
    });
  });
});
