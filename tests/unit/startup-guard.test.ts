/**
 * PAGE-06 (review M4): server startup (src/instrumentation-node.ts) with the database URL combinations. The module runs
 * its check on import and calls process.exit(1) on a violation; process.exit (made to throw, like a real exit never
 * returns) and the console are spied, nothing real exits. No database is contacted (pure configuration check). Hosts are made-up examples; the password is a marker.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const SECRET = "s3cret-page06";
const POOLED = `postgresql://nazir:${SECRET}@ep-quiet-sun-a1b2c3d4-pooler.ap-southeast-1.aws.neon.tech/nazir_preview_test?sslmode=require`;
const DIRECT = `postgresql://nazir:${SECRET}@ep-quiet-sun-a1b2c3d4.ap-southeast-1.aws.neon.tech/nazir_preview_test?sslmode=require`;

async function start(env: Record<string, string>) {
  for (const k of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) vi.stubEnv(k, "");
  vi.stubEnv("NAZIR_RUNTIME_ENV", "test");
  vi.stubEnv("PAYMENT_PROVIDER", "mock");
  vi.stubEnv("IDENTITY_PROVIDER", "mock");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  // A real process.exit never returns: the mock throws a sentinel so nothing after it runs either.
  class Exit extends Error {}
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw Object.assign(new Exit(`exit ${code}`), { code });
  }) as never);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.resetModules();
  try {
    await import("@/instrumentation-node");
  } catch (e) {
    if (!(e instanceof Exit)) throw e; // anything else is a real failure of the startup module
  }
  const output = JSON.stringify([...error.mock.calls, ...info.mock.calls]);
  return { exited: exit.mock.calls.length > 0 ? exit.mock.calls[0][0] : null, output };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("PAGE-06 server startup and the database URLs", () => {
  it("DATABASE_URL missing (and no direct URL): the server starts — current behaviour, requiring it is undecided (review M3)", async () => {
    const r = await start({});
    expect(r.exited).toBeNull();
    expect(r.output).not.toContain("[nazir] database");
  });

  it("DATABASE_URL_UNPOOLED alone: startup is refused with the configuration error", async () => {
    const r = await start({ DATABASE_URL_UNPOOLED: DIRECT });
    expect(r.exited).toBe(1);
    expect(r.output).toContain("refusing to start");
    expect(r.output).toContain("DATABASE_URL_UNPOOLED is set but DATABASE_URL is not");
    expect(r.output).not.toContain(SECRET);
  });

  it("a valid pooled/direct pair: the server starts and logs the pooled database without credentials", async () => {
    const r = await start({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT });
    expect(r.exited).toBeNull();
    expect(r.output).toContain("[nazir] database");
    expect(r.output).toContain("ep-quiet-sun-a1b2c3d4-pooler.ap-southeast-1.aws.neon.tech");
    expect(r.output).not.toContain(SECRET);
    expect(r.output).not.toContain("postgresql://");
  });

  it.each([
    ["the pair names different databases", { DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT.replace("nazir_preview_test", "nazir_other_test") }, /must name the same database/],
    ["the pooled URL is not a test database in a test run", { DATABASE_URL: POOLED.replace("nazir_preview_test", "nazir_dev") }, /requires a database whose name ends with/],
  ])("refuses to start when %s", async (_label, env, message) => {
    const r = await start(env);
    expect(r.exited).toBe(1);
    expect(r.output).toMatch(message);
    expect(r.output).not.toContain(SECRET);
  });
});

describe("TX-U09 server startup and the database pool limits (review M8)", () => {
  it("test env with a database: development defaults are used and logged (no secret)", async () => {
    const r = await start({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT });
    expect(r.exited).toBeNull();
    expect(r.output).toContain("[nazir] database pool");
    expect(r.output).toContain('\\"poolMax\\":5');
    expect(r.output).not.toContain(SECRET);
  });
  it.each([
    ["a malformed value", { NAZIR_DB_POOL_MAX: "many" }, /NAZIR_DB_POOL_MAX must be a whole number/],
    ["a broken ordering", { NAZIR_DB_LOCK_TIMEOUT_MS: "9000" }, /LOCK_TIMEOUT_MS must be less than/],
  ])("refuses to start with %s", async (_l, env, message) => {
    const r = await start({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT, ...env });
    expect(r.exited).toBe(1);
    expect(r.output).toContain("refusing to start");
    expect(r.output).toMatch(message);
    expect(r.output).not.toContain(SECRET);
  });
});
