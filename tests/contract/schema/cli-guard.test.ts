/**
 * P2 — the Prisma CLI checks DATABASE_URL against NAZIR_RUNTIME_ENV when prisma.config.ts loads, i.e. BEFORE any command.
 * Real `prisma` CLI, real PostgreSQL: a refused `migrate deploy` must leave the database untouched, an allowed one must work.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cloneTestDb, createDatabase, destroyTestDb, dropDatabase, newThrowawayName, resolveTestServer, runPrisma, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let testDb: TestDb; // a *_test database (migrated clone)
let devDb: TestDb; // a database that is not a test database (migrated clone)
let emptyTest: string; // *_test, no tables
let emptyDev: string; // not a test database, no tables
let shadowTest: string; // *_test, holds only a sentinel table: a shadow reset would drop it
let shadowDev: string; // not a test database, holds only a sentinel table

beforeAll(async () => {
  testDb = await cloneTestDb(server, inject("templateDb"), "test");
  devDb = await cloneTestDb(server, inject("templateDb"), "dev");
  emptyTest = newThrowawayName("test");
  emptyDev = newThrowawayName("dev");
  await createDatabase(server, emptyTest);
  await createDatabase(server, emptyDev);
  shadowTest = newThrowawayName("test");
  shadowDev = newThrowawayName("dev");
  await createDatabase(server, shadowTest);
  await createDatabase(server, shadowDev);
  for (const name of [shadowTest, shadowDev]) await withDb(name, (c) => c.query("CREATE TABLE guard_sentinel (id int); INSERT INTO guard_sentinel VALUES (42)"));
});
afterAll(async () => {
  await destroyTestDb(testDb);
  await destroyTestDb(devDb);
  await dropDatabase(server, emptyTest);
  await dropDatabase(server, emptyDev);
  await dropDatabase(server, shadowTest);
  await dropDatabase(server, shadowDev);
});

const withDb = async <T>(name: string, fn: (c: import("pg").Client) => Promise<T>): Promise<T> => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: server.urlFor(name) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};
const tablesIn = (name: string) => withDb(name, async (c) => (await c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n as number);
/** The sentinel table is still the only thing in the database: nothing was reset, migrated or dropped there. */
const sentinelIntact = (name: string) =>
  withDb(name, async (c) => {
    const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename);
    const row = tables.includes("guard_sentinel") ? (await c.query(`SELECT id FROM guard_sentinel`)).rows : [];
    return { tables, row };
  });
