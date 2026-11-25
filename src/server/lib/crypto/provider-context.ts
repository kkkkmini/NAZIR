/**
 * Encryption of the per-transaction provider context (`identity_verifications.provider_context_encrypted`, A-028, A-049).
 * AES-256-GCM like personal data, but with its OWN keyring (NAZIR_PROVIDER_CTX_ENC, DATABASE §6.2: separate from the
 * personal-data key) and bound (AAD) to the verification id, so a context can only be opened for its own row.
 * Format: `v<N>.<nonce>.<ciphertext>.<tag>` (base64url). Content: a small flat string map from the provider adapter —
 * never fixed secrets (client_secret, access tokens), never personal data.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Keyring } from "../secrets";

export class ProviderContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderContextError";
  }
}

export type ProviderContext = Record<string, string>;
const FORMAT = /^(v[1-9][0-9]{0,3})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/;
const MAX_BYTES = 2048;
const aad = (verificationId: string) => Buffer.from(`nazir:provider-context:${verificationId}`, "utf8");

export function sealProviderContext(ring: Keyring, verificationId: string, ctx: ProviderContext): string {
  const json = JSON.stringify(ctx);
  if (Buffer.byteLength(json) > MAX_BYTES || Object.values(ctx).some((v) => typeof v !== "string"))
    throw new ProviderContextError("provider context must be a small map of strings");
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", ring.keys.get(ring.currentVersion)!, nonce, { authTagLength: 16 });
  c.setAAD(aad(verificationId));
  const ct = Buffer.concat([c.update(json, "utf8"), c.final()]);
  return [ring.currentVersion, nonce.toString("base64url"), ct.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
}

export function openProviderContext(ring: Keyring, verificationId: string, stored: unknown): ProviderContext {
  const m = typeof stored === "string" ? FORMAT.exec(stored) : null;
  const key = m ? ring.keys.get(m[1]) : undefined;
  if (!m || !key) throw new ProviderContextError("provider context cannot be opened");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(m[2], "base64url"), { authTagLength: 16 });
    d.setAAD(aad(verificationId));
    d.setAuthTag(Buffer.from(m[4], "base64url"));
    const parsed: unknown = JSON.parse(Buffer.concat([d.update(Buffer.from(m[3], "base64url")), d.final()]).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as ProviderContext;
  } catch {
    throw new ProviderContextError("provider context cannot be opened");
  }
}
