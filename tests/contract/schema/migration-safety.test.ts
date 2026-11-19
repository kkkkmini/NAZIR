/**
 * S1 — migration atomicity.
 *
 * Prisma Migrate does not run a migration in a transaction. If statement N fails, statements 1..N-1 stay applied and the
 * migration is recorded as failed, which blocks every later `migrate deploy` (P3009). The repository's migrations are
 * therefore wrapped in BEGIN; ... COMMIT; and these tests prove, with the REAL Prisma CLI and a REAL failure injected
 * into the REAL migration files, that:
 *   - nothing of a failed migration remains (tables, indexes, constraints, triggers, functions);
 *   - earlier migrations are untouched;
 *   - the documented recovery (`migrate resolve --rolled-back`, then re-deploy) works;
 *   - without the wrapper the same failure DOES leave partial objects (so the tests above are not vacuous).
 *
 * MIG-09 is the static rule that keeps future migrations wrapped; MIG-10 is the dynamic proof.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkAll, checkMigrationTransactionality } from "./contract";
import { MIGRATIONS_DIR, createDatabase, dropDatabase, makeTempMigrationProject, newThrowawayName, resolveTestServer, type TempMigrationProject } from "./helpers/pg";

const server = resolveTestServer();
const dirs = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

describe("MIG-09 every migration is transactional", () => {
  it("all repository migrations are wrapped in BEGIN ... COMMIT", () => {
    const violations = dirs().flatMap((d) => checkMigrationTransactionality(d, readFileSync(join(MIGRATIONS_DIR, d, "migration.sql"), "utf8")));
    expect(violations).toEqual([]);
  });

  describe("the rule detects what it must (it is not vacuous)", () => {
    const check = (sql: string) => checkMigrationTransactionality("m", sql);
    it("accepts a wrapped migration, including function bodies that contain semicolons", () => {
      expect(check(`-- c\nBEGIN;\nCREATE TABLE a (id int);\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;\nCOMMIT;\n`)).toEqual([]);
    });
    it.each([
      ["no wrapper at all", `CREATE TABLE a (id int);`, /first statement must be BEGIN/],
      ["BEGIN without COMMIT", `BEGIN;\nCREATE TABLE a (id int);`, /last statement must be COMMIT/],
      ["COMMIT without BEGIN", `CREATE TABLE a (id int);\nCOMMIT;`, /first statement must be BEGIN/],
      ["a COMMIT in the middle (later statements run outside the transaction)", `BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;\nCREATE TABLE b (id int);\nCOMMIT;`, /transaction control inside the wrapper/],
      ["CREATE INDEX CONCURRENTLY inside the wrapper", `BEGIN;\nCREATE INDEX CONCURRENTLY i ON a (id);\nCOMMIT;`, /cannot run inside a transaction/],
      ["VACUUM inside the wrapper", `BEGIN;\nVACUUM a;\nCOMMIT;`, /cannot run inside a transaction/],
      ["an empty file", `-- nothing`, /empty migration/],
    ])("rejects %s", (_name, sql, re) => {
      expect(check(sql).join("\n")).toMatch(re);
    });
    it("a documented no-transaction migration is accepted only without transaction control", () => {
      expect(check(`-- no-transaction: CREATE INDEX CONCURRENTLY cannot run in a transaction\nCREATE INDEX CONCURRENTLY i ON a (id);`)).toEqual([]);
      expect(check(`-- no-transaction: x\nBEGIN;\nSELECT 1;\nCOMMIT;`).join()).toMatch(/marker but also contains transaction control/);
    });
  });
});

describe("MIG-10 a failing migration leaves nothing behind, and the documented recovery works", () => {
  let project: TempMigrationProject;
  let dbName = "";
  const url = () => server.urlFor(dbName);

  beforeAll(async () => {
    dbName = newThrowawayName();
    await createDatabase(server, dbName);
  });
  afterAll(async () => {
    await dropDatabase(server, dbName);
  });
  afterEach(() => project?.cleanup());

  // everything a migration can create, as one comparable list
  async function objects(): Promise<{ tables: string[]; indexes: string[]; constraints: string[]; triggers: string[]; functions: string[] }> {
    const c = new Client({ connectionString: url() });
    await c.connect();
    try {
      const list = async (sql: string) => (await c.query<{ n: string }>(sql)).rows.map((r) => r.n);
      return {
        tables: await list(`SELECT table_name n FROM information_schema.tables WHERE table_schema='public' AND table_name <> '_prisma_migrations' ORDER BY 1`),
        indexes: await list(`SELECT indexname n FROM pg_indexes WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY 1`),
        constraints: await list(`SELECT conname n FROM pg_constraint WHERE connamespace='public'::regnamespace AND conrelid <> '_prisma_migrations'::regclass ORDER BY 1`),
        triggers: await list(`SELECT tgname n FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
        functions: await list(`SELECT proname n FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY 1`),
      };
    } finally {
      await c.end();
    }
  }
  async function migrationRows() {
    const c = new Client({ connectionString: url() });
    await c.connect();
    try {
      return (await c.query<{ migration_name: string; finished: boolean; rolled_back: boolean }>(
        `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
           FROM _prisma_migrations ORDER BY started_at, migration_name`,
      )).rows;
    } finally {
      await c.end();
    }
  }
  /** Same file, but the last statement before COMMIT fails (division by zero) — after everything else has run. */
  const injectFailure = (sql: string) => {
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    return sql.trimEnd().replace(/COMMIT;$/, "SELECT 1 / 0; -- injected failure\nCOMMIT;\n");
  };
  const reset = async () => {
    await dropDatabase(server, dbName);
    await createDatabase(server, dbName);
  };

  it("the baseline migration fails at its very last statement: NO table, index, constraint or function remains; recovery succeeds", async () => {
    await reset();
    const [init] = dirs();
    project = makeTempMigrationProject();
    const original = project.read(init);
    project.write(init, injectFailure(original));

    const failed = await project.run(["migrate", "deploy"], url());
    expect(failed.code, failed.stdout + failed.stderr).not.toBe(0);
    expect(await objects()).toEqual({ tables: [], indexes: [], constraints: [], triggers: [], functions: [] });
    expect(await migrationRows()).toEqual([{ migration_name: init, finished: false, rolled_back: false }]);

    // `migrate status` exits non-zero (its text does not always say "failed" - Prisma 7.10.1 prints only the pending list) ...
    const status = await project.run(["migrate", "status"], url());
    expect(status.code).not.toBe(0);

    // ... and `migrate deploy` is the reliable signal: a failed migration blocks every further deploy (P3009) and is named
    const blocked = await project.run(["migrate", "deploy"], url());
    expect(blocked.code).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toMatch(/P3009/);
    expect(blocked.stdout + blocked.stderr).toContain(init);

    // recovery: fix the SQL, mark the failed attempt rolled back, deploy again
    project.write(init, original);
    const resolved = await project.run(["migrate", "resolve", "--rolled-back", init], url());
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    const retry = await project.run(["migrate", "deploy"], url());
    expect(retry.code, retry.stdout + retry.stderr).toBe(0);

    const c = new Client({ connectionString: url() });
    await c.connect();
    try {
      expect(await checkAll(c)).toEqual([]); // the complete schema contract holds after the retry
    } finally {
      await c.end();
    }
    const rows = await migrationRows();
    expect(rows.filter((r) => r.finished && !r.rolled_back).map((r) => r.migration_name)).toEqual(dirs());
    expect(rows.some((r) => r.rolled_back && !r.finished)).toBe(true); // the failed attempt stays on record
  });

  it("the raw-SQL migration fails at its last statement: ALL of its objects roll back, the baseline stays, recovery succeeds", async () => {
    await reset();
    const [init, integrity] = dirs();
    project = makeTempMigrationProject();
    const original = project.read(integrity);
    project.write(integrity, injectFailure(original));

    const failed = await project.run(["migrate", "deploy"], url());
    expect(failed.code, failed.stdout + failed.stderr).not.toBe(0);

    const after = await objects();
    expect(after.tables).toHaveLength(27); // baseline committed and untouched
    // nothing from the failed migration: no partial/raw indexes, CHECKs, triggers or functions
    expect(after.triggers).toEqual([]);
    expect(after.functions).toEqual([]);
    for (const leaked of ["seat_holds_active_seat_uq", "orders_active_subject_session_uq", "payments_in_progress_order_uq", "payments_primary_order_uq", "tickets_valid_seat_uq", "review_cases_open_dedupe_uq"]) {
      expect(after.indexes, `${leaked} must not exist`).not.toContain(leaked);
    }
    expect(after.constraints.filter((n) => n.endsWith("_ck"))).toEqual([]); // not a single CHECK constraint
    expect(await migrationRows()).toEqual([
      { migration_name: init, finished: true, rolled_back: false },
      { migration_name: integrity, finished: false, rolled_back: false },
    ]);

    project.write(integrity, original);
    expect((await project.run(["migrate", "resolve", "--rolled-back", integrity], url())).code).toBe(0);
    const retry = await project.run(["migrate", "deploy"], url());
    expect(retry.code, retry.stdout + retry.stderr).toBe(0);
    const c = new Client({ connectionString: url() });
    await c.connect();
    try {
      expect(await checkAll(c)).toEqual([]);
    } finally {
      await c.end();
    }
    // idempotent afterwards
    const again = await project.run(["migrate", "deploy"], url());
    expect(again.stdout).toMatch(/No pending migrations/);
  });

  it("negative control: the SAME failure WITHOUT the BEGIN/COMMIT wrapper leaves the earlier statements applied", async () => {
    await reset();
    const [init] = dirs();
    project = makeTempMigrationProject();
    const unwrapped = project
      .read(init)
      .replace(/^BEGIN;$/m, "")
      .replace(/^COMMIT;$/m, "SELECT 1 / 0; -- injected failure");
    expect(unwrapped).not.toMatch(/^BEGIN;$/m);
    project.write(init, unwrapped);

    const failed = await project.run(["migrate", "deploy"], url());
    expect(failed.code).not.toBe(0);
    const leftover = await objects();
    // this is exactly what S1 prevents: a half-built schema that the next deploy cannot repair
    expect(leftover.tables).toHaveLength(27);
    expect(leftover.indexes.length).toBeGreaterThan(50);
    expect((await migrationRows())[0]).toMatchObject({ finished: false });
  });
});
