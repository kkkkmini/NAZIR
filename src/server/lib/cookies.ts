/**
 * Audience cookies (API_SPEC §3.1). Attributes are fixed here and identical in every environment: `__Host-` prefix,
 * Secure, HttpOnly, Path=/, no Domain, SameSite=Lax. Nothing is relaxed for local/test (http://localhost is a secure
 * context, so browsers accept Secure cookies there).
 */
import { randomBytes } from "node:crypto";

export const BINDING_COOKIE = "__Host-nz_bind";
/** 30 days, never extended (A-044). */
export const BINDING_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** 256-bit random value, base64url without padding = 43 characters. */
const BINDING_VALUE = /^[A-Za-z0-9_-]{43}$/;

export function newBindingValue(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString("base64url");
}

export function isValidBindingValue(value: string | undefined): value is string {
  return typeof value === "string" && BINDING_VALUE.test(value);
}

/** Reads one cookie from a Cookie header. Duplicate names → null (ambiguous, treated as absent). */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    if (found !== null) return null;
    found = part.slice(idx + 1).trim();
  }
  return found;
}

export function serializeHostCookie(name: string, value: string, maxAgeSeconds: number): string {
  if (!name.startsWith("__Host-")) throw new Error("audience cookies must use the __Host- prefix");
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
