/**
 * Real-PostgreSQL helpers for the schema contract tests (TEST_PLAN §1, §2).
 *
 * Safety model ("테스트 DB를 운영 DB와 절대 혼용하지 않는다"):
 *  - Tests read TEST_DATABASE_URL only — never DATABASE_URL.
 *  - Its database name must end with `_test` and its host must be local (127.0.0.1/localhost/::1),
 *    unless NAZIR_TEST_DB_ALLOW_REMOTE=1 is set deliberately.
 *  - The named database itself is never written to. The harness connects to the server's maintenance
 *    database, creates THROWAWAY databases named `nazir_ct_<timestamp>_<random>_test`, and only ever
 *    drops databases matching that pattern.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { parseDatabaseUrl, TEST_DB_SUFFIX } from "../../../../src/server/config/database-config";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const MIGRATIONS_DIR = resolve(REPO_ROOT, "prisma/migrations");
export const SCHEMA_PATH = resolve(REPO_ROOT, "prisma/schema.prisma");
const PRISMA_BIN = resolve(REPO_ROOT, "node_modules/prisma/build/index.js");

const THROWAWAY = /^nazir_ct_(\d+)_[0-9a-f]{8}_test$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface TestServer {
  /** Connection URL of the maintenance database (used to CREATE/DROP throwaway databases). */
  adminUrl: string;
  /** Build a URL for a database on the same server with the same credentials. */
  urlFor(database: string): string;
}

export function resolveTestServer(env: NodeJS.ProcessEnv = process.env): TestServer {
  const raw = env.TEST_DATABASE_URL;
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_URL is not set. The schema contract tests need a real PostgreSQL 15+ server.\n" +
        "  e.g. TEST_DATABASE_URL=postgresql://nazir:nazir@localhost:5432/nazir_test npm run test:db\n" +
        "  (see README 'Database'). These tests are never skipped silently.",
    );
  }
  const info = parseDatabaseUrl(raw, "TEST_DATABASE_URL");
  if (!info.database.endsWith(TEST_DB_SUFFIX)) {
    throw new Error(`TEST_DATABASE_URL must name a database ending in "${TEST_DB_SUFFIX}" (got "${info.database}")`);
  }
  if (!LOCAL_HOSTS.has(info.host) && env.NAZIR_TEST_DB_ALLOW_REMOTE !== "1") {
    throw new Error(
      `TEST_DATABASE_URL host "${info.host}" is not local. Refusing to create/drop databases on a remote server ` +
        `(set NAZIR_TEST_DB_ALLOW_REMOTE=1 only for a dedicated, disposable test server).`,
    );
  }
  if (env.DATABASE_URL && env.DATABASE_URL === raw) {
    throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL");
  }
  const base = new URL(raw);
  const withDb = (db: string) => {
    const u = new URL(base.toString());
    u.pathname = `/${encodeURIComponent(db)}`;
    return u.toString();
  };
  return { adminUrl: withDb("postgres"), urlFor: withDb };
}

export function newThrowawayName(): string {
  return `nazir_ct_${Date.now()}_${randomBytes(4).toString("hex")}${TEST_DB_SUFFIX}`;
}

function assertThrowaway(name: string) {
  if (!THROWAWAY.test(name)) throw new Error(`Refusing to touch non-throwaway database "${name}"`);
}

