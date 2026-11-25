/**
 * Identity subject key = HMAC of the NICE DI (A-043). The raw DI is never stored, logged or returned.
 *
 * - Own keyring NAZIR_SUBJECT_HMAC_KEYS / _KEY_CURRENT (never shared with CSRF, rate limit or encryption keys).
 * - Stored as (`subject_key_type` = 'DI', `key_version` = N, `subject_key_hash` = base64url HMAC-SHA256).
 * - Lookup computes the hash under EVERY version still in the keyring, so a key rotation never makes a returning
 *   person look new; a match under an older version is moved to the current version (src/server/identity/subjects.ts).
 * - No DI → `DiUnavailableError`. There is deliberately no fallback to CI or the phone number (A-043).
 */
import { mac } from "./hmac";
import type { Keyring } from "../secrets";

export const SUBJECT_KEY_TYPE = "DI" as const;
const PURPOSE = "subject-di";

export class DiUnavailableError extends Error {
  constructor() {
    super("identity provider returned no usable DI; refusing to fall back to CI or phone (A-043)");
    this.name = "DiUnavailableError";
  }
}

export interface SubjectKeyCandidate {
  version: number;
  hash: string;
  current: boolean;
}

export function keyVersionNumber(version: string): number {
  const n = Number(version.slice(1));
  if (!/^v[1-9][0-9]{0,3}$/.test(version) || n > 32767) throw new Error("invalid key version");
  return n;
}

/** Rejects missing/blank/oversized DI without echoing it. */
export function assertDi(di: unknown): asserts di is string {
  if (typeof di !== "string" || di.trim() === "" || di.length > 512 || /\s/.test(di)) throw new DiUnavailableError();
}

/** Hash under every version in the keyring, current first. */
export function subjectKeyCandidates(ring: Keyring, di: unknown): SubjectKeyCandidate[] {
  assertDi(di);
  const out: SubjectKeyCandidate[] = [];
  for (const [version, key] of ring.keys) {
    out.push({
      version: keyVersionNumber(version),
      hash: mac(key, PURPOSE, di).toString("base64url"),
      current: version === ring.currentVersion,
    });
  }
  return out.sort((a, b) => Number(b.current) - Number(a.current) || b.version - a.version);
}
