/**
 * DB-01: the app's Prisma Client (src/server/db/client.ts: Prisma 7 + @prisma/adapter-pg) connects to a
 * real PostgreSQL database, maps bigint/timestamptz/uuid correctly, and refuses a database that does not
 * belong to the current NAZIR_RUNTIME_ENV.
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

async function loadClient(env: { NAZIR_RUNTIME_ENV: string; DATABASE_URL: string }) {
  vi.stubEnv("NAZIR_RUNTIME_ENV", env.NAZIR_RUNTIME_ENV);
  vi.stubEnv("DATABASE_URL", env.DATABASE_URL);
  vi.stubEnv("PAYMENT_PROVIDER", "mock");
  vi.stubEnv("IDENTITY_PROVIDER", "mock");
  vi.resetModules();
  return (await import("../../../src/server/db/client")).getPrisma();
}

describe("DB-01 Prisma Client", () => {
  it("connects, round-trips uuid / bigint / timestamptz, and reports PostgreSQL 15+", async () => {
    const prisma = await loadClient({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: db.url });
    try {
      const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`SELECT current_setting('server_version_num')::int AS n`;
      expect(n).toBeGreaterThanOrEqual(150000);

      const venue = await prisma.venue.create({ data: { name: "client-test" } });
      expect(venue.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(venue.timezone).toBe("Asia/Seoul");

      const show = await prisma.show.create({ data: { venueId: venue.id, title: "t", slug: "client-test", status: "PUBLISHED" } });
      const when = new Date("2030-01-02T03:04:05.678Z");
      const session = await prisma.showSession.create({
        data: { showId: show.id, venueId: venue.id, startsAt: when, salesStatus: "ON_SALE" },
      });
      expect(session.startsAt.toISOString()).toBe(when.toISOString());
      expect(session.maxSeatsPerIdentity).toBe(4);

      const seat = await prisma.seat.create({ data: { venueId: venue.id, svgSeatId: "c-1", seatNumber: "1" } });
      const big = BigInt("9007199254740993"); // > Number.MAX_SAFE_INTEGER: must not lose precision
      const ss = await prisma.sessionSeat.create({
        data: { showSessionId: session.id, seatId: seat.id, venueId: venue.id, price: big, status: "AVAILABLE" },
      });
      expect(typeof ss.price).toBe("bigint");
      expect(ss.price).toBe(big);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("supports explicit READ COMMITTED transactions (DATABASE.md §13.2)", async () => {
    const prisma = await loadClient({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: db.url });
    try {
      const iso = await prisma.$transaction(
        async (tx) => (await tx.$queryRaw<{ i: string }[]>`SELECT current_setting('transaction_isolation') AS i`)[0].i,
        { isolationLevel: "ReadCommitted", timeout: 5_000 },
      );
      expect(iso).toBe("read committed");
    } finally {
      await prisma.$disconnect();
    }
  });

  it("refuses a *_test database outside NAZIR_RUNTIME_ENV=test, and a non-test database inside it", async () => {
    await expect(loadClient({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: db.url })).rejects.toThrow(/must not be used with NAZIR_RUNTIME_ENV=local/);
    await expect(
      loadClient({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: db.url.replace(/_test(\?.*)?$/, "_dev$1") }),
    ).rejects.toThrow(/requires a database whose name ends with "_test"/);
  });
});
