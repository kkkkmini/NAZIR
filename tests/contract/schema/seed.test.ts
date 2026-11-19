/**
 * Development seed (prisma/seed.ts): works, is idempotent, and cannot run outside local/test.
 * Uses the real `prisma db seed` entry point against a throwaway PostgreSQL database.
 */
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { cloneTestDb, destroyTestDb, resolveTestServer, runPrisma, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
beforeEach(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
});
afterEach(() => destroyTestDb(db));

const seed = (env: Record<string, string>, target: TestDb = db) => runPrisma(["db", "seed"], { databaseUrl: target.url, env });

async function counts(target: TestDb = db) {
  const { rows } = await target.query<Record<string, string>>(`
    SELECT (SELECT count(*) FROM venues) AS venues, (SELECT count(*) FROM shows) AS shows,
           (SELECT count(*) FROM show_sessions) AS sessions, (SELECT count(*) FROM seats) AS seats,
           (SELECT count(*) FROM session_seats) AS session_seats`);
  return Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
}

describe("seed", () => {
  it("SEED-01 creates the placeholder venue, show, sessions, seats and per-session sale seats", async () => {
    const res = await seed({ NAZIR_RUNTIME_ENV: "test" });
    expect(res.code, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(await counts()).toEqual({ venues: 1, shows: 1, sessions: 2, seats: 78, session_seats: 156 });

    const { rows } = await db.query<{ n: string }>(`
      SELECT count(*) AS n FROM session_seats ss JOIN show_sessions s ON s.id = ss.show_session_id
       WHERE ss.status = 'AVAILABLE' AND ss.sold_order_item_id IS NULL AND ss.price IN (110000, 150000)`);
    expect(Number(rows[0].n)).toBe(156);
    const labelled = await db.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM venues WHERE name LIKE '[DEV SEED]%') + (SELECT count(*) FROM shows WHERE title LIKE '[DEV SEED]%') AS n`,
    );
    expect(Number(labelled.rows[0].n)).toBe(2);
  });

  it("SEED-02 is idempotent: running it again changes nothing", async () => {
    expect((await seed({ NAZIR_RUNTIME_ENV: "test" })).code).toBe(0);
    const fingerprint = async () =>
      (await db.query<{ h: string }>(`
        SELECT md5(string_agg(id::text, ',' ORDER BY id)) AS h FROM (
          SELECT id FROM venues UNION ALL SELECT id FROM shows UNION ALL SELECT id FROM show_sessions
          UNION ALL SELECT id FROM seats UNION ALL SELECT id FROM session_seats) x`)).rows[0].h;
    const before = { counts: await counts(), h: await fingerprint() };

    const again = await seed({ NAZIR_RUNTIME_ENV: "test" });
    expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
    expect({ counts: await counts(), h: await fingerprint() }).toEqual(before);
  });

  it.each([
    ["production", "production"],
    ["missing NAZIR_RUNTIME_ENV (fail-closed => production)", ""],
    ["unknown value", "prod"],
    ["staging", "staging"],
  ])("SEED-03 refuses to run with %s and writes nothing", async (_label, value) => {
    // A database that is not a *_test database: the Prisma CLI's own environment guard (prisma.config.ts) lets these
    // combinations through, so the seed guard's environment rule is what refuses them.
    const dev = await cloneTestDb(server, inject("templateDb"), "dev");
    try {
      const res = await seed({ NAZIR_RUNTIME_ENV: value }, dev);
      expect(res.code).not.toBe(0);
      expect(res.stdout + res.stderr).toMatch(/only runs with NAZIR_RUNTIME_ENV=local or test/);
      expect(await counts(dev)).toEqual({ venues: 0, shows: 0, sessions: 0, seats: 0, session_seats: 0 });
    } finally {
      await destroyTestDb(dev);
    }
  });

  it.each(["production", "", "prod", "staging"])(
    "SEED-03b a test database with NAZIR_RUNTIME_ENV=%j is refused as well (by the CLI guard, before the seed runs) and nothing is written",
    async (value) => {
      const res = await seed({ NAZIR_RUNTIME_ENV: value });
      expect(res.code).not.toBe(0);
      expect(res.stdout + res.stderr).toMatch(/must not be used with NAZIR_RUNTIME_ENV=(production|staging)/);
      expect(await counts()).toEqual({ venues: 0, shows: 0, sessions: 0, seats: 0, session_seats: 0 });
    },
  );

  it("SEED-04 refuses a test database in a non-test environment (database/environment cross-check)", async () => {
    const res = await seed({ NAZIR_RUNTIME_ENV: "local" }); // throwaway DBs are *_test databases
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/must not be used with NAZIR_RUNTIME_ENV=local/);
    expect(await counts()).toEqual({ venues: 0, shows: 0, sessions: 0, seats: 0, session_seats: 0 });
  });
});