const INTACT = { tables: ["guard_sentinel"], row: [{ id: 42 }] };
const DIFF = ["migrate", "diff", "--from-migrations", "prisma/migrations", "--to-schema", "prisma/schema.prisma", "--exit-code"];
const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe("prisma.config.ts database / environment guard (real Prisma CLI)", () => {
  // `prisma validate` loads the same config and needs no database round trip: it shows the guard decision for each pair.
  it.each([
    ["local", () => devDb.url, true],
    ["test", () => testDb.url, true],
    ["test", () => devDb.url, false],
    ["local", () => testDb.url, false],
    ["staging", () => testDb.url, false],
    ["production", () => testDb.url, false],
    ["", () => testDb.url, false], // missing => production
    ["prod", () => testDb.url, false], // unknown => production
    ["production", () => devDb.url, true],
    ["", () => devDb.url, true],
  ] as const)("NAZIR_RUNTIME_ENV=%j with %s database: allowed=%s", async (env, url, allowed) => {
    const res = await runPrisma(["validate"], { databaseUrl: url(), env: { NAZIR_RUNTIME_ENV: env } });
    if (allowed) expect(res.code, out(res)).toBe(0);
    else {
      expect(res.code).not.toBe(0);
      expect(out(res)).toMatch(/Prisma CLI refused before running any command/);
    }
  });

  it("prisma validate / generate-style commands work when DATABASE_URL is unset, in every environment", async () => {
    for (const env of ["test", "local", "production", ""]) {
      const res = await runPrisma(["validate"], { databaseUrl: "", env: { NAZIR_RUNTIME_ENV: env } });
      expect(res.code, `${env}: ${out(res)}`).toBe(0);
    }
  });

  it("test environment + non-test database: `migrate deploy` is refused before it starts and the database is not changed", async () => {
    expect(await tablesIn(emptyDev)).toBe(0);
    const res = await runPrisma(["migrate", "deploy"], { databaseUrl: server.urlFor(emptyDev), env: { NAZIR_RUNTIME_ENV: "test" } });
    expect(res.code).not.toBe(0);
    expect(out(res)).toMatch(/requires a database whose name ends with "_test"/);
    expect(out(res)).not.toMatch(/Applying migration|successfully applied/);
    expect(await tablesIn(emptyDev)).toBe(0); // no _prisma_migrations table either
  });

  it.each(["local", "staging", "production", "", "prod"])(
    "NAZIR_RUNTIME_ENV=%j + test database: `migrate deploy` is refused and the database stays empty",
    async (env) => {
      expect(await tablesIn(emptyTest)).toBe(0);
      const res = await runPrisma(["migrate", "deploy"], { databaseUrl: server.urlFor(emptyTest), env: { NAZIR_RUNTIME_ENV: env } });
      expect(res.code).not.toBe(0);
      expect(out(res)).toMatch(/must not be used with NAZIR_RUNTIME_ENV=/);
      expect(await tablesIn(emptyTest)).toBe(0);
    },
  );

  it("the destructive `migrate reset` is refused by the same guard and leaves existing data alone", async () => {
    await devDb.query(`INSERT INTO venues (name) VALUES ('guard-probe')`);
    const res = await runPrisma(["migrate", "reset", "--force", "--skip-seed"], { databaseUrl: devDb.url, env: { NAZIR_RUNTIME_ENV: "test" } });
    expect(res.code).not.toBe(0);
    expect(out(res)).toMatch(/Prisma CLI refused before running any command/);
    expect((await devDb.query(`SELECT count(*)::int AS n FROM venues WHERE name = 'guard-probe'`)).rows[0].n).toBe(1);
  });

  it("allowed pairs still work end to end: local + non-test database and test + test database", async () => {
    const local = await runPrisma(["migrate", "deploy"], { databaseUrl: server.urlFor(emptyDev), env: { NAZIR_RUNTIME_ENV: "local" } });
    expect(local.code, out(local)).toBe(0);
    expect(await tablesIn(emptyDev)).toBeGreaterThan(20);
    const test = await runPrisma(["migrate", "deploy"], { databaseUrl: server.urlFor(emptyTest), env: { NAZIR_RUNTIME_ENV: "test" } });
    expect(test.code, out(test)).toBe(0);
    expect(await tablesIn(emptyTest)).toBeGreaterThan(20);
  });

  it("SHADOW_DATABASE_URL is still passed to the CLI (migrate diff --from-migrations works with a shadow database)", async () => {
    const shadow = newThrowawayName("test");
    await createDatabase(server, shadow);
    try {
      const res = await runPrisma(
        ["migrate", "diff", "--from-migrations", "prisma/migrations", "--to-schema", "prisma/schema.prisma", "--exit-code"],
        { databaseUrl: testDb.url, shadowUrl: server.urlFor(shadow), env: { NAZIR_RUNTIME_ENV: "test" } },
      );
      expect(res.code, out(res)).toBe(0);
    } finally {
      await dropDatabase(server, shadow);
    }
  });
});

