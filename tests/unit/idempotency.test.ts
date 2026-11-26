/** IDM-U01~U03: Idempotency-Key format, canonical request hashing, owner hashing. */
import { describe, expect, it } from "vitest";
import { canonicalJson, idempotencyKeyHash, idempotencyOwnerHash, parseIdempotencyKey, requestHash } from "@/server/booking/idempotency";

describe("IDM-U01 Idempotency-Key", () => {
  it.each(["3f2b8c1e-9d4a-4b7e-8f21-6c0d5e4a3b21", "3F2B8C1E-9D4A-4B7E-8F21-6C0D5E4A3B21", "A".repeat(22), "abc_DEF-123".repeat(4)])("accepts %s", (k) => {
    expect(() => parseIdempotencyKey(k)).not.toThrow();
  });
  it("normalises a UUID to lowercase (same key, same hash)", () => {
    expect(parseIdempotencyKey("3F2B8C1E-9D4A-4B7E-8F21-6C0D5E4A3B21")).toBe("3f2b8c1e-9d4a-4b7e-8f21-6c0d5e4a3b21");
  });
  it("a non-v4 UUID is accepted as an opaque base64url value (format only: entropy cannot be checked; keys are owner-scoped)", () => {
    expect(parseIdempotencyKey("3F2B8C1E-9D4A-1B7E-8F21-6C0D5E4A3B21")).toBe("3F2B8C1E-9D4A-1B7E-8F21-6C0D5E4A3B21"); // not lowercased
  });
  it.each([null, "", "short", "A".repeat(21), "A".repeat(129), "has space in it plenty long", "äöü".repeat(10)])("refuses %j → 400 IDEMPOTENCY_KEY_INVALID", (k) => {
    expect(() => parseIdempotencyKey(k as string | null)).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_INVALID", status: 400 }));
  });
});

describe("IDM-U02 canonical request hash", () => {
  it("object key order does not matter; array order does (callers sort order-free lists)", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: "x" } })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
    expect(requestHash({ b: 1, a: 2 })).toBe(requestHash({ a: 2, b: 1 }));
    expect(requestHash({ s: [1, 2] })).not.toBe(requestHash({ s: [2, 1] }));
  });
  it("refuses undefined (never silently dropped)", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
  });
});

describe("IDM-U03 hashes are domain separated", () => {
  it("key, owner and request hashes never collide for the same input", () => {
    const v = "same-input";
    const all = [idempotencyKeyHash(v), idempotencyOwnerHash(v, ""), requestHash(v)];
    expect(new Set(all).size).toBe(3);
    for (const h of all) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("owner = subject + binding: either one changing gives another owner", () => {
    const base = idempotencyOwnerHash("s1", "b1");
    expect(idempotencyOwnerHash("s2", "b1")).not.toBe(base);
    expect(idempotencyOwnerHash("s1", "b2")).not.toBe(base);
    expect(idempotencyOwnerHash("s1b", "1")).not.toBe(idempotencyOwnerHash("s1", "b1")); // separator, no ambiguity
  });
});
