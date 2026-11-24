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

/**
 * DB-02 (D3 / Q-026): what actually writes created_at / updated_at. Measured, not assumed:
 *   - DB defaults are CURRENT_TIMESTAMP (transaction start time) for every created_at / updated_at;
 *   - raw SQL that omits them gets the DATABASE clock; a raw UPDATE does NOT touch updated_at (no trigger);
 *   - Prisma Client 7.10.1 (adapter-pg) sends BOTH columns explicitly with the APPLICATION clock on INSERT, and
 *     updated_at on UPDATE, so the DB default is not used for Client writes.
 * If a Prisma upgrade changes this, these tests fail and docs/DATABASE.md §19.5 must be revisited.
 */
describe("DB-02 timestamp sources", () => {
  it("every created_at / updated_at / received_at column defaults to CURRENT_TIMESTAMP (the @default(now()) -> DB default mapping)", async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string; column_default: string | null; is_nullable: string }>(`
      SELECT c.table_name, c.column_name, c.column_default, c.is_nullable
        FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> '_prisma_migrations'
         AND c.column_name IN ('created_at', 'updated_at', 'received_at', 'last_received_at')`);
    expect(rows.length).toBeGreaterThanOrEqual(45);
    const wrong = rows.filter((r) => r.column_default !== "CURRENT_TIMESTAMP" || r.is_nullable !== "NO");
    expect(wrong).toEqual([]);
    expect(rows.filter((r) => r.column_name === "updated_at")).toHaveLength(20); // + rate_limit_counters (A-045)
  });

  it("raw SQL: omitted created_at / updated_at come from the DB clock = transaction start; a raw UPDATE leaves updated_at alone", async () => {
    await db.rolledBack(async (c) => {
      const { rows: t0 } = await c.query<{ now: Date }>(`SELECT now() AS now`);
      await c.query(`SELECT pg_sleep(0.05)`);
      const { rows } = await c.query<{ id: string; created_at: Date; updated_at: Date }>(`INSERT INTO venues (name) VALUES ('ts') RETURNING id, created_at, updated_at`);
      expect(rows[0].created_at.getTime()).toBe(t0[0].now.getTime()); // transaction START time, not statement time
      expect(rows[0].updated_at.getTime()).toBe(t0[0].now.getTime());
      await c.query(`SELECT pg_sleep(0.05)`);
      const { rows: after } = await c.query<{ updated_at: Date }>(`UPDATE venues SET name = 'ts2' WHERE id = $1 RETURNING updated_at`, [rows[0].id]);
      expect(after[0].updated_at.getTime()).toBe(rows[0].updated_at.getTime()); // no trigger: raw writers must set updated_at themselves
    });
  });

  it("Prisma Client: created_at and updated_at are sent explicitly from the application clock", async () => {
    const { PrismaClient } = await import("../../../src/generated/prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: db.url }), log: [{ emit: "event", level: "query" }] });
    const events: { query: string; params: string }[] = [];
    (prisma as unknown as { $on(e: "query", cb: (x: { query: string; params: string }) => void): void }).$on("query", (e) => events.push(e));
    try {
      const before = Date.now();
      const venue = await prisma.venue.create({ data: { name: "ts-client" } });
      const insert = events.find((e) => e.query.includes('INSERT INTO "public"."venues"'))!;
      expect(insert.query).toContain('"created_at"');
      expect(insert.query).toContain('"updated_at"');
      const stamps = (JSON.parse(insert.params) as unknown[]).filter((v): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v));
      expect(stamps).toHaveLength(2); // both columns carry a client-supplied timestamp
      for (const st of stamps) expect(Math.abs(Date.parse(st) - before)).toBeLessThan(5_000);

      events.length = 0;
      await prisma.venue.update({ where: { id: venue.id }, data: { name: "ts-client-2" } });
      const upd = events.find((e) => e.query.includes('UPDATE "public"."venues"'))!;
      expect(upd.query).toContain('"updated_at"');
    } finally {
      await prisma.$disconnect();
    }
  });
});
