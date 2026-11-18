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

beforeAll(async () => {
  testDb = await cloneTestDb(server, inject("templateDb"), "test");
  devDb = await cloneTestDb(server, inject("templateDb"), "dev");
  emptyTest = newThrowawayName("test");
  emptyDev = newThrowawayName("dev");
  await createDatabase(server, emptyTest);
  await createDatabase(server, emptyDev);
});
afterAll(async () => {
  await destroyTestDb(testDb);
  await destroyTestDb(devDb);
  await dropDatabase(server, emptyTest);
  await dropDatabase(server, emptyDev);
});

const tablesIn = async (name: string) => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: server.urlFor(name) });
  await c.connect();
  try {
    return (await c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n as number;
  } finally {
    await c.end();
  }
};
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
