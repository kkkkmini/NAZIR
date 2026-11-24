/**
 * DB-06: the application runtime connects with DATABASE_URL (Neon: the POOLED URL) and never with DATABASE_URL_UNPOOLED,
 * which is reserved for the Prisma CLI and the seed (DB-05, SEED-06). Real PostgreSQL, real app path (`getPrisma()`).
 *
 * Technique: both variables name the same database and one of them carries a WRONG password — the connection that
 * works shows which URL the app really uses.
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

const MARKER = "wrong-pw-db06";
const broken = (raw: string) => {
  const u = new URL(raw);
  u.password = MARKER;
  return u.toString();
};

async function loadApp(env: { DATABASE_URL: string; DATABASE_URL_UNPOOLED?: string }) {
  vi.stubEnv("NAZIR_RUNTIME_ENV", "test");
  vi.stubEnv("PAYMENT_PROVIDER", "mock");
  vi.stubEnv("IDENTITY_PROVIDER", "mock");
  vi.stubEnv("DATABASE_URL", env.DATABASE_URL);
  vi.stubEnv("DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED ?? "");
  vi.resetModules();
  return (await import("../../../src/server/db/client")).getPrisma();
}

describe("DB-06 runtime connection = DATABASE_URL", () => {
  it("works with a correct DATABASE_URL even though DATABASE_URL_UNPOOLED is broken; the session is UTC", async () => {
    const prisma = await loadApp({ DATABASE_URL: db.url, DATABASE_URL_UNPOOLED: broken(db.url) });
    try {
      const [row] = await prisma.$queryRaw<{ db: string; tz: string }[]>`
        SELECT current_database() AS db, current_setting('TimeZone') AS tz`;
      expect(row).toEqual({ db: db.name, tz: "UTC" });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("fails with a broken DATABASE_URL even though DATABASE_URL_UNPOOLED is correct, without printing the password", async () => {
    const prisma = await loadApp({ DATABASE_URL: broken(db.url), DATABASE_URL_UNPOOLED: db.url });
    try {
      const err = await prisma.$queryRaw`SELECT 1`.then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).not.toBeNull();
      expect(String(err?.message)).not.toContain(MARKER);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("DATABASE_URL alone keeps working (local development)", async () => {
    const prisma = await loadApp({ DATABASE_URL: db.url });
    try {
      const [row] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
      expect(row.db).toBe(db.name);
    } finally {
      await prisma.$disconnect();
    }
  });
});