async function withAdmin<T>(server: TestServer, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: server.adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function createDatabase(server: TestServer, name: string, template?: string): Promise<void> {
  assertThrowaway(name);
  if (template) assertThrowaway(template);
  await withAdmin(server, (c) => c.query(`CREATE DATABASE ${q(name)}${template ? ` TEMPLATE ${q(template)}` : ""}`));
}

export async function dropDatabase(server: TestServer, name: string): Promise<void> {
  assertThrowaway(name);
  await withAdmin(server, (c) => c.query(`DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`));
}

/** Drops throwaway databases left behind by crashed runs (older than one hour). */
export async function sweepStaleDatabases(server: TestServer): Promise<void> {
  await withAdmin(server, async (c) => {
    const { rows } = await c.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'nazir\\_ct\\_%\\_test'`,
    );
    for (const { datname } of rows) {
      const m = THROWAWAY.exec(datname);
      if (m && Date.now() - Number(m[1]) > 60 * 60 * 1000) {
        await c.query(`DROP DATABASE IF EXISTS ${q(datname)} WITH (FORCE)`);
      }
    }
  });
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the repository's Prisma CLI. DATABASE_URL is always set explicitly; ambient values are not trusted. */
export function runPrisma(
  args: string[],
  opts: { databaseUrl: string; shadowUrl?: string; env?: Record<string, string>; cwd?: string },
): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env, DATABASE_URL: opts.databaseUrl };
    // `prisma db seed` runs "tsx prisma/seed.ts" through the shell: make node_modules/.bin resolvable (npx would do this).
    env.PATH = `${resolve(REPO_ROOT, "node_modules/.bin")}:${env.PATH ?? ""}`;
    if (opts.shadowUrl) env.SHADOW_DATABASE_URL = opts.shadowUrl;
    else delete env.SHADOW_DATABASE_URL;
    const child = spawn(process.execPath, [PRISMA_BIN, ...args], { cwd: opts.cwd ?? REPO_ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** A migrated throwaway database with a connection pool. */
export class TestDb {
  readonly pool: Pool;
  constructor(
    readonly server: TestServer,
    readonly name: string,
  ) {
    this.pool = new Pool({ connectionString: server.urlFor(name), max: 4 });
  }

  get url(): string {
    return this.server.urlFor(this.name);
  }

  query<R extends QueryResultRow = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  /**
   * Runs `fn` inside a transaction that is ALWAYS rolled back — fixtures never leak between tests.
   * Before rolling back, the deferred (commit-time) constraints are forced to run: a test that leaves the database in a
   * state COMMIT would reject (e.g. a PRIMARY payment its order does not confirm) therefore fails instead of passing
   * silently.
   */
  async rolledBack<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      return result;
    } finally {
      try {
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Clones the pre-migrated template into a fresh private database for one test file. */
export async function cloneTestDb(server: TestServer, templateName: string): Promise<TestDb> {
  const name = newThrowawayName();
  await createDatabase(server, name, templateName);
  return new TestDb(server, name);
}

export async function destroyTestDb(db: TestDb): Promise<void> {
  await db.close();
  await dropDatabase(db.server, db.name);
}

/**
 * A throwaway Prisma project (schema + a COPY of the real migrations + a minimal config) so that tests can break a
 * migration on purpose and run the real `prisma migrate` CLI against it without touching the repository.
 */
export interface TempMigrationProject {
  dir: string;
  migrationFile(name: string): string;
  read(name: string): string;
  write(name: string, sql: string): void;
  run(args: string[], databaseUrl: string): Promise<CliResult>;
  cleanup(): void;
}

export function makeTempMigrationProject(): TempMigrationProject {
  const dir = mkdtempSync(join(tmpdir(), "nazir-migproj-"));
  mkdirSync(join(dir, "prisma"), { recursive: true });
  cpSync(SCHEMA_PATH, join(dir, "prisma/schema.prisma"));
  cpSync(MIGRATIONS_DIR, join(dir, "prisma/migrations"), { recursive: true });
  writeFileSync(
    join(dir, "prisma.config.ts"),
    `import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
`,
  );
  symlinkSync(resolve(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const file = (name: string) => join(dir, "prisma/migrations", name, "migration.sql");
  return {
    dir,
    migrationFile: file,
    read: (name) => readFileSync(file(name), "utf8"),
    write: (name, sql) => writeFileSync(file(name), sql),
    run: (args, databaseUrl) => runPrisma(args, { databaseUrl, cwd: dir }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
