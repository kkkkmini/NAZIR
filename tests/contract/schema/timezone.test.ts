/**
 * TZ-01..TZ-05 (TEST_PLAN §2.3 S11): the application's PostgreSQL connections read and write `timestamptz` as the
 * same instant whatever TimeZone the server/database/role defaults to. (TZ-06, the pool-config unit test, lives in
 * tests/unit/pg-adapter.test.ts; SEED-05 covers the seed connection in ./seed.test.ts.)
 *
 * Setup: this file's private database gets `ALTER DATABASE … SET timezone = 'Asia/Seoul'`, so EVERY new connection
 * starts in Seoul exactly as with a provider whose default is not UTC. No test switches its own session with
 * `SET TIME ZONE`; everything under test goes through the real application path (`getPrisma()` / `getAppClock()`).
 *
 * Ground truth never depends on a session TimeZone: it is read as epoch milliseconds computed by PostgreSQL.
 *
 * The negative controls (TZ-01) use the driver adapter WITHOUT the fix and must still show the 9-hour misreading.
 * They prove that this database really exercises the bug. If a future @prisma/adapter-pg release decodes offsets
 * correctly, those controls will fail: re-evaluate the fix then, do not just delete them.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const NINE_HOURS = 9 * 60 * 60 * 1000;
const server = resolveTestServer();
let db: TestDb;

beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  // Database-level default: applies to every connection opened from now on.
  // (The harness's own pooled connection used for this ALTER keeps its old setting; it is only used for
  // session-independent ground-truth queries below.)
  await db.query(`ALTER DATABASE "${db.name}" SET timezone TO 'Asia/Seoul'`);
});
afterAll(() => destroyTestDb(db));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (globalThis as { __nazirPrisma?: unknown }).__nazirPrisma;
});

async function loadApp(databaseUrl = db.url) {
  vi.stubEnv("NAZIR_RUNTIME_ENV", "test");
  vi.stubEnv("DATABASE_URL", databaseUrl);
  vi.stubEnv("PAYMENT_PROVIDER", "mock");
  vi.stubEnv("IDENTITY_PROVIDER", "mock");
  vi.resetModules();
  const { getPrisma } = await import("../../../src/server/db/client");
  const { getAppClock } = await import("../../../src/server/db/app-clock");
  const { DbClock } = await import("../../../src/server/db/db-clock");
  const { computeSalesStatus } = await import("../../../src/server/catalog/sales-status");
  return { prisma: getPrisma(), clock: getAppClock(), DbClock, computeSalesStatus };
}

/** The adapter exactly as it was before the fix: connection string only. */
function unfixedClient(url = db.url) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/** Session-independent truth: the stored instant as epoch milliseconds. */
async function epochMs(table: "show_sessions" | "shows", column: string, id: string): Promise<number> {
  const { rows } = await db.query<{ ms: string }>(
    `SELECT floor(extract(epoch FROM "${column}") * 1000)::bigint::text AS ms FROM "${table}" WHERE id = $1`,
    [id],
  );
  return Number(rows[0].ms);
}

let seq = 0;
async function mkShowAndSession(prisma: PrismaClient, startsAt: Date) {
  const n = ++seq;
  const venue = await prisma.venue.create({ data: { name: `tz-venue-${n}` } });
  const show = await prisma.show.create({ data: { venueId: venue.id, title: "tz", slug: `tz-show-${n}`, status: "PUBLISHED" } });
  const session = await prisma.showSession.create({ data: { showId: show.id, venueId: venue.id, startsAt, salesStatus: "ON_SALE" } });
  return { venue, show, session };
}

const INSTANT = new Date("2030-01-02T03:04:05.678Z");

