/**
 * Catalog checkers. Each function reads the LIVE database catalog and returns a list of violations
 * (empty = contract satisfied). Returning a list instead of asserting lets the tests also prove the
 * checkers are not vacuous: they must report violations against a deliberately sabotaged database.
 */
import {
  BIGINT_COLUMNS,
  CHECKS,
  COMPOSITE_FKS,
  CONSTRAINT_TRIGGERS,
  IMMUTABLE_TRIGGERS,
  NON_UUID_ID_COLUMNS,
  PARTIAL_UNIQUES,
  SMALLINT_COLUMNS,
  TABLES,
  UNIQUES,
} from "./manifest";

export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

const literals = (def: string): string[] => [...def.matchAll(/'([^']*)'/g)].map((m) => m[1]);
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === new Set(a).size && b.length === new Set(b).size && a.length === b.length && a.every((x) => b.includes(x));

interface IndexRow extends Record<string, unknown> {
  name: string;
  tbl: string;
  is_unique: boolean;
  is_valid: boolean;
  nulls_not_distinct: boolean;
  predicate: string | null;
  columns: string[];
}

async function indexes(db: Queryable): Promise<IndexRow[]> {
  const { rows } = await db.query<IndexRow>(`
    SELECT i.relname::text AS name, t.relname::text AS tbl,
           ix.indisunique AS is_unique, ix.indisvalid AS is_valid,
           ix.indnullsnotdistinct AS nulls_not_distinct,
           pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
           ARRAY(SELECT a.attname::text
                   FROM unnest(ix.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
                  ORDER BY k.ord)::text[] AS columns
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'`);
  return rows;
}

