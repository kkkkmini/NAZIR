/**
 * Trusted client IP (A-045). Only a header the platform itself overwrites is trusted:
 * - `vercel`: `x-vercel-forwarded-for`. Vercel overwrites the forwarding headers and does not pass a client-supplied value
 *   through (vercel.com/docs/headers/request-headers); `x-vercel-forwarded-for` stays correct even if another proxy is
 *   put in front and rewrites `x-forwarded-for`. Plain `x-forwarded-for`/`x-real-ip` are never read.
 * - `fixed`: local/test only — the address comes from NAZIR_CLIENT_IP_FIXED, never from the request.
 * NAZIR_CLIENT_IP_SOURCE is required (no default): staging/production must use `vercel` (startup check).
 * IPv6 addresses are reduced to their /64 prefix (one subscriber usually owns a whole /64); IPv4 is used as is.
 * The address is only ever passed to the HMAC — never logged or stored.
 */
import { isIP } from "node:net";

type Env = Record<string, string | undefined>;

export type ClientIpSource = { kind: "vercel" } | { kind: "fixed"; ip: string };

export class ClientIpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientIpConfigError";
  }
}

/** The request carries no usable trusted address. Callers treat this as fail-closed, never as "unlimited". */
export class ClientIpUnavailableError extends Error {
  constructor() {
    super("trusted client IP is unavailable");
    this.name = "ClientIpUnavailableError";
  }
}

export const VERCEL_IP_HEADER = "x-vercel-forwarded-for";

export function parseClientIpSource(env: Env, runtimeEnv: string): ClientIpSource {
  const raw = env.NAZIR_CLIENT_IP_SOURCE?.trim();
  const dev = runtimeEnv === "local" || runtimeEnv === "test";
  if (raw === "vercel") return { kind: "vercel" };
  if (raw === "fixed") {
    if (!dev) throw new ClientIpConfigError(`NAZIR_CLIENT_IP_SOURCE=fixed is only allowed in local/test (current: ${runtimeEnv})`);
    const ip = env.NAZIR_CLIENT_IP_FIXED?.trim();
    if (!ip || isIP(ip) === 0) throw new ClientIpConfigError("NAZIR_CLIENT_IP_SOURCE=fixed requires a valid NAZIR_CLIENT_IP_FIXED");
    return { kind: "fixed", ip };
  }
  throw new ClientIpConfigError('NAZIR_CLIENT_IP_SOURCE must be "vercel"' + (dev ? ' or "fixed"' : ""));
}

/** Canonical rate-limit identity of an address: IPv4 dotted quad, or the IPv6 /64 prefix. */
export function normalizeIp(ip: string): string | null {
  const v = isIP(ip);
  if (v === 4) return ip;
  if (v !== 6) return null;
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is the IPv4 client.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  const [head, tail = ""] = lower.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (t.some((p) => p.includes("."))) return null; // embedded IPv4 other than ::ffff: — reject, no guessing
  const groups = lower.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  const n = groups.map((g) => parseInt(g, 16));
  // IPv4-mapped written in hex (::ffff:cb00:7109) is the IPv4 client too, not the shared ::/64 bucket.
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) {
    return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join(".");
  }
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

export function resolveClientIp(headers: Headers, source: ClientIpSource): string {
  if (source.kind === "fixed") return normalizeIp(source.ip)!;
  const raw = headers.get(VERCEL_IP_HEADER);
  // Vercel sends one address. A list means something we do not understand: refuse rather than pick one.
  if (!raw || raw.includes(",")) throw new ClientIpUnavailableError();
  const ip = normalizeIp(raw.trim());
  if (!ip) throw new ClientIpUnavailableError();
  return ip;
}
