/**
 * PII-U01~U08 (A-043): AES-256-GCM field encryption, DI HMAC candidates, separation of the four keyrings.
 * Test values are synthetic; assertions check that they never surface in errors.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PiiCryptoError, decryptPii, encryptPii, piiKeyVersion } from "@/server/lib/crypto/pii";
import { DiUnavailableError, subjectKeyCandidates } from "@/server/lib/crypto/subject-key";
import { SecretConfigError, assertStartupSecurityConfig, loadKeyring, parseKeyring, parsePiiKeyring } from "@/server/lib/secrets";

const k = () => randomBytes(32).toString("base64url");
const K1 = k();
const K2 = k();
const ring = (keys: string, cur: string, prefix = "NAZIR_PII_ENC") => {
  const v: string[] = [];
  const r = parseKeyring({ [`${prefix}_KEYS`]: keys, [`${prefix}_KEY_CURRENT`]: cur }, prefix, v);
  expect(v).toEqual([]);
  return r!;
};
const NAME = "홍길동테스트";
const PHONE = "01000000000";
const errorText = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message} ${JSON.stringify(e)}`;
  }
  throw new Error("expected an error");
};

describe("PII-U01..05 AES-256-GCM", () => {
  const r1 = ring(`v1:${K1}`, "v1");
  it("PII-U01 round trip; format v<N>.nonce.ciphertext.tag; random nonce per call", () => {
    const a = encryptPii(r1, "identity_verifications.verified_name", NAME);
    const b = encryptPii(r1, "identity_verifications.verified_name", NAME);
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(a.split(".")[1], "base64url")).toHaveLength(12);
    expect(Buffer.from(a.split(".")[3], "base64url")).toHaveLength(16);
    expect(a).not.toBe(b);
    expect(a).not.toContain(NAME);
    expect(decryptPii(r1, "identity_verifications.verified_name", a)).toBe(NAME);
    expect(decryptPii(r1, "identity_verifications.verified_name", b)).toBe(NAME);
  });

  it("PII-U02 tampering with any part, or moving it to another field, is rejected without leaking data", () => {
    const t = encryptPii(r1, "identity_verifications.verified_phone", PHONE);
    const [v, n, c, g] = t.split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [[v, flip(n), c, g], [v, n, flip(c), g], [v, n, c, flip(g)], [v, n, c + "AA", g]].map((p) => p.join("."))) {
      const msg = errorText(() => decryptPii(r1, "identity_verifications.verified_phone", bad));
      expect(msg).toMatch(/PiiCryptoError/);
      expect(msg).not.toContain(PHONE);
      expect(msg).not.toContain(bad);
    }
    expect(() => decryptPii(r1, "orders.customer_phone", t)).toThrow(PiiCryptoError); // AAD binds the field
  });

  it.each([undefined, null, 42, "", "plain text", "v1.a.b.c", "v1..x.", "v0.AAAAAAAAAAAAAAAA.AA.AAAAAAAAAAAAAAAAAAAAAA"])(
    "PII-U03 malformed stored value %j is rejected",
    (bad) => expect(() => decryptPii(r1, "orders.customer_name", bad)).toThrow(PiiCryptoError),
  );

  it("PII-U04 key versions: old ciphertext decrypts after rotation, new uses current, missing version is refused", () => {
    const old = encryptPii(r1, "orders.customer_name", NAME);
    const rotated = ring(`v1:${K1},v2:${K2}`, "v2");
    const fresh = encryptPii(rotated, "orders.customer_name", NAME);
    expect(piiKeyVersion(old)).toBe("v1");
    expect(piiKeyVersion(fresh)).toBe("v2");
    expect(decryptPii(rotated, "orders.customer_name", old)).toBe(NAME);
    const retired = ring(`v2:${K2}`, "v2");
    expect(errorText(() => decryptPii(retired, "orders.customer_name", old))).toMatch(/key version that is not available/);
    expect(decryptPii(retired, "orders.customer_name", fresh)).toBe(NAME);
    // a v2 label on a v1 ciphertext fails authentication
    expect(() => decryptPii(rotated, "orders.customer_name", "v2" + old.slice(2))).toThrow(PiiCryptoError);
  });

  it("PII-U05 refuses empty/oversized input and unknown fields without echoing the value", () => {
    expect(() => encryptPii(r1, "orders.customer_name", "")).toThrow(PiiCryptoError);
    const long = "가".repeat(1001);
    expect(errorText(() => encryptPii(r1, "orders.customer_name", long))).not.toContain("가가");
    expect(() => encryptPii(r1, "orders.secret" as never, NAME)).toThrow(PiiCryptoError);
  });
});

describe("PII-U06 DI HMAC", () => {
  const s1 = ring(`v1:${K1}`, "v1", "NAZIR_SUBJECT_HMAC");
  const s12 = ring(`v1:${K1},v2:${K2}`, "v2", "NAZIR_SUBJECT_HMAC");
  const DI = "MC0GCCqGSIb3DQIJAyEA" + "x".repeat(44);
  it("deterministic per version, hides the DI, current first, old versions as fallback candidates", () => {
    const [a] = subjectKeyCandidates(s1, DI);
    expect(a).toMatchObject({ version: 1, current: true });
    expect(a.hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).not.toContain(DI.slice(0, 10));
    const c = subjectKeyCandidates(s12, DI);
    expect(c.map((x) => [x.version, x.current])).toEqual([[2, true], [1, false]]);
    expect(c[1].hash).toBe(a.hash);
    expect(c[0].hash).not.toBe(a.hash);
    expect(subjectKeyCandidates(s1, DI + "y")[0].hash).not.toBe(a.hash);
  });
  it.each([undefined, null, "", "   ", "a b", 123, "x".repeat(513)])("no usable DI (%j) → DiUnavailableError, no fallback", (di) => {
    expect(() => subjectKeyCandidates(s1, di)).toThrow(DiUnavailableError);
  });
});

describe("PII-U07/08 four separate keyrings, fail-closed", () => {
  const four = () => ({
    NAZIR_APP_ORIGIN: "https://tickets.example.com",
    NAZIR_CSRF_KEYS: `v1:${k()}`, NAZIR_CSRF_KEY_CURRENT: "v1",
    NAZIR_RATE_LIMIT_KEYS: `v1:${k()}`, NAZIR_RATE_LIMIT_KEY_CURRENT: "v1",
    NAZIR_SUBJECT_HMAC_KEYS: `v1:${k()}`, NAZIR_SUBJECT_HMAC_KEY_CURRENT: "v1",
    NAZIR_PII_ENC_KEYS: `v1:${k()}`, NAZIR_PII_ENC_KEY_CURRENT: "v1",
  });
  const violations = (env: Record<string, string>, rt: string) => {
    try {
      assertStartupSecurityConfig(env, rt);
      return [];
    } catch (e) {
      if (e instanceof SecretConfigError) return e.violations;
      throw e;
    }
  };
  it("PII-U07 every pair of keyrings sharing key material is refused (any environment)", () => {
    expect(violations(four(), "production")).toEqual([]);
    const names = ["NAZIR_CSRF", "NAZIR_RATE_LIMIT", "NAZIR_SUBJECT_HMAC", "NAZIR_PII_ENC"];
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++) {
        const env = four();
        env[`${names[j]}_KEYS` as keyof typeof env] = env[`${names[i]}_KEYS` as keyof typeof env];
        expect(violations(env, "local"), `${names[i]} vs ${names[j]}`).toEqual([`${names[i]} and ${names[j]} must not share a key`]);
      }
  });
  it("PII-U08 missing subject/PII keys refuse startup in staging/production; local starts but loading fails; PII keys must be 32 bytes", () => {
    for (const p of ["NAZIR_SUBJECT_HMAC", "NAZIR_PII_ENC"]) {
      const env: Record<string, string> = { ...four(), [`${p}_KEYS`]: "", [`${p}_KEY_CURRENT`]: "" };
      expect(violations(env, "production")).toEqual([`${p}_KEYS and ${p}_KEY_CURRENT are required in production`]);
      expect(violations(env, "staging")).toHaveLength(1);
      expect(violations(env, "local")).toEqual([]);
      expect(() => loadKeyring(env, p as never)).toThrow(SecretConfigError);
    }
    const long = randomBytes(48).toString("base64url");
    const v: string[] = [];
    expect(parsePiiKeyring({ NAZIR_PII_ENC_KEYS: `v1:${long}`, NAZIR_PII_ENC_KEY_CURRENT: "v1" }, v)).toBeNull();
    expect(v).toEqual(["NAZIR_PII_ENC_KEYS: key v1 must be exactly 32 bytes (AES-256)"]);
    expect(JSON.stringify(v)).not.toContain(long);
  });
});