/** MIG-01 helper: exactly the 27 core tables exist (plus Prisma's bookkeeping table). */
export async function checkTables(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`,
  );
  const have = rows.map((r) => r.table_name);
  const out: string[] = [];
  for (const t of TABLES) if (!have.includes(t)) out.push(`missing table ${t}`);
  for (const t of have) if (!(TABLES as readonly string[]).includes(t)) out.push(`unexpected table ${t}`);
  return out;
}

/** MIG-02: required partial unique indexes exist with the documented columns and predicate. */
export async function checkPartialUniques(db: Queryable): Promise<string[]> {
  const idx = await indexes(db);
  const out: string[] = [];
  for (const spec of PARTIAL_UNIQUES) {
    const row = idx.find((i) => i.name === spec.name);
    if (!row) {
      out.push(`missing partial unique index ${spec.name} (${spec.rule})`);
      continue;
    }
    if (row.tbl !== spec.table) out.push(`${spec.name}: on table ${row.tbl}, expected ${spec.table}`);
    if (!row.is_unique) out.push(`${spec.name}: not UNIQUE`);
    if (!row.is_valid) out.push(`${spec.name}: index is not valid`);
    if (row.columns.join(",") !== spec.columns.join(",")) {
      out.push(`${spec.name}: columns (${row.columns.join(", ")}) != expected (${spec.columns.join(", ")})`);
    }
    if (!row.predicate) {
      out.push(`${spec.name}: not partial (no WHERE predicate) — would block legitimate history rows`);
      continue;
    }
    const lits = literals(row.predicate);
    const isNeq = row.predicate.includes("<>");
    if (!row.predicate.includes(spec.predicate.column)) {
      out.push(`${spec.name}: predicate does not reference ${spec.predicate.column}: ${row.predicate}`);
    }
    if ((spec.predicate.op === "neq") !== isNeq) {
      out.push(`${spec.name}: predicate operator mismatch: ${row.predicate}`);
    }
    if (!sameSet(lits, spec.predicate.values)) {
      out.push(`${spec.name}: predicate values [${lits.join(", ")}] != expected [${spec.predicate.values.join(", ")}]`);
    }
  }
  return out;
}

/** UNIQUE contract (incl. NULLS NOT DISTINCT for seats — MIG-05 catalog part). */
export async function checkUniques(db: Queryable): Promise<string[]> {
  const idx = await indexes(db);
  const out: string[] = [];
  for (const spec of UNIQUES) {
    const row = idx.find((i) => i.name === spec.name);
    if (!row) {
      out.push(`missing unique index ${spec.name}`);
      continue;
    }
    if (!row.is_unique) out.push(`${spec.name}: not UNIQUE`);
    if (row.predicate) out.push(`${spec.name}: unexpectedly partial (${row.predicate})`);
    if (row.tbl !== spec.table) out.push(`${spec.name}: on table ${row.tbl}, expected ${spec.table}`);
    if (row.columns.join(",") !== spec.columns.join(",")) {
      out.push(`${spec.name}: columns (${row.columns.join(", ")}) != expected (${spec.columns.join(", ")})`);
    }
    if (!!row.nulls_not_distinct !== !!spec.nullsNotDistinct) {
      out.push(`${spec.name}: NULLS NOT DISTINCT is ${row.nulls_not_distinct}, expected ${!!spec.nullsNotDistinct}`);
    }
  }
  return out;
}

/** MIG-03: every required CHECK exists, is validated, and vocabularies equal the app constants (MIG-03b). */
export async function checkChecks(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ name: string; tbl: string; validated: boolean; def: string }>(`
    SELECT c.conname::text AS name, t.relname::text AS tbl, c.convalidated AS validated,
           pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.contype = 'c' AND n.nspname = 'public'`);
  const out: string[] = [];
  for (const spec of CHECKS) {
    const row = rows.find((r) => r.name === spec.name);
    if (!row) {
      out.push(`missing CHECK ${spec.table}.${spec.name}${spec.rule ? ` (${spec.rule})` : ""}`);
      continue;
    }
    if (row.tbl !== spec.table) out.push(`${spec.name}: on table ${row.tbl}, expected ${spec.table}`);
    if (!row.validated) out.push(`${spec.name}: NOT VALID`);
    for (const col of spec.columns) {
      if (!row.def.includes(col)) out.push(`${spec.name}: definition does not reference column ${col}: ${row.def}`);
    }
    if (spec.vocab) {
      const lits = literals(row.def);
      if (!sameSet(lits, spec.vocab)) {
        out.push(`${spec.name}: database vocabulary [${lits.join(", ")}] != application constants [${spec.vocab.join(", ")}]`);
      }
    }
  }
  const known = new Set(CHECKS.map((c) => c.name));
  for (const r of rows) if (!known.has(r.name)) out.push(`CHECK ${r.tbl}.${r.name} is not listed in the contract manifest`);
  return out;
}

/** MIG-04: composite FKs exist with exact column mapping; ALL FKs are RESTRICT/RESTRICT, immediate, validated. */
export async function checkForeignKeys(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{
    name: string;
    tbl: string;
    ref_tbl: string;
    upd: string;
    del: string;
    validated: boolean;
    deferrable: boolean;
    match: string;
    cols: string[];
    ref_cols: string[];
  }>(`
    SELECT c.conname::text AS name, t.relname::text AS tbl, rt.relname::text AS ref_tbl,
           c.confupdtype::text AS upd, c.confdeltype::text AS del,
           c.convalidated AS validated, c.condeferrable AS deferrable, c.confmatchtype::text AS match,
           ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.ord)::text[] AS cols,
           ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, ord)
                   JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.ord)::text[] AS ref_cols
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class rt ON rt.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.contype = 'f' AND n.nspname = 'public'`);
  const out: string[] = [];
  for (const spec of COMPOSITE_FKS) {
    const row = rows.find((r) => r.name === spec.name);
    if (!row) {
      out.push(`missing composite FK ${spec.table}.${spec.name} (${spec.rule})`);
      continue;
    }
    if (row.tbl !== spec.table || row.ref_tbl !== spec.refTable) {
      out.push(`${spec.name}: ${row.tbl} -> ${row.ref_tbl}, expected ${spec.table} -> ${spec.refTable}`);
    }
    if (row.cols.join(",") !== spec.columns.join(",") || row.ref_cols.join(",") !== spec.refColumns.join(",")) {
      out.push(
        `${spec.name}: (${row.cols.join(", ")}) -> (${row.ref_cols.join(", ")}), ` +
          `expected (${spec.columns.join(", ")}) -> (${spec.refColumns.join(", ")})`,
      );
    }
    if (row.match !== "s") out.push(`${spec.name}: MATCH type ${row.match}, expected SIMPLE (nullable composite FKs rely on it)`);
  }
  for (const r of rows) {
    // 'r' = RESTRICT. No cascading deletes/updates anywhere (DATABASE.md §14); 'a' (NO ACTION) is also rejected
    // so the policy is explicit and matches schema.prisma.
    if (r.upd !== "r" || r.del !== "r") out.push(`FK ${r.name}: ON UPDATE=${r.upd} ON DELETE=${r.del}, expected RESTRICT/RESTRICT`);
    if (!r.validated) out.push(`FK ${r.name}: NOT VALID`);
    if (r.deferrable) out.push(`FK ${r.name}: deferrable (integrity must be immediate)`);
  }
  return out;
}

/** MIG-07: timestamptz / bigint / uuid typing. */
export async function checkTypes(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT c.table_name, c.column_name, c.data_type
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> '_prisma_migrations'`,
  );
  const typeOf = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]));
  const out: string[] = [];
  for (const r of rows) {
    const key = `${r.table_name}.${r.column_name}`;
    if (r.data_type === "timestamp without time zone") out.push(`${key}: timestamp without time zone (must be timestamptz)`);
    if (/(_at|_until)$/.test(r.column_name) && r.data_type !== "timestamp with time zone") {
      out.push(`${key}: ${r.data_type}, expected timestamptz`);
    }
    if (r.column_name === "id" && r.data_type !== "uuid") out.push(`${key}: ${r.data_type}, expected uuid`);
    if (r.column_name.endsWith("_id") && !NON_UUID_ID_COLUMNS.has(key) && r.data_type !== "uuid") {
      out.push(`${key}: ${r.data_type}, expected uuid`);
    }
    if (/amount|price/.test(r.column_name) && !["bigint"].includes(r.data_type)) out.push(`${key}: money column is ${r.data_type}`);
  }
  for (const [t, c] of BIGINT_COLUMNS) if (typeOf.get(`${t}.${c}`) !== "bigint") out.push(`${t}.${c}: ${typeOf.get(`${t}.${c}`)}, expected bigint`);
  for (const [t, c] of SMALLINT_COLUMNS) if (typeOf.get(`${t}.${c}`) !== "smallint") out.push(`${t}.${c}: ${typeOf.get(`${t}.${c}`)}, expected smallint`);
  return out;
}