describe("TZ-01 environment and negative controls", () => {
  it("a plain new connection to this database starts in Asia/Seoul", async () => {
    const c = new Client({ connectionString: db.url });
    await c.connect();
    try {
      expect((await c.query<{ TimeZone: string }>("SHOW TimeZone")).rows[0].TimeZone).toBe("Asia/Seoul");
    } finally {
      await c.end();
    }
  });

  it("without the fix the adapter WRITES 9 hours early and READS 9 hours late, so its own round trip hides it", async () => {
    const prisma = unfixedClient();
    try {
      // write: the adapter sends UTC wall-clock text without an offset; PostgreSQL reads it as Seoul local time
      const { session } = await mkShowAndSession(prisma, INSTANT);
      expect(INSTANT.getTime() - (await epochMs("show_sessions", "starts_at", session.id))).toBe(NINE_HOURS);
      // read-back through the same adapter: +9h again, so the app sees the value it wrote while the stored instant is wrong
      const back = await prisma.showSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(back.startsAt.getTime()).toBe(INSTANT.getTime());

      // read of a CORRECTLY stored instant (written by SQL with an explicit offset): 9 hours late, model and raw
      await db.query(`UPDATE show_sessions SET starts_at = '2030-01-02 03:04:05.678+00', updated_at = now() WHERE id = $1`, [session.id]);
      const model = await prisma.showSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(model.startsAt.getTime() - INSTANT.getTime()).toBe(NINE_HOURS);
      const [raw] = await prisma.$queryRaw<{ s: Date }[]>`SELECT starts_at AS s FROM show_sessions WHERE id = ${session.id}::uuid`;
      expect(raw.s.getTime() - INSTANT.getTime()).toBe(NINE_HOURS);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("an `options` value in the connection string overrides the config field (why such URLs are refused)", async () => {
    const url = `${db.url}?options=${encodeURIComponent("-c TimeZone=Asia/Seoul")}`;
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: "-c TimeZone=UTC" }) });
    try {
      const [{ tz }] = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
      expect(tz).toBe("Asia/Seoul");
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("TZ-02 every application connection runs in UTC", () => {
  it("the app client's session TimeZone is UTC on a Seoul-default database", async () => {
    const { prisma } = await loadApp();
    try {
      const [{ tz }] = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
      expect(tz).toBe("UTC");
    } finally {
      await prisma.$disconnect();
    }
  });

  it("several connections opened concurrently by the pool are all UTC", async () => {
    const { prisma } = await loadApp();
    const N = 5;
    try {
      // Each interactive transaction holds its own pooled connection until all have reported, forcing N connections.
      let arrived = 0;
      let release!: () => void;
      const allArrived = new Promise<void>((r) => (release = r));
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          prisma.$transaction(
            async (tx) => {
              const [row] = await tx.$queryRaw<{ pid: number; tz: string }[]>`
                SELECT pg_backend_pid() AS pid, current_setting('TimeZone') AS tz`;
              if (++arrived === N) release();
              await allArrived;
              return row;
            },
            { timeout: 10_000, maxWait: 10_000 },
          ),
        ),
      );
      expect(new Set(results.map((r) => r.pid)).size).toBe(N);
      expect(results.map((r) => r.tz)).toEqual(Array(N).fill("UTC"));
    } finally {
      await prisma.$disconnect();
    }
  });

  it("a connection opened later (after the pool was closed and recreated) is UTC too", async () => {
    const first = await loadApp();
    await first.prisma.$queryRaw`SELECT 1`;
    await first.prisma.$disconnect(); // ends the first pool and its connections
    delete (globalThis as { __nazirPrisma?: unknown }).__nazirPrisma;
    const second = await loadApp(); // a new client, a new pool, a newly opened connection
    try {
      const [b] = await second.prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
      expect(b.tz).toBe("UTC");
    } finally {
      await second.prisma.$disconnect();
    }
  });

  it("refuses a DATABASE_URL that sets its own `options` (it would override the UTC session)", async () => {
    await expect(loadApp(`${db.url}?options=${encodeURIComponent("-c TimeZone=Asia/Seoul")}`)).rejects.toThrow(
      /must not set the "options" connection parameter/,
    );
  });
});

describe("TZ-03 DateTime write/read round trip keeps the instant", () => {
  it("model write → model read, raw read, transaction read and stored epoch all agree", async () => {
    const { prisma } = await loadApp();
    try {
      const { show, session } = await mkShowAndSession(prisma, INSTANT);
      const opens = new Date("2029-12-31T15:00:00.000Z"); // 2030-01-01 00:00 KST: a date-line case
      await prisma.show.update({ where: { id: show.id }, data: { salesOpensAt: opens } });

      expect(await epochMs("show_sessions", "starts_at", session.id)).toBe(INSTANT.getTime());
      expect(await epochMs("shows", "sales_opens_at", show.id)).toBe(opens.getTime());

      const model = await prisma.showSession.findUniqueOrThrow({ where: { id: session.id }, include: { show: true } });
      expect(model.startsAt.toISOString()).toBe(INSTANT.toISOString());
      expect(model.show.salesOpensAt?.toISOString()).toBe(opens.toISOString());

      const [raw] = await prisma.$queryRaw<{ s: Date }[]>`SELECT starts_at AS s FROM show_sessions WHERE id = ${session.id}::uuid`;
      expect(raw.s.toISOString()).toBe(INSTANT.toISOString());

      const inTx = await prisma.$transaction((tx) => tx.showSession.findUniqueOrThrow({ where: { id: session.id } }), {
        isolationLevel: "ReadCommitted",
      });
      expect(inTx.startsAt.toISOString()).toBe(INSTANT.toISOString());

      // a filter on a DateTime compares instants too
      const hit = await prisma.showSession.count({ where: { id: session.id, startsAt: { gte: INSTANT, lte: INSTANT } } });
      expect(hit).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("a value written by SQL (microseconds, Seoul literal) reads back as the same instant, truncated to ms", async () => {
    const { prisma } = await loadApp();
    try {
      const { session } = await mkShowAndSession(prisma, INSTANT);
      await db.query(
        `UPDATE show_sessions SET starts_at = '2030-01-02 12:04:05.678901+09', updated_at = now() WHERE id = $1`,
        [session.id],
      );
      const model = await prisma.showSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(model.startsAt.toISOString()).toBe("2030-01-02T03:04:05.678Z");
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("TZ-04 DbClock and model reads agree", () => {
  it("inside one transaction, a model read of now() equals DbClock(tx).now()", async () => {
    const { prisma, DbClock } = await loadApp();
    try {
      const { session } = await mkShowAndSession(prisma, INSTANT);
      const [modelNow, clockNow] = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`UPDATE show_sessions SET starts_at = now(), updated_at = now() WHERE id = ${session.id}::uuid`;
          const row = await tx.showSession.findUniqueOrThrow({ where: { id: session.id } });
          return [row.startsAt, await new DbClock(tx).now()];
        },
        { isolationLevel: "ReadCommitted" },
      );
      expect(modelNow.getTime()).toBe(clockNow.getTime());
    } finally {
      await prisma.$disconnect();
    }
  });

  it("the app clock matches the server's epoch time, not a shifted one", async () => {
    const { prisma, clock } = await loadApp();
    try {
      const before = Number((await db.query<{ ms: string }>("SELECT floor(extract(epoch FROM now())*1000)::bigint::text AS ms")).rows[0].ms);
      const now = (await clock.now()).getTime();
      const after = Number((await db.query<{ ms: string }>("SELECT floor(extract(epoch FROM now())*1000)::bigint::text AS ms")).rows[0].ms);
      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(after);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("TZ-05 sales status computed from app reads is correct on a Seoul-default database", () => {
  it("a started session is CLOSED and an upcoming one ON_SALE; a passed close time is CLOSED", async () => {
    const app = await loadApp();
    const unfixed = unfixedClient();
    try {
      const { show, session: started } = await mkShowAndSession(app.prisma, INSTANT);
      const later = await app.prisma.showSession.create({
        data: { showId: show.id, venueId: show.venueId, startsAt: INSTANT, salesStatus: "ON_SALE" },
      });
      const { show: closedShow, session: closedWindow } = await mkShowAndSession(app.prisma, INSTANT);
      // Times relative to the DATABASE clock, set in SQL so they do not depend on any session TimeZone.
      await db.query(`UPDATE shows SET sales_opens_at = now() - interval '1 hour', updated_at = now() WHERE id = $1`, [show.id]);
      await db.query(`UPDATE show_sessions SET starts_at = now() - interval '1 minute', updated_at = now() WHERE id = $1`, [started.id]);
      await db.query(`UPDATE show_sessions SET starts_at = now() + interval '30 minutes', updated_at = now() WHERE id = $1`, [later.id]);
      await db.query(
        `UPDATE shows SET sales_closes_at = now() - interval '1 minute', updated_at = now() WHERE id = $1`,
        [closedShow.id],
      );
      await db.query(`UPDATE show_sessions SET starts_at = now() + interval '2 hours', updated_at = now() WHERE id = $1`, [closedWindow.id]);

      const statusVia = async (client: PrismaClient, sessionId: string) => {
        const s = await client.showSession.findUniqueOrThrow({ where: { id: sessionId }, include: { show: true } });
        return app.computeSalesStatus({
          show: { status: s.show.status, salesOpensAt: s.show.salesOpensAt, salesClosesAt: s.show.salesClosesAt },
          session: { salesStatus: s.salesStatus, startsAt: s.startsAt },
          seats: { available: 1, held: 0 },
          now: await app.clock.now(),
        });
      };

      expect(await statusVia(app.prisma, started.id)).toBe("CLOSED");
      expect(await statusVia(app.prisma, later.id)).toBe("ON_SALE");
      expect(await statusVia(app.prisma, closedWindow.id)).toBe("CLOSED");

      // Negative control: the same rows read through the unfixed adapter (every time +9h) give wrong statuses —
      // the started session looks not yet open, and the show whose sales window already closed looks on sale.
      expect(await statusVia(unfixed, started.id)).toBe("UPCOMING");
      expect(await statusVia(unfixed, closedWindow.id)).toBe("ON_SALE");
    } finally {
      await app.prisma.$disconnect();
      await unfixed.$disconnect();
    }
  });
});
