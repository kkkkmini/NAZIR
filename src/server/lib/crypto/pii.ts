/**
 * Personal-data field encryption (A-043): AES-256-GCM, 96-bit random nonce, 128-bit tag.
 * Format: `v<N>.<nonce b64url>.<ciphertext b64url>.<tag b64url>`. The field name is bound as AAD, so a ciphertext
 * copied into another column (e.g. name → phone) does not decrypt.
 * Own keyring NAZIR_PII_ENC_KEYS / _KEY_CURRENT (32-byte keys). Every version in the keyring decrypts, the current one
 * encrypts. Errors are generic: they never carry the plaintext, the ciphertext or the key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Keyring } from "../secrets";

export const PII_FIELDS = [
  "identity_verifications.verified_name",
  "identity_verifications.verified_phone",
  "orders.customer_name",
  "orders.customer_phone",
  "orders.customer_email",
] as const;
export type PiiField = (typeof PII_FIELDS)[number];

export const MAX_PII_CHARS = 1000;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT = /^(v[1-9][0-9]{0,3})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/;

export class PiiCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiiCryptoError";
  }
}

function aad(field: PiiField): Buffer {
  if (!(PII_FIELDS as readonly string[]).includes(field)) throw new PiiCryptoError("unknown personal-data field");
  return Buffer.from(`nazir:pii:${field}`, "utf8");
}

export function encryptPii(ring: Keyring, field: PiiField, plaintext: string, random: (n: number) => Buffer = randomBytes): string {
  if (typeof plaintext !== "string" || plaintext.length === 0 || plaintext.length > MAX_PII_CHARS)
    throw new PiiCryptoError("personal-data value must be a non-empty string of limited length");
  const key = ring.keys.get(ring.currentVersion)!;
  const nonce = random(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new PiiCryptoError("nonce generation failed");
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(field));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ring.currentVersion, nonce.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptPii(ring: Keyring, field: PiiField, stored: unknown): string {
  const m = typeof stored === "string" ? FORMAT.exec(stored) : null;
  if (!m) throw new PiiCryptoError("encrypted personal data has an invalid format");
  const key = ring.keys.get(m[1]);
  if (!key) throw new PiiCryptoError("encrypted personal data uses a key version that is not available");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(m[2], "base64url"), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(field));
    decipher.setAuthTag(Buffer.from(m[4], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(m[3], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new PiiCryptoError("encrypted personal data failed authentication");
  }
}

/** Version of a stored value (for re-encryption after a key rotation); null if malformed. */
export function piiKeyVersion(stored: string): string | null {
  return FORMAT.exec(stored)?.[1] ?? null;
}
