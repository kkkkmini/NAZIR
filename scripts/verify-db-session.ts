/**
 * Verifies, against a REAL database reached the way the app reaches it, the session behaviour the app depends on.
 * Intended for the Neon pooled URL after a deployment (`npm run verify:db-session`), and usable on any environment.
 *
 * NON-DESTRUCTIVE by construction — safe on a shared database:
 *   - only TEMP tables created inside a transaction (`ON COMMIT DROP`) and transaction-scoped advisory locks;
 *   - no application table is read for update, written, truncated or altered; nothing persists after the run.
 *
 * Checks (DATABASE.md §19.10-5, §19.12):
 *   1. session TimeZone is UTC on every connection opened with the app's driver settings (buildPgPoolConfig)
 *   2. an interactive READ COMMITTED transaction stays on ONE server connection (statement after statement), and
 *      `SELECT … FOR UPDATE` works inside it
 *   3. a lock taken in one transaction is visible to a concurrent transaction (pg_try_advisory_xact_lock is refused)
 *   4. a DEFERRABLE INITIALLY DEFERRED constraint fails at COMMIT (SQLSTATE 23505), and the failed transaction leaves
 *      nothing behind
 *
 * Connection: DATABASE_URL (the app's runtime URL), validated with the server's startup rule first. Output: database
 * description (host/port/name) and results only — never a URL or password.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { DatabaseConfigError, assertRuntimeDatabaseConfig, describeDatabase } from "../src/server/config/database-config";
import { resolveRuntimeEnv } from "../src/server/config/runtime-config";
import { buildPgPoolConfig } from "../src/server/db/pg-adapter";

type Result = { check: string; ok: boolean; detail: string };

async function main(): Promise<number> {
  const { runtimeEnv } = resolveRuntimeEnv(process.env);
  const db = assertRuntimeDatabaseConfig(runtimeEnv, process.env);
  if (!db) throw new DatabaseConfigError("DATABASE_URL is not set");
  console.log(JSON.stringify({ runtimeEnv, database: describeDatabase(db.pooled) }));

  const prisma = new PrismaClient({ adapter: new PrismaPg(buildPgPoolConfig(process.env.DATABASE_URL)) });
  const results: Result[] = [];
  const record = (check: string, ok: boolean, detail: string) => results.push({ check, ok, detail });
  try {
    // 1. TimeZone on several connections (concurrent transactions force distinct server connections)
    const zones = await Promise.all(
      Array.from({ length: 3 }, () =>
        prisma.$transaction(async (tx) => {
          const [r] = await tx.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
          await tx.$executeRaw`SELECT pg_sleep(0.2)`;
          return r.tz;
        }),
      ),
    );
    record("1 session TimeZone = UTC", zones.every((z) => z === "UTC"), `TimeZone per connection: ${zones.join(", ")}`);

    // 2. one server connection per transaction + FOR UPDATE inside it
    const pinned = await prisma.$transaction(
      async (tx) => {
        const pids: number[] = [];
        for (let i = 0; i < 3; i++) pids.push((await tx.$queryRaw<{ p: number }[]>`SELECT pg_backend_pid() AS p`)[0].p);
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE nazir_verify_lock (id int PRIMARY KEY) ON COMMIT DROP`);
        await tx.$executeRawUnsafe(`INSERT INTO nazir_verify_lock VALUES (1)`);
        const locked = await tx.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM nazir_verify_lock WHERE id = 1 FOR UPDATE`);
        const [iso] = await tx.$queryRaw<{ i: string }[]>`SELECT current_setting('transaction_isolation') AS i`;
        return { pids, locked: locked.length, iso: iso.i };
      },
      { isolationLevel: "ReadCommitted" },
    );
    record(
      "2 transaction pinned to one connection, FOR UPDATE works",
      new Set(pinned.pids).size === 1 && pinned.locked === 1 && pinned.iso === "read committed",
      `backend pids in one transaction: ${[...new Set(pinned.pids)].length} distinct; FOR UPDATE rows: ${pinned.locked}; isolation: ${pinned.iso}`,
    );

    // 3. lock contention across two concurrent transactions (transaction-scoped advisory lock, released at commit)
    const key = 0x4e415a49; // "NAZI"
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const holderReady = new Promise<void>((r) => (taken = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(${key}::bigint)::text`;
        taken();
        await held;
      },
      { timeout: 15_000, maxWait: 15_000 },
    );
    await holderReady;
    const [other] = await prisma.$transaction((tx) => tx.$queryRaw<{ got: boolean }[]>`SELECT pg_try_advisory_xact_lock(${key}::bigint) AS got`);
    release();
    await holder;
    record("3 lock held by one transaction is refused to another", other.got === false, `concurrent pg_try_advisory_xact_lock returned ${other.got}`);

    // 4. deferred constraint violation surfaces at COMMIT
    let commitError: { code?: string; message: string } | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE nazir_verify_deferred (k int, CONSTRAINT nazir_verify_deferred_uq UNIQUE (k) DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP`,
        );
        await tx.$executeRawUnsafe(`INSERT INTO nazir_verify_deferred VALUES (1), (1)`); // accepted until COMMIT
      });
    } catch (e) {
      // A COMMIT-time error from $transaction arrives as a raw DriverAdapterError (`cause.originalCode`); a statement-time
      // error is wrapped in PrismaClientKnownRequestError (`meta.driverAdapterError.cause.originalCode`). Read both.
      const err = e as {
        message: string;
        cause?: { originalCode?: string };
        meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
      };
      commitError = {
        code: err.cause?.originalCode ?? err.meta?.driverAdapterError?.cause?.originalCode,
        message: err.message.split("\n")[0],
      };
    }
    const [left] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'nazir_verify_deferred'`;
    record(
      "4 deferred constraint fails at COMMIT and leaves nothing",
      commitError !== null && commitError.code === "23505" && left.n === 0,
      commitError ? `COMMIT error SQLSTATE ${commitError.code ?? "?"}; leftover tables: ${left.n}` : "COMMIT unexpectedly succeeded",
    );
  } finally {
    await prisma.$disconnect();
  }
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check} — ${r.detail}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    // DatabaseConfigError messages never contain a URL; for anything else print only the first line.
    console.error(e instanceof DatabaseConfigError ? e.message : `verify failed: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
    process.exit(2);
  },
);
