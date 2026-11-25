import "server-only";
import { getRuntimeConfig, mockControlAllowed } from "../config/server-config";
import { loadKeyring } from "../lib/secrets";
import { getSecurityConfig } from "./app-deps";
import type { CallbackDeps } from "./callback";
import type { MockControlDeps } from "./mock-control";
import { createIdentityProvider } from "./providers/factory";
import { prismaTx } from "./start-app-deps";

const appOrigin = () => getSecurityConfig().appOrigin;

export const callbackAppDeps: CallbackDeps = {
  appOrigin,
  provider: () => createIdentityProvider(getRuntimeConfig(), appOrigin()),
  contextKeys: () => loadKeyring(process.env, "NAZIR_PROVIDER_CTX_ENC"),
  subjectKeys: () => loadKeyring(process.env, "NAZIR_SUBJECT_HMAC"),
  piiKeys: () => loadKeyring(process.env, "NAZIR_PII_ENC"),
  tx: prismaTx,
};

export const mockControlAppDeps: MockControlDeps = {
  enabled: () => mockControlAllowed() && getRuntimeConfig().identity.kind === "mock",
  appOrigin,
  contextKeys: () => loadKeyring(process.env, "NAZIR_PROVIDER_CTX_ENC"),
  tx: prismaTx,
};
