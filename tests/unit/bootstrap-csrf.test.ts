/**
 * BOOT-01~12 (Step 4, A-044): browser binding cookie, CSRF token, Origin check, keyring/origin configuration.
 * Keys are generated per run; no value is printed.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleBootstrap } from "@/server/identity/bootstrap";
import { BINDING_COOKIE, readCookie } from "@/server/lib/cookies";
import { assertCsrf, issueCsrfToken, verifyCsrfToken } from "@/server/lib/csrf";
import { AppError } from "@/server/lib/errors";
import { signVersioned, verifyVersioned } from "@/server/lib/crypto/hmac";
import {
  SecretConfigError,
  assertDistinctKeyrings,
  assertStartupSecurityConfig,
  loadSecurityConfig,
  parseKeyring,
  type Keyring,
} from "@/server/lib/secrets";

const k = () => randomBytes(32).toString("base64url");
const ORIGIN = "https://tickets.example.com";
const K1 = k();
const K2 = k();
const ENV = { NAZIR_APP_ORIGIN: ORIGIN, NAZIR_CSRF_KEYS: `v1:${K1}`, NAZIR_CSRF_KEY_CURRENT: "v1" };
const security = () => loadSecurityConfig(ENV, "production");

function violations(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof SecretConfigError) return e.violations;
    throw e;
  }
  return [];
}

function ring(env: Record<string, string>): Keyring {
  const v: string[] = [];
  const r = parseKeyring(env, "NAZIR_CSRF", v);
  expect(v).toEqual([]);
  return r!;
}

function get(cookie?: string) {
  return new Request(`${ORIGIN}/api/v1/bootstrap`, { headers: cookie ? { cookie } : {} });
}

const VALID_BIND = randomBytes(32).toString("base64url");

describe("GET /api/v1/bootstrap", () => {
  it("BOOT-01 first visit issues a __Host- binding cookie with fixed security attributes and no-store", async () => {
    const res = handleBootstrap(get(), { security });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const set = res.headers.get("set-cookie")!;
    const [pair, ...attrs] = set.split("; ");
    expect(pair.startsWith(`${BINDING_COOKIE}=`)).toBe(true);
    expect(pair.slice(BINDING_COOKIE.length + 1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attrs.sort()).toEqual(["HttpOnly", "Max-Age=2592000", "Path=/", "SameSite=Lax", "Secure"].sort());
    expect(set).not.toMatch(/domain/i);
    const body = await res.json();
    expect(verifyCsrfToken(security().csrfKeys, pair.split("=")[1], body.csrfToken)).toBe(true);
  });

  it("BOOT-02 a valid existing cookie is reused and not re-set (no renewal); token is stable", async () => {
    const a = handleBootstrap(get(`${BINDING_COOKIE}=${VALID_BIND}`), { security });
    const b = handleBootstrap(get(`other=1; ${BINDING_COOKIE}=${VALID_BIND}`), { security });
    expect(a.headers.get("set-cookie")).toBeNull();
    expect(b.headers.get("set-cookie")).toBeNull();
    const ta = (await a.json()).csrfToken;
    expect(ta).toBe((await b.json()).csrfToken);
    expect(verifyCsrfToken(security().csrfKeys, VALID_BIND, ta)).toBe(true);
  });

  it.each([
    ["too short", "abc"],
    ["bad chars", "!".repeat(43)],
    ["too long", VALID_BIND + "A"],
    ["empty", ""],
  ])("BOOT-03 malformed cookie (%s) is replaced with a fresh binding", async (_, v) => {
    const res = handleBootstrap(get(`${BINDING_COOKIE}=${v}`), { security });
    const set = res.headers.get("set-cookie")!;
    const fresh = set.split("; ")[0].split("=")[1];
    expect(fresh).not.toBe(v);
    expect(verifyCsrfToken(security().csrfKeys, fresh, (await res.json()).csrfToken)).toBe(true);
  });

  it("BOOT-03 duplicated binding cookies are treated as absent", () => {
    const res = handleBootstrap(get(`${BINDING_COOKIE}=${VALID_BIND}; ${BINDING_COOKIE}=${VALID_BIND}`), { security });
    expect(res.headers.get("set-cookie")).not.toBeNull();
  });

  it("BOOT-04 missing/invalid security config fails closed: 500, no cookie, no token, no key in output", async () => {
    const res = handleBootstrap(get(), {
      security: () => loadSecurityConfig({ NAZIR_CSRF_KEYS: `v1:${K1}`, NAZIR_CSRF_KEY_CURRENT: "v1" }, "local"),
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("csrfToken");
    expect(text).not.toContain(K1);
  });
});

describe("CSRF token and HMAC", () => {
  it("BOOT-05 a token for one binding does not verify for another; tampering fails", () => {
    const r = security().csrfKeys;
    const t = issueCsrfToken(r, VALID_BIND);
    expect(verifyCsrfToken(r, VALID_BIND, t)).toBe(true);
    expect(verifyCsrfToken(r, randomBytes(32).toString("base64url"), t)).toBe(false);
    const flipped = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
    expect(verifyCsrfToken(r, VALID_BIND, flipped)).toBe(false);
    for (const bad of [undefined, null, "", "v1.", "v1.short", t + "x", 42]) expect(verifyCsrfToken(r, VALID_BIND, bad)).toBe(false);
  });

  it("BOOT-06 HMAC is domain separated by purpose", () => {
    const r = security().csrfKeys;
    expect(verifyVersioned(r, "subject", VALID_BIND, signVersioned(r, "csrf", VALID_BIND))).toBe(false);
  });

  it("BOOT-07 key versions: new tokens use the current version, older versions still verify, removed ones do not", () => {
    const old = ring({ NAZIR_CSRF_KEYS: `v1:${K1}`, NAZIR_CSRF_KEY_CURRENT: "v1" });
    const rotated = ring({ NAZIR_CSRF_KEYS: `v1:${K1},v2:${K2}`, NAZIR_CSRF_KEY_CURRENT: "v2" });
    const retired = ring({ NAZIR_CSRF_KEYS: `v2:${K2}`, NAZIR_CSRF_KEY_CURRENT: "v2" });
    const tOld = issueCsrfToken(old, VALID_BIND);
    const tNew = issueCsrfToken(rotated, VALID_BIND);
    expect(tOld.startsWith("v1.")).toBe(true);
    expect(tNew.startsWith("v2.")).toBe(true);
    expect(verifyCsrfToken(rotated, VALID_BIND, tOld)).toBe(true);
    expect(verifyCsrfToken(retired, VALID_BIND, tOld)).toBe(false);
    expect(verifyCsrfToken(retired, VALID_BIND, tNew)).toBe(true);
    // a v1 label with the v2 key's MAC must not pass
    expect(verifyCsrfToken(rotated, VALID_BIND, "v1." + tNew.slice(3))).toBe(false);
  });
});

describe("Origin + token check for state-changing requests", () => {
  const r = () => security().csrfKeys;
  const h = (o: Record<string, string>) => new Headers(o);
  const good = () => ({ origin: ORIGIN, "x-csrf-token": issueCsrfToken(r(), VALID_BIND) });
  const code = (fn: () => void) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof AppError ? `${e.code}:${e.status}` : "other";
    }
  };

  it("BOOT-08 exact Origin + valid token passes; Sec-Fetch-Site same-origin accepted", () => {
    expect(code(() => assertCsrf(h(good()), ORIGIN, r(), VALID_BIND))).toBeNull();
    expect(code(() => assertCsrf(h({ ...good(), "sec-fetch-site": "same-origin" }), ORIGIN, r(), VALID_BIND))).toBeNull();
  });

  it.each([
    ["missing", {}],
    ["null", { origin: "null" }],
    ["other site", { origin: "https://evil.example.com" }],
    ["trailing slash", { origin: ORIGIN + "/" }],
    ["http downgrade", { origin: "http://tickets.example.com" }],
    ["subdomain", { origin: "https://a.tickets.example.com" }],
    ["cross-site fetch metadata", { origin: ORIGIN, "sec-fetch-site": "cross-site" }],
    ["same-site fetch metadata", { origin: ORIGIN, "sec-fetch-site": "same-site" }],
  ])("BOOT-09 Origin %s is rejected with 403 CSRF_REJECTED", (_, o) => {
    const { origin: _o, ...rest } = good();
    void _o;
    expect(code(() => assertCsrf(h({ ...rest, ...o }), ORIGIN, r(), VALID_BIND))).toBe("CSRF_REJECTED:403");
  });

  it("BOOT-10 missing token, wrong-binding token, or no binding cookie is rejected", () => {
    expect(code(() => assertCsrf(h({ origin: ORIGIN }), ORIGIN, r(), VALID_BIND))).toBe("CSRF_REJECTED:403");
    const other = issueCsrfToken(r(), randomBytes(32).toString("base64url"));
    expect(code(() => assertCsrf(h({ origin: ORIGIN, "x-csrf-token": other }), ORIGIN, r(), VALID_BIND))).toBe("CSRF_REJECTED:403");
    expect(code(() => assertCsrf(h(good()), ORIGIN, r(), null))).toBe("CSRF_REJECTED:403");
  });
});

describe("Security configuration (fail-closed)", () => {
  it("BOOT-11 malformed keyrings are refused, without echoing key material", () => {
    const cases: Record<string, string>[] = [
      { NAZIR_CSRF_KEYS: `v1:${K1}` },
      { NAZIR_CSRF_KEY_CURRENT: "v1" },
      { NAZIR_CSRF_KEYS: "v1:short", NAZIR_CSRF_KEY_CURRENT: "v1" },
      { NAZIR_CSRF_KEYS: `${K1}`, NAZIR_CSRF_KEY_CURRENT: "v1" },
      { NAZIR_CSRF_KEYS: `v1:${K1}`, NAZIR_CSRF_KEY_CURRENT: "v2" },
      { NAZIR_CSRF_KEYS: `v1:${K1},v1:${K2}`, NAZIR_CSRF_KEY_CURRENT: "v1" },
      { NAZIR_CSRF_KEYS: `v1:${K1},v2:${K1}`, NAZIR_CSRF_KEY_CURRENT: "v1" },
      { NAZIR_CSRF_KEYS: `v1:${K1}+/=`, NAZIR_CSRF_KEY_CURRENT: "v1" },
    ];
    for (const env of cases) {
      const v = violations(() => assertStartupSecurityConfig(env, "local"));
      expect(v.length, JSON.stringify(Object.keys(env))).toBeGreaterThan(0);
      expect(JSON.stringify(v)).not.toContain(K1);
    }
  });

  it("BOOT-11 two keyrings sharing a key are refused", () => {
    const v: string[] = [];
    const a = parseKeyring({ A_KEYS: `v1:${K1}`, A_KEY_CURRENT: "v1" }, "A", v)!;
    const b = parseKeyring({ B_KEYS: `v1:${K1}`, B_KEY_CURRENT: "v1" }, "B", v)!;
    assertDistinctKeyrings([a, b], v);
    expect(v).toEqual(["A and B must not share a key"]);
  });

  it("BOOT-12 production/staging: missing origin or keys refuse startup; local/test start but fail on use", () => {
    for (const envName of ["production", "staging"]) {
      expect(violations(() => assertStartupSecurityConfig({}, envName)).length).toBeGreaterThan(0);
      expect(violations(() => assertStartupSecurityConfig({ ...ENV, NAZIR_APP_ORIGIN: "" }, envName))).toEqual(["NAZIR_APP_ORIGIN is required"]);
      expect(violations(() => assertStartupSecurityConfig(ENV, envName))).toEqual([]);
    }
    for (const envName of ["local", "test"]) {
      expect(violations(() => assertStartupSecurityConfig({}, envName))).toEqual([]);
      expect(violations(() => loadSecurityConfig({}, envName)).length).toBe(2);
    }
  });

  it.each([
    ["production", "http://tickets.example.com", false],
    ["production", "http://localhost:3000", false],
    ["production", "https://tickets.example.com/", false],
    ["production", "https://tickets.example.com/path", false],
    ["production", "https://*.example.com", false],
    ["production", "tickets.example.com", false],
    ["production", "https://tickets.example.com", true],
    ["staging", "http://localhost:3000", false],
    ["local", "http://localhost:3000", true],
    ["test", "http://127.0.0.1:3100", true],
    ["local", "http://192.168.0.10:3000", false],
    ["local", "http://tickets.example.com", false],
  ])("BOOT-12 %s NAZIR_APP_ORIGIN=%s accepted=%s", (envName, origin, ok) => {
    const v = violations(() => loadSecurityConfig({ ...ENV, NAZIR_APP_ORIGIN: origin }, envName));
    expect(v.length === 0).toBe(ok);
  });

  it("readCookie ignores other cookies and similar names", () => {
    expect(readCookie(`x${BINDING_COOKIE}=a; ${BINDING_COOKIE}=b`, BINDING_COOKIE)).toBe("b");
    expect(readCookie(null, BINDING_COOKIE)).toBeNull();
  });
});