interface TriggerRow extends Record<string, unknown> {
  name: string;
  tbl: string;
  enabled: string;
  tgtype: number;
  fn: string;
  is_constraint: boolean;
  deferrable: boolean;
  init_deferred: boolean;
}

async function triggers(db: Queryable): Promise<TriggerRow[]> {
  const { rows } = await db.query<TriggerRow>(`
    SELECT t.tgname::text AS name, c.relname::text AS tbl, t.tgenabled::text AS enabled, t.tgtype::int AS tgtype,
           p.proname::text AS fn, (t.tgconstraint <> 0) AS is_constraint,
           t.tgdeferrable AS deferrable, t.tginitdeferred AS init_deferred
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal`);
  return rows;
}

/** Rule 14 / Q-023: order_items UPDATE and DELETE are rejected by enabled row-level BEFORE triggers. */
export async function checkImmutableTrigger(db: Queryable): Promise<string[]> {
  const rows = await triggers(db);
  const out: string[] = [];
  for (const spec of IMMUTABLE_TRIGGERS) {
    const row = rows.find((r) => r.name === spec.name);
    if (!row) {
      out.push(`missing trigger ${spec.name}`);
      continue;
    }
    if (row.tbl !== spec.table) out.push(`${row.name}: on ${row.tbl}, expected ${spec.table}`);
    if (row.enabled !== "O") out.push(`${row.name}: tgenabled=${row.enabled}, expected O (enabled)`);
    if (row.tgtype !== spec.tgtype) out.push(`${row.name}: tgtype=${row.tgtype}, expected ${spec.tgtype}`);
    if (row.fn !== spec.function) out.push(`${row.name}: function ${row.fn}, expected ${spec.function}`);
  }
  return out;
}

