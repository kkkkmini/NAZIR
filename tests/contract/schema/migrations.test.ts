/**
 * TEST_PLAN §2 — P0 schema contract / migration tests (MIG-01 … MIG-07) plus DRIFT-01.
 *
 * Everything runs against a real PostgreSQL server and reads the live catalog. Nothing here passes
 * merely because schema.prisma declares an object.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  checkAll,
  checkChecks,
  checkForeignKeys,
  checkImmutableTrigger,
  checkPartialUniques,
  checkTables,
  checkTypes,
  checkUniques,
  findProtectedDrops,
} from "./contract";
import { TABLES } from "./manifest";
import {
  MIGRATIONS_DIR,
  SCHEMA_PATH,
  cloneTestDb,
  createDatabase,
  destroyTestDb,
  dropDatabase,
  newThrowawayName,
  resolveTestServer,
  runPrisma,
  type TestDb,
} from "./helpers/pg";

const server = resolveTestServer();
const migrationDirs = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

describe("MIG-01 migrate deploy on an empty PostgreSQL", () => {
  const name = newThrowawayName();
  beforeAll(() => createDatabase(server, name));
  afterAll(() => dropDatabase(server, name));

  it("applies every migration successfully from scratch", async () => {
    const res = await runPrisma(["migrate", "deploy"], { databaseUrl: server.urlFor(name) });
    expect(res.code, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(res.stdout).toMatch(/All migrations have been successfully applied/);

    const c = new Client({ connectionString: server.urlFor(name) });
    await c.connect();
    try {
      const { rows: ver } = await c.query<{ n: number; v: string }>(
        `SELECT current_setting('server_version_num')::int AS n, current_setting('server_version') AS v`,
      );
      console.log(`[MIG-01] PostgreSQL ${ver[0].v}`);
      // NULLS NOT DISTINCT (DATABASE.md §4.4) needs PostgreSQL 15+; the project targets 16.
      expect(ver[0].n).toBeGreaterThanOrEqual(150000);

      const { rows } = await c.query<{ migration_name: string; finished: boolean; rolled_back: boolean }>(
        `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
           FROM _prisma_migrations ORDER BY migration_name`,
      );
      expect(rows.map((r) => r.migration_name)).toEqual(migrationDirs());
      expect(rows.every((r) => r.finished && !r.rolled_back)).toBe(true);

      expect(await checkTables(c)).toEqual([]);
      expect(TABLES).toHaveLength(27);
    } finally {
      await c.end();
    }
  });

  it("is idempotent: a second deploy has nothing to apply", async () => {
    const again = await runPrisma(["migrate", "deploy"], { databaseUrl: server.urlFor(name) });
    expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
    expect(again.stdout).toMatch(/No pending migrations to apply/);
    const status = await runPrisma(["migrate", "status"], { databaseUrl: server.urlFor(name) });
    expect(status.code, `${status.stdout}\n${status.stderr}`).toBe(0);
    expect(status.stdout).toMatch(/Database schema is up to date/);
  });

  it("leaves a database that satisfies the whole contract", async () => {
    const c = new Client({ connectionString: server.urlFor(name) });
    await c.connect();
    try {
      expect(await checkAll(c)).toEqual([]);
    } finally {
      await c.end();
    }
  });
});

describe("MIG-02..05, MIG-07 contract on the migrated database", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await cloneTestDb(server, inject("templateDb"));
  });
  afterAll(() => destroyTestDb(db));

  it("MIG-02 required partial unique indexes exist with matching columns and predicates", async () => {
    expect(await checkPartialUniques(db)).toEqual([]);
  });

  it("MIG-03 required CHECK constraints exist and are validated", async () => {
    const violations = await checkChecks(db);
    expect(violations.filter((v) => v.startsWith("missing CHECK") || v.includes("NOT VALID"))).toEqual([]);
  });

  it("MIG-03b status vocabularies in the database equal the application constants", async () => {
    const violations = await checkChecks(db);
    expect(violations.filter((v) => v.includes("application constants"))).toEqual([]);
    expect(violations).toEqual([]);
  });

  it("MIG-04 required composite foreign keys exist; every FK is RESTRICT/RESTRICT", async () => {
    expect(await checkForeignKeys(db)).toEqual([]);
  });

  it("MIG-05 (catalog) seats unique is UNIQUE NULLS NOT DISTINCT; other uniques are as specified", async () => {
    expect(await checkUniques(db)).toEqual([]);
    const { rows } = await db.query<{ nnd: boolean }>(
      `SELECT indnullsnotdistinct AS nnd FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
        WHERE i.relname = 'seats_venue_section_row_number_nnd_uq'`,
    );
    expect(rows).toEqual([{ nnd: true }]);
  });

  it("MIG-07 time columns are timestamptz, money is bigint, ids are uuid", async () => {
    expect(await checkTypes(db)).toEqual([]);
  });

  it("rule 14 trigger exists (BEFORE UPDATE, row level, enabled)", async () => {
    expect(await checkImmutableTrigger(db)).toEqual([]);
  });
});

describe("DB_CONSTRAINT names used for domain-error mapping exist in the database", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await cloneTestDb(server, inject("templateDb"));
  });
  afterAll(() => destroyTestDb(db));

  it("each name is an index, a constraint, or a name raised by a constraint-trigger function", async () => {
    const { DB_CONSTRAINT } = await import("../../../src/server/db/constants");
    const { rows } = await db.query<{ n: string }>(`
      SELECT relname::text AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace
      UNION SELECT conname::text FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      UNION SELECT (regexp_matches(prosrc, 'CONSTRAINT = ''([a-z_]+)''', 'g'))[1] FROM pg_proc WHERE pronamespace = 'public'::regnamespace`);
    const have = new Set(rows.map((r) => r.n));
    const missing = Object.entries(DB_CONSTRAINT).filter(([, name]) => !have.has(name));
    expect(missing).toEqual([]);
  });
});

describe("negative controls: the checkers fail on a sabotaged database", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await cloneTestDb(server, inject("templateDb"));
    const sabotage = [
      `DROP INDEX seat_holds_active_seat_uq`, // MIG-02: missing
      `DROP INDEX orders_active_subject_session_uq`,
      `CREATE UNIQUE INDEX orders_active_subject_session_uq ON orders (identity_subject_id, show_session_id)`, // not partial
      `DROP INDEX payments_in_progress_order_uq`,
      `CREATE UNIQUE INDEX payments_in_progress_order_uq ON payments (order_id) WHERE status IN ('READY')`, // wrong predicate
      `DROP INDEX seats_venue_section_row_number_nnd_uq`,
      `CREATE UNIQUE INDEX seats_venue_section_row_number_nnd_uq ON seats (venue_id, section_name, row_label, seat_number)`, // plain unique
      `ALTER TABLE payments DROP CONSTRAINT payments_refunded_amount_ck`, // MIG-03: missing
      `ALTER TABLE orders DROP CONSTRAINT orders_status_ck`,
      `ALTER TABLE orders ADD CONSTRAINT orders_status_ck CHECK (status IN ('PENDING','PAID'))`, // vocabulary drift
      `ALTER TABLE orders DROP CONSTRAINT orders_confirmed_payment_fk`, // MIG-04: missing
      `ALTER TABLE order_items DROP CONSTRAINT order_items_seat_session_fk`,
      `ALTER TABLE order_items ADD CONSTRAINT order_items_seat_session_fk FOREIGN KEY (session_seat_id, show_session_id)
         REFERENCES session_seats (id, show_session_id) ON DELETE CASCADE`, // cascade is forbidden
      `ALTER TABLE orders ALTER COLUMN hold_expires_at TYPE timestamp`, // MIG-07
      `ALTER TABLE payments ALTER COLUMN requested_amount TYPE integer`,
      `DROP TRIGGER order_items_no_update ON order_items`,
    ];
    for (const s of sabotage) await db.query(s);
  });
  afterAll(() => destroyTestDb(db));

  it("MIG-02 detects missing, non-partial and wrong-predicate indexes", async () => {
    const v = (await checkPartialUniques(db)).join("\n");
    expect(v).toContain("missing partial unique index seat_holds_active_seat_uq");
    expect(v).toContain("orders_active_subject_session_uq: not partial");
    expect(v).toMatch(/payments_in_progress_order_uq: predicate values \[READY\] != expected/);
  });

  it("MIG-05 detects a plain unique where NULLS NOT DISTINCT is required", async () => {
    expect((await checkUniques(db)).join("\n")).toContain("seats_venue_section_row_number_nnd_uq: NULLS NOT DISTINCT is false");
  });

  it("MIG-03 detects missing CHECKs and vocabulary drift against the application constants", async () => {
    const v = (await checkChecks(db)).join("\n");
    expect(v).toContain("missing CHECK payments.payments_refunded_amount_ck");
    expect(v).toMatch(/orders_status_ck: database vocabulary \[PENDING, PAID\] != application constants/);
  });

  it("MIG-04 detects missing composite FKs and cascading actions", async () => {
    const v = (await checkForeignKeys(db)).join("\n");
    expect(v).toContain("missing composite FK orders.orders_confirmed_payment_fk");
    expect(v).toMatch(/FK order_items_seat_session_fk: ON UPDATE=a ON DELETE=c, expected RESTRICT\/RESTRICT/);
  });

  it("MIG-07 detects wrong column types", async () => {
    const v = (await checkTypes(db)).join("\n");
    expect(v).toContain("orders.hold_expires_at: timestamp without time zone");
    expect(v).toContain("payments.requested_amount: integer");
  });

  it("rule 14 detects a dropped immutability trigger", async () => {
    expect(await checkImmutableTrigger(db)).toEqual(["missing trigger order_items_no_update"]);
  });
});

describe("MIG-06 later migrations must not drop raw-SQL objects", () => {
  it("no existing migration drops a contract object", () => {
    const findings = migrationDirs().flatMap((dir) =>
      findProtectedDrops(dir, readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8")),
    );
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it("migrations are ordered and the raw-SQL migration follows the baseline", () => {
    const dirs = migrationDirs();
    expect(dirs).toEqual([...dirs].sort());
    expect(dirs[0]).toMatch(/_init_schema$/);
    expect(dirs[1]).toMatch(/_integrity_constraints$/);
    expect(readFileSync(join(MIGRATIONS_DIR, "migration_lock.toml"), "utf8")).toMatch(/provider\s*=\s*"postgresql"/);
  });

  describe("the scanner detects what it must (it is not vacuous)", () => {
    const scan = (sql: string) => findProtectedDrops("synthetic", sql);

    it.each([
      [`DROP INDEX "seat_holds_active_seat_uq";`, "seat_holds_active_seat_uq"],
      [`drop index if exists "orders_active_subject_session_uq";`, "orders_active_subject_session_uq"],
      [`DROP INDEX payments_in_progress_order_uq;`, "payments_in_progress_order_uq"],
      [`DROP INDEX "seats_venue_section_row_number_nnd_uq";`, "seats_venue_section_row_number_nnd_uq"],
      [`ALTER TABLE "payments" DROP CONSTRAINT "payments_refunded_amount_ck";`, "payments_refunded_amount_ck"],
      [`ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_confirmed_payment_fk";`, "orders_confirmed_payment_fk"],
      [`DROP TRIGGER "order_items_no_update" ON "order_items";`, "order_items_no_update"],
      [`DROP FUNCTION order_items_reject_change();`, "order_items_reject_change"],
      [`DROP TRIGGER "order_items_no_delete" ON "order_items";`, "order_items_no_delete"],
      [`DROP TRIGGER payments_primary_guard ON payments;`, "payments_primary_guard"],
      [`DROP FUNCTION orders_check_confirmed_payment();`, "orders_check_confirmed_payment"],
      [`DROP INDEX "payments_primary_order_uq";`, "payments_primary_order_uq"],
      [`ALTER TABLE "orders" DROP CONSTRAINT "orders_quota_fk";`, "orders_quota_fk"],
      [`ALTER TABLE "payments" DROP CONSTRAINT "payments_order_total_fk";`, "payments_order_total_fk"],
      [`DROP TABLE "tickets";`, "tickets"],
      [`ALTER TABLE "seat_holds" DROP COLUMN "status";`, "seat_holds.status"],
      [`ALTER TABLE "orders" ADD COLUMN x int, DROP COLUMN "confirmed_payment_id";`, "orders.confirmed_payment_id"],
    ])("flags %s", (sql, object) => {
      const f = scan(sql);
      expect(f.map((x) => x.object)).toContain(object);
    });

    it("ignores unrelated drops and commented-out statements", () => {
      expect(scan(`DROP INDEX "some_unrelated_idx"; ALTER TABLE "orders" DROP COLUMN "admin_memo";`)).toEqual([]);
      expect(scan(`-- DROP INDEX "seat_holds_active_seat_uq";\n/* DROP TABLE "orders"; */ SELECT 1;`)).toEqual([]);
    });
  });
});

describe("DRIFT-01 schema.prisma and the migrations describe the same database", () => {
  const diff = async (toSchema: string) => {
    // Prisma refuses a shadow database identical to the main one, so use two throwaway databases.
    const main = newThrowawayName();
    const shadow = newThrowawayName();
    await createDatabase(server, main);
    await createDatabase(server, shadow);
    try {
      return await runPrisma(
        ["migrate", "diff", "--from-migrations", MIGRATIONS_DIR, "--to-schema", toSchema, "--exit-code"],
        { databaseUrl: server.urlFor(main), shadowUrl: server.urlFor(shadow) },
      );
    } finally {
      await dropDatabase(server, main);
      await dropDatabase(server, shadow);
    }
  };

  it("prisma migrate diff (migrations -> schema) is empty, so no later migration would DROP a raw-SQL object", async () => {
    const res = await diff(SCHEMA_PATH);
    expect(res.code, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(res.stdout).toMatch(/No difference detected/);
  });

  it("negative control: a schema change that has no migration is reported (exit code 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nazir-drift-"));
    const tmp = join(dir, "schema.prisma");
    writeFileSync(tmp, readFileSync(SCHEMA_PATH, "utf8").replace("model Venue {", "model Venue {\n  driftProbe String?"));
    const res = await diff(tmp);
    expect(res.code, `${res.stdout}\n${res.stderr}`).toBe(2);
    expect(res.stdout).toMatch(/drift_?probe|driftProbe/i);
  });
});
