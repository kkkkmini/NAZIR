/**
 * DB-07: `npm run check:config` (scripts/check-config.ts) — the pre-deploy configuration check. It runs the real script
 * in a child process with a controlled environment. No database is needed: the URLs name made-up hosts, and the
 * script must not connect anywhere (a connection attempt would fail or hang, and the output would show it).
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const TSX = resolve(ROOT, "node_modules/.bin/tsx");
const SECRET = "s3cret-db07";
const DIRECT = `postgresql://nazir:${SECRET}@ep-quiet-sun-a1b2c3d4.ap-southeast-1.aws.neon.tech/nazir_preview_test?sslmode=require`;
const POOLED = `postgresql://nazir:${SECRET}@ep-quiet-sun-a1b2c3d4-pooler.ap-southeast-1.aws.neon.tech/nazir_preview_test?sslmode=require`;
const DEV = `postgresql://nazir:${SECRET}@localhost:5432/nazir_dev`;

function checkConfig(env: Record<string, string>) {
  // Only what the script needs; nothing from the developer's shell (no ambient DATABASE_URL / provider keys).
  const r = spawnSync(TSX, ["scripts/check-config.ts"], {
    cwd: ROOT,
    env: {
      NODE_ENV: "test", // required by the ProcessEnv type; check-config.ts does not read it
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PAYMENT_PROVIDER: "mock",
      IDENTITY_PROVIDER: "mock",
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

describe("DB-07 check:config validates DATABASE_URL and DATABASE_URL_UNPOOLED without connecting", () => {
  it("a valid Neon pair passes and both databases are summarised without URL or password", () => {
    const r = checkConfig({ NAZIR_RUNTIME_ENV: "test", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT });
    expect(r.code, r.out).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary.database).toEqual({ host: "ep-quiet-sun-a1b2c3d4-pooler.ap-southeast-1.aws.neon.tech", port: "5432", database: "nazir_preview_test", isTestDatabase: true });
    expect(summary.directDatabase).toEqual({ host: "ep-quiet-sun-a1b2c3d4.ap-southeast-1.aws.neon.tech", port: "5432", database: "nazir_preview_test", isTestDatabase: true });
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toContain("postgresql://");
  });

  it("DATABASE_URL alone still passes (local development) and reports no direct database", () => {
    const r = checkConfig({ NAZIR_RUNTIME_ENV: "local", DATABASE_URL: DEV });
    expect(r.code, r.out).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary.database).toMatchObject({ database: "nazir_dev", isTestDatabase: false });
    expect(summary.directDatabase).toBeUndefined();
  });

  it.each([
    ["the pair names different databases", { NAZIR_RUNTIME_ENV: "test", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT.replace("nazir_preview_test", "nazir_other_test") }, /must name the same database/],
    ["the pair names different Neon endpoints", { NAZIR_RUNTIME_ENV: "test", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT.replace("ep-quiet-sun-a1b2c3d4", "ep-other-moon-e5f6a7b8") }, /must name the same database/],
    ["the direct URL is from another environment", { NAZIR_RUNTIME_ENV: "test", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DEV }, /DATABASE_URL_UNPOOLED|requires a database whose name ends with "_test"/],
    ["the pooled URL is from another environment", { NAZIR_RUNTIME_ENV: "local", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT }, /must not be used with NAZIR_RUNTIME_ENV=local/],
    ["only DATABASE_URL_UNPOOLED is set", { NAZIR_RUNTIME_ENV: "test", DATABASE_URL_UNPOOLED: DIRECT }, /DATABASE_URL_UNPOOLED is set but DATABASE_URL is not/],
  ])("fails when %s, printing neither URL nor password", (_label, env, message) => {
    const r = checkConfig(env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(message);
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toContain("postgresql://");
  });
});