/** S3: the order<->payment consistency triggers exist, are enabled, AFTER ROW, and DEFERRABLE INITIALLY DEFERRED. */
export async function checkConstraintTriggers(db: Queryable): Promise<string[]> {
  const rows = await triggers(db);
  const out: string[] = [];
  for (const spec of CONSTRAINT_TRIGGERS) {
    const row = rows.find((r) => r.name === spec.name);
    if (!row) {
      out.push(`missing constraint trigger ${spec.name}`);
      continue;
    }
    if (row.tbl !== spec.table) out.push(`${row.name}: on ${row.tbl}, expected ${spec.table}`);
    if (row.enabled !== "O") out.push(`${row.name}: tgenabled=${row.enabled}, expected O (enabled)`);
    if (!row.is_constraint) out.push(`${row.name}: not a CONSTRAINT trigger`);
    if (!row.deferrable || !row.init_deferred) {
      out.push(`${row.name}: must be DEFERRABLE INITIALLY DEFERRED (checks the final state of the commit), got deferrable=${row.deferrable} initially deferred=${row.init_deferred}`);
    }
    if (row.tgtype !== spec.tgtype) out.push(`${row.name}: tgtype=${row.tgtype}, expected ${spec.tgtype} (AFTER ROW)`);
    if (row.fn !== spec.function) out.push(`${row.name}: function ${row.fn}, expected ${spec.function}`);
  }
  const known = new Set([...IMMUTABLE_TRIGGERS, ...CONSTRAINT_TRIGGERS].map((t) => t.name));
  for (const r of rows) if (!known.has(r.name)) out.push(`trigger ${r.tbl}.${r.name} is not listed in the contract manifest`);
  return out;
}

/** Everything in one list (used for the "after all migrations" gate and by MIG-06's dynamic layer). */
export async function checkAll(db: Queryable): Promise<string[]> {
  return [
    ...(await checkTables(db)),
    ...(await checkPartialUniques(db)),
    ...(await checkUniques(db)),
    ...(await checkChecks(db)),
    ...(await checkForeignKeys(db)),
    ...(await checkTypes(db)),
    ...(await checkImmutableTrigger(db)),
    ...(await checkConstraintTriggers(db)),
  ];
}

// ───────────────────────── MIG-06: static DROP scan ─────────────────────────

export interface DropFinding {
  file: string;
  statement: string;
  object: string;
  reason: string;
}

