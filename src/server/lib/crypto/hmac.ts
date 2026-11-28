/**
 * Versioned HMAC-SHA256 (A-043). Output form: "<version>.<base64url mac>".
 * Signing uses the keyring's current version; verification accepts any version still in the keyring, so a key can be
 * rotated by adding the new version, switching *_KEY_CURRENT, and removing the old version only after its values
 * have expired or been re-derived.
 * Every MAC is domain-separated by a purpose label so the same keyring can never produce a value valid for another use.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Keyring } from "../secrets";

/** Raw purpose-separated HMAC-SHA256 (for values whose key version is stored in a separate column). */
export function mac(key: Buffer, purpose: string, message: string): Buffer {
  return createHmac("sha256", key).update(`nazir:${purpose}\u0000`).update(message, "utf8").digest();
}

export function signVersioned(ring: Keyring, purpose: string, message: string): string {
  const key = ring.keys.get(ring.currentVersion)!;
  return `${ring.currentVersion}.${mac(key, purpose, message).toString("base64url")}`;
}

const TOKEN = /^(v[1-9][0-9]{0,3})\.([A-Za-z0-9_-]{43})$/;

/**
 * Constant-time check; false for malformed input, unknown version or mismatch (never throws on input).
 *
 * Only the canonical encoding is accepted. A 32-byte MAC is 43 base64url characters and the last character carries
 * 2 unused bits, so up to 4 different strings decode to the same bytes (`Buffer.from` ignores those bits). Without
 * this check a token with a changed last character could still verify (token malleability — the MAC bytes are the
 * same, so it is not a forgery). signVersioned always emits the canonical form, so valid tokens are unaffected.
 * The comparison is on the attacker-supplied string only (no secret involved), so it is not timing-sensitive.
 */
export function verifyVersioned(ring: Keyring, purpose: string, message: string, token: unknown): boolean {
  if (typeof token !== "string") return false;
  const m = TOKEN.exec(token);
  if (!m) return false;
  const key = ring.keys.get(m[1]);
  if (!key) return false;
  const given = Buffer.from(m[2], "base64url");
  if (given.toString("base64url") !== m[2]) return false;
  const expected = mac(key, purpose, message);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** SHA-256 hex, used for values that are already high-entropy random tokens (binding cookie, session tokens). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
