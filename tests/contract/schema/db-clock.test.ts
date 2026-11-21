/**
 * DB-03: DbClock against a real PostgreSQL server through the application Prisma client
 * (src/server/db/app-clock.ts → getPrisma(), Prisma 7 + @prisma/adapter-pg).
 */
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
});
afterAll(() => destroyTestDb(db));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (globalThis as { __nazirPrisma?: unknown }).__nazirPrisma;
});

async function load() {
  vi.stubEnv("NAZIR_RUNTIME_ENV", "test");
  vi.stubEnv("DATABASE_URL", db.url);
  vi.stubEnv("PAYMENT_PROVIDER", "mock");
  vi.stubEnv("IDENTITY_PROVIDER", "mock");
  vi.resetModules();
  const { getPrisma } = await import("../../../src/server/db/client");
  const { getAppClock } = await import("../../../src/server/db/app-clock");
  const { DbClock } = await import("../../../src/server/db/db-clock");
  return { prisma: getPrisma(), clock: getAppClock(), DbClock };
}

describe("DB-03 DbClock", () => {
  it("returns the database server's now() as a valid Date", async () => {
    const { prisma, clock } = await load();
    try {
      const before = (await db.query<{ t: Date }>("SELECT now() AS t")).rows[0].t;
      const now = await clock.now();
      const after = (await db.query<{ t: Date }>("SELECT now() AS t")).rows[0].t;
      expect(now).toBeInstanceOf(Date);
      expect(now.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1); // -1: DbClock floors microseconds
      expect(now.getTime()).toBeLessThanOrEqual(after.getTime());
    } finally {
      await prisma.$disconnect();
    }
  });

  it("returns the right instant under a non-UTC session time zone (Asia/Seoul)", async () => {
    // Prisma 7 + adapter-pg decodes a RAW timestamptz as if it were UTC, ignoring TimeZone; with Asia/Seoul a plain
    // `SELECT now()` came back 9 hours off. DbClock reads epoch milliseconds instead. node-pg (db.query) decodes the
    // offset correctly and brackets the expected instant.
    const { prisma, DbClock } = await load();
    try {
      const before = (await db.query<{ t: Date }>("SELECT now() AS t")).rows[0].t;
      const [seoul, utc] = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Seoul'");
        const s = await new DbClock(tx).now();
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
        return [s, await new DbClock(tx).now()];
      });
      const after = (await db.query<{ t: Date }>("SELECT now() AS t")).rows[0].t;
      expect(seoul.getTime()).toBe(utc.getTime()); // same transaction start, any zone
      expect(seoul.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1); // -1: DbClock floors microseconds
      expect(seoul.getTime()).toBeLessThanOrEqual(after.getTime());
    } finally {
      await prisma.$disconnect();
    }
  });

  it("bound to a transaction client, returns that transaction's single start time", async () => {
    const { prisma, DbClock } = await load();
    try {
      const [a, b] = await prisma.$transaction(
        async (tx) => {
          const clock = new DbClock(tx);
          const first = await clock.now();
          await tx.$executeRaw`SELECT pg_sleep(0.05)`;
          return [first, await clock.now()];
        },
        { isolationLevel: "ReadCommitted", timeout: 5_000 },
      );
      expect(b.getTime()).toBe(a.getTime());
    } finally {
      await prisma.$disconnect();
    }
  });

  it("outside a transaction, successive calls advance", async () => {
    const { prisma, clock } = await load();
    try {
      const a = await clock.now();
      await prisma.$executeRaw`SELECT pg_sleep(0.05)`;
      const b = await clock.now();
      expect(b.getTime()).toBeGreaterThan(a.getTime());
    } finally {
      await prisma.$disconnect();
    }
  });

  it("propagates a connection failure (no system-clock fallback)", async () => {
    vi.stubEnv("NAZIR_RUNTIME_ENV", "test");
    // Same server, a database that does not exist: the environment check passes, the connection fails.
    vi.stubEnv("DATABASE_URL", db.url.replace(/\/[^/?]+(\?|$)/, "/nazir_missing_db_test$1"));
    vi.stubEnv("PAYMENT_PROVIDER", "mock");
    vi.stubEnv("IDENTITY_PROVIDER", "mock");
    vi.resetModules();
    const { getPrisma } = await import("../../../src/server/db/client");
    const { getAppClock } = await import("../../../src/server/db/app-clock");
    try {
      await expect(getAppClock().now()).rejects.toThrow();
    } finally {
      await getPrisma().$disconnect();
    }
  });
});