describe("prisma.config.ts guards SHADOW_DATABASE_URL as well (real Prisma CLI)", () => {
  it.each([
    ["local", "local + non-test database + test shadow"],
    ["staging", "staging + non-test database + test shadow"],
    ["production", "production + non-test database + test shadow"],
    ["", "missing NAZIR_RUNTIME_ENV (=> production) + non-test database + test shadow"],
    ["prod", "unknown NAZIR_RUNTIME_ENV (=> production) + non-test database + test shadow"],
  ])("NAZIR_RUNTIME_ENV=%j: %s is refused before the command and the shadow database is not touched", async (env) => {
    expect(await sentinelIntact(shadowTest)).toEqual(INTACT);
    const res = await runPrisma(DIFF, { databaseUrl: devDb.url, shadowUrl: server.urlFor(shadowTest), env: { NAZIR_RUNTIME_ENV: env } });
    expect(res.code).not.toBe(0);
    expect(out(res)).toMatch(/Prisma CLI refused before running any command: SHADOW_DATABASE_URL: .*must not be used with NAZIR_RUNTIME_ENV=/);
    expect(await sentinelIntact(shadowTest)).toEqual(INTACT); // a shadow reset would have dropped the sentinel
  });

  it("test + test database + non-test shadow is refused and the shadow database is not touched", async () => {
    const res = await runPrisma(DIFF, { databaseUrl: testDb.url, shadowUrl: server.urlFor(shadowDev), env: { NAZIR_RUNTIME_ENV: "test" } });
    expect(res.code).not.toBe(0);
    expect(out(res)).toMatch(/SHADOW_DATABASE_URL: NAZIR_RUNTIME_ENV=test requires a database whose name ends with "_test"/);
    expect(await sentinelIntact(shadowDev)).toEqual(INTACT);
  });

  it("every command is refused, not only diff: `migrate deploy` with a forbidden shadow leaves the database empty", async () => {
    const fresh = newThrowawayName("dev"); // (emptyDev is migrated by an earlier test of this file)
    await createDatabase(server, fresh);
    try {
      expect(await tablesIn(fresh)).toBe(0);
      const res = await runPrisma(["migrate", "deploy"], { databaseUrl: server.urlFor(fresh), shadowUrl: server.urlFor(shadowTest), env: { NAZIR_RUNTIME_ENV: "local" } });
      expect(res.code).not.toBe(0);
      expect(out(res)).toMatch(/SHADOW_DATABASE_URL/);
      expect(await tablesIn(fresh)).toBe(0); // not even _prisma_migrations
      expect(await sentinelIntact(shadowTest)).toEqual(INTACT);
    } finally {
      await dropDatabase(server, fresh);
    }
  });

  it.each([
    ["the same test database", () => testDb.url, () => testDb.url, "test"],
    ["the same non-test database", () => devDb.url, () => devDb.url, "local"],
    ["the same database through another loopback spelling", () => devDb.url, () => devDb.url.replace("127.0.0.1", "localhost"), "local"],
  ] as const)("%s as DATABASE_URL and SHADOW_DATABASE_URL is refused and the database keeps its data", async (_label, database, shadow, env) => {
    const before = await withDb(env === "test" ? testDb.name : devDb.name, async (c) => (await c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n as number);
    const res = await runPrisma(DIFF, { databaseUrl: database(), shadowUrl: shadow(), env: { NAZIR_RUNTIME_ENV: env } });
    expect(res.code).not.toBe(0);
    expect(out(res)).toMatch(/SHADOW_DATABASE_URL must not be the same database as DATABASE_URL/);
    expect(await tablesIn(env === "test" ? testDb.name : devDb.name)).toBe(before); // a shadow reset would have emptied it
  });

  it("allowed pairs work: local + non-test shadow and test + test shadow; the shadow database is the one the CLI rewrites", async () => {
    expect(await sentinelIntact(shadowDev)).toEqual(INTACT);
    const local = await runPrisma(DIFF, { databaseUrl: devDb.url, shadowUrl: server.urlFor(shadowDev), env: { NAZIR_RUNTIME_ENV: "local" } });
    expect(local.code, out(local)).toBe(0);
    // positive control: this is what a refused command would have done to the shadow database
    expect(await sentinelIntact(shadowDev)).not.toEqual(INTACT);

    const shadow = newThrowawayName("test");
    await createDatabase(server, shadow);
    try {
      const test = await runPrisma(DIFF, { databaseUrl: testDb.url, shadowUrl: server.urlFor(shadow), env: { NAZIR_RUNTIME_ENV: "test" } });
      expect(test.code, out(test)).toBe(0);
    } finally {
      await dropDatabase(server, shadow);
    }
  });

  it("without a shadow database nothing changes: validate and migrate status work, migrate diff --from-migrations fails as Prisma itself does (no guard message)", async () => {
    for (const [env, url] of [["local", devDb.url], ["test", testDb.url]] as const) {
      const validate = await runPrisma(["validate"], { databaseUrl: url, env: { NAZIR_RUNTIME_ENV: env } });
      expect(validate.code, out(validate)).toBe(0);
      const status = await runPrisma(["migrate", "status"], { databaseUrl: url, env: { NAZIR_RUNTIME_ENV: env } });
      expect(status.code, out(status)).toBe(0);
    }
    const noShadow = await runPrisma(DIFF, { databaseUrl: devDb.url, env: { NAZIR_RUNTIME_ENV: "local" } });
    expect(noShadow.code).not.toBe(0);
    expect(out(noShadow)).toMatch(/shadowDatabaseUrl/); // Prisma's own "set datasource.shadowDatabaseUrl" message
    expect(out(noShadow)).not.toMatch(/Prisma CLI refused/);
  });
});

// DB-05: DATABASE_URL (pooled, app runtime) / DATABASE_URL_UNPOOLED (direct, Prisma CLI). Both name the same database
// here; one of them carries a WRONG password, so whichever URL the CLI really connects with decides the outcome.
const WRONG_PW = "wrong-pw-db05";
const withWrongPassword = (raw: string) => {
  const u = new URL(raw);
  u.password = WRONG_PW;
  return u.toString();
};

describe("DB-05 the Prisma CLI connects with DATABASE_URL_UNPOOLED when it is set (real Prisma CLI)", () => {
  it("control: DATABASE_URL with a wrong password alone cannot migrate (so the tests below are meaningful)", async () => {
    const fresh = newThrowawayName("test");
    await createDatabase(server, fresh);
    try {
      const res = await runPrisma(["migrate", "deploy"], { databaseUrl: withWrongPassword(server.urlFor(fresh)), env: { NAZIR_RUNTIME_ENV: "test" } });
      expect(res.code).not.toBe(0);
      expect(await tablesIn(fresh)).toBe(0);
      expect(out(res)).not.toContain(WRONG_PW);
    } finally {
      await dropDatabase(server, fresh);
    }
  });

  it("pooled URL broken, direct URL correct: `migrate deploy` succeeds, so the CLI used the direct URL", async () => {
    const fresh = newThrowawayName("test");
    await createDatabase(server, fresh);
    try {
      const res = await runPrisma(["migrate", "deploy"], {
        databaseUrl: withWrongPassword(server.urlFor(fresh)),
        unpooledUrl: server.urlFor(fresh),
        env: { NAZIR_RUNTIME_ENV: "test" },
      });
      expect(res.code, out(res)).toBe(0);
      expect(await tablesIn(fresh)).toBeGreaterThan(0);
      expect(out(res)).not.toContain(WRONG_PW);
    } finally {
      await dropDatabase(server, fresh);
    }
  });

  it("without DATABASE_URL_UNPOOLED, DATABASE_URL alone still migrates (local development unchanged)", async () => {
    const fresh = newThrowawayName("test");
    await createDatabase(server, fresh);
    try {
      const res = await runPrisma(["migrate", "deploy"], { databaseUrl: server.urlFor(fresh), env: { NAZIR_RUNTIME_ENV: "test" } });
      expect(res.code, out(res)).toBe(0);
      expect(await tablesIn(fresh)).toBeGreaterThan(0);
    } finally {
      await dropDatabase(server, fresh);
    }
  });

  it("a direct URL naming ANOTHER database is refused before anything runs; neither database is touched", async () => {
    const a = newThrowawayName("test");
    const b = newThrowawayName("test");
    await createDatabase(server, a);
    await createDatabase(server, b);
    try {
      const res = await runPrisma(["migrate", "deploy"], { databaseUrl: server.urlFor(a), unpooledUrl: server.urlFor(b), env: { NAZIR_RUNTIME_ENV: "test" } });
      expect(res.code).not.toBe(0);
      expect(out(res)).toMatch(/DATABASE_URL_UNPOOLED and DATABASE_URL must name the same database/);
      expect(await tablesIn(a)).toBe(0);
      expect(await tablesIn(b)).toBe(0);
    } finally {
      await dropDatabase(server, a);
      await dropDatabase(server, b);
    }
  });

  it("a direct URL from another environment (a non-test database in a test run) is refused and not touched", async () => {
    const t = newThrowawayName("test");
    const d = newThrowawayName("dev");
    await createDatabase(server, t);
    await createDatabase(server, d);
    try {
      const res = await runPrisma(["migrate", "deploy"], { databaseUrl: server.urlFor(t), unpooledUrl: server.urlFor(d), env: { NAZIR_RUNTIME_ENV: "test" } });
      expect(res.code).not.toBe(0);
      expect(out(res)).toMatch(/DATABASE_URL_UNPOOLED: .*requires a database whose name ends with "_test"/);
      expect(await tablesIn(d)).toBe(0);
      expect(await tablesIn(t)).toBe(0);
    } finally {
      await dropDatabase(server, t);
      await dropDatabase(server, d);
    }
  });

  it("never prints either URL's password when it refuses (a unique marker password on both URLs)", async () => {
    const a = newThrowawayName("test");
    const d = newThrowawayName("dev");
    await createDatabase(server, a);
    await createDatabase(server, d);
    try {
      for (const [databaseUrl, unpooledUrl] of [
        [server.urlFor(a), server.urlFor(d)], // environment violation on the direct URL
        [server.urlFor(a), server.urlFor(d).replace(/_dev(\?|$)/, "_other_test$1")], // pair mismatch
      ]) {
        const res = await runPrisma(["migrate", "deploy"], {
          databaseUrl: withWrongPassword(databaseUrl),
          unpooledUrl: withWrongPassword(unpooledUrl),
          env: { NAZIR_RUNTIME_ENV: "test" },
        });
        expect(res.code).not.toBe(0);
        expect(out(res)).toMatch(/Prisma CLI refused before running any command/);
        expect(out(res)).not.toContain(WRONG_PW);
      }
    } finally {
      await dropDatabase(server, a);
      await dropDatabase(server, d);
    }
  });
});