/** Names that later migrations must never drop (raw-SQL objects + the indexes/FKs the contract names). */
export function protectedObjects() {
  const names = new Set<string>();
  for (const p of PARTIAL_UNIQUES) names.add(p.name);
  for (const u of UNIQUES) names.add(u.name);
  for (const c of CHECKS) names.add(c.name);
  for (const f of COMPOSITE_FKS) names.add(f.name);
  for (const t of [...IMMUTABLE_TRIGGERS, ...CONSTRAINT_TRIGGERS]) {
    names.add(t.name);
    names.add(t.function);
  }

  const tables = new Set<string>(TABLES);
  const columns = new Set<string>();
  for (const p of PARTIAL_UNIQUES) p.columns.forEach((c) => columns.add(`${p.table}.${c}`));
  for (const c of CHECKS) c.columns.forEach((col) => columns.add(`${c.table}.${col}`));
  for (const f of COMPOSITE_FKS) f.columns.forEach((c) => columns.add(`${f.table}.${c}`));
  return { names, tables, columns };
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Finds statements in one migration that would remove contract objects. Deliberately conservative:
 * any DROP of a protected name, DROP TABLE of a core table, or DROP COLUMN of a column that a
 * raw-SQL object depends on is reported (PostgreSQL silently drops dependent indexes/CHECKs on DROP COLUMN).
 */
export function findProtectedDrops(file: string, sql: string): DropFinding[] {
  const { names, tables, columns } = protectedObjects();
  const text = stripComments(sql);
  const out: DropFinding[] = [];
  const ident = String.raw`"?([A-Za-z0-9_]+)"?`;
  const ifx = String.raw`(?:IF\s+EXISTS\s+)?`;

  const scan = (re: RegExp, check: (m: RegExpExecArray) => string | null) => {
    for (const m of text.matchAll(re)) {
      const reason = check(m as RegExpExecArray);
      if (reason) out.push({ file, statement: m[0].replace(/\s+/g, " ").trim(), object: m[1], reason });
    }
  };

  for (const kw of ["INDEX", "TRIGGER", "FUNCTION"]) {
    scan(new RegExp(String.raw`DROP\s+${kw}\s+${ifx}${ident}`, "gi"), (m) =>
      names.has(m[1]) ? `drops contract object ${m[1]}` : null,
    );
  }
  scan(new RegExp(String.raw`DROP\s+CONSTRAINT\s+${ifx}${ident}`, "gi"), (m) =>
    names.has(m[1]) ? `drops contract constraint ${m[1]}` : null,
  );
  scan(new RegExp(String.raw`DROP\s+TABLE\s+${ifx}${ident}`, "gi"), (m) =>
    tables.has(m[1]) ? `drops core table ${m[1]} (and every constraint on it)` : null,
  );
  // DROP COLUMN needs the owning table; walk ALTER TABLE statements.
  for (const m of text.matchAll(new RegExp(String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?${ident}([\s\S]*?);`, "gi"))) {
    const table = m[1];
    for (const d of m[2].matchAll(new RegExp(String.raw`DROP\s+COLUMN\s+${ifx}${ident}`, "gi"))) {
      if (columns.has(`${table}.${d[1]}`)) {
        out.push({
          file,
          statement: `ALTER TABLE ${table} DROP COLUMN ${d[1]}`,
          object: `${table}.${d[1]}`,
          reason: "column is used by a contract index/CHECK/FK; PostgreSQL drops those dependents silently",
        });
      }
    }
  }
  return out;
}

// ───────────────────────── MIG-09: migrations must be transactional (S1) ─────────────────────────

/**
 * Prisma Migrate runs a migration file statement by statement WITHOUT a transaction (verified on 7.10.1; see
 * MIG-10): when statement N fails, statements 1..N-1 stay applied and every later `migrate deploy` is blocked
 * (P3009). Each migration must therefore be wrapped in BEGIN; ... COMMIT; so that a failure leaves nothing behind.
 *
 * Opt-out for commands that cannot run in a transaction block (CREATE INDEX CONCURRENTLY, VACUUM, ...): the file
 * must have NO transaction control and carry the marker `-- no-transaction: <reason>` (such a migration should
 * contain exactly one such statement so that a failure is still all-or-nothing).
 */
export function checkMigrationTransactionality(file: string, sql: string): string[] {
  const out: string[] = [];
  const marker = /^\s*--\s*no-transaction:\s*\S+/m.test(sql);
  // blank dollar-quoted bodies (function bodies contain semicolons), then split into statements
  const flat = stripComments(sql).replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "$$$$");
  const stmts = flat
    .split(";")
    .map((x) => x.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const control = /^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b/i;

  if (marker) {
    if (stmts.some((x) => control.test(x))) out.push(`${file}: has a no-transaction marker but also contains transaction control`);
    return out;
  }
  if (stmts.length === 0) return [`${file}: empty migration`];
  if (!/^(BEGIN|START TRANSACTION)$/i.test(stmts[0])) out.push(`${file}: the first statement must be BEGIN (migrations are not transactional by themselves)`);
  if (!/^(COMMIT|END)$/i.test(stmts[stmts.length - 1])) out.push(`${file}: the last statement must be COMMIT`);
  for (const x of stmts.slice(1, -1)) {
    if (control.test(x)) out.push(`${file}: transaction control inside the wrapper ("${x.slice(0, 40)}"); later statements would run outside the transaction`);
    if (/\bCONCURRENTLY\b/i.test(x)) out.push(`${file}: "${x.slice(0, 50)}..." cannot run inside a transaction; use the no-transaction marker in a separate migration`);
    if (/^(VACUUM|CREATE DATABASE|DROP DATABASE|CREATE TABLESPACE|DROP TABLESPACE|ALTER SYSTEM)\b/i.test(x)) out.push(`${file}: "${x.slice(0, 40)}" cannot run inside a transaction`);
  }
  return out;
}
