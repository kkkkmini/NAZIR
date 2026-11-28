/**
 * 관객 예매 화면의 데이터 출처(src/server/catalog/catalog-source.ts). DB 연결 여부만으로 정하지 않는다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const KEYS = ["NAZIR_RUNTIME_ENV", "DATABASE_URL", "NAZIR_CATALOG_SOURCE", "PAYMENT_PROVIDER", "IDENTITY_PROVIDER", "TOSS_CLIENT_KEY", "TOSS_SECRET_KEY", "NICE_CLIENT_ID", "NICE_CLIENT_SECRET"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

async function sourceWith(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  const { catalogSource } = await import("@/server/catalog/catalog-source");
  return catalogSource();
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const DB = "postgresql://u:p@localhost:5432/x";

describe("catalogSource", () => {
  it("local/test default to the [DEV] fixture even when a database is configured", async () => {
    expect(await sourceWith({ NAZIR_RUNTIME_ENV: "local", PAYMENT_PROVIDER: "mock", IDENTITY_PROVIDER: "mock", DATABASE_URL: DB })).toEqual({ kind: "dev-fixture" });
    expect(await sourceWith({ NAZIR_RUNTIME_ENV: "test", PAYMENT_PROVIDER: "mock", IDENTITY_PROVIDER: "mock", DATABASE_URL: DB })).toEqual({ kind: "dev-fixture" });
  });

  it("local/test use the database only when opted in, and mark it as test data", async () => {
    expect(await sourceWith({ NAZIR_RUNTIME_ENV: "local", PAYMENT_PROVIDER: "mock", IDENTITY_PROVIDER: "mock", DATABASE_URL: DB, NAZIR_CATALOG_SOURCE: "db" })).toEqual({ kind: "db", testData: true });
    expect(await sourceWith({ NAZIR_RUNTIME_ENV: "test", PAYMENT_PROVIDER: "mock", IDENTITY_PROVIDER: "mock", NAZIR_CATALOG_SOURCE: "db" })).toEqual({ kind: "dev-fixture" });
    expect(await sourceWith({ NAZIR_RUNTIME_ENV: "local", PAYMENT_PROVIDER: "mock", IDENTITY_PROVIDER: "mock", DATABASE_URL: DB, NAZIR_CATALOG_SOURCE: "fixture" })).toEqual({ kind: "dev-fixture" });
  });

  const STAGING = { NAZIR_RUNTIME_ENV: "staging", PAYMENT_PROVIDER: "toss", TOSS_CLIENT_KEY: "test_ck_x", TOSS_SECRET_KEY: "test_sk_x", IDENTITY_PROVIDER: "nice", NICE_CLIENT_ID: "x", NICE_CLIENT_SECRET: "x" };

  it("staging/production: database or nothing, never the fixture, and the opt-in is ignored", async () => {
    expect(await sourceWith({ ...STAGING, DATABASE_URL: DB })).toEqual({ kind: "db", testData: false });
    expect(await sourceWith({ ...STAGING, NAZIR_CATALOG_SOURCE: "db" })).toEqual({ kind: "none" });
    expect(await sourceWith({ ...STAGING })).toEqual({ kind: "none" });
  });
});
