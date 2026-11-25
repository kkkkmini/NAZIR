import "server-only";
import { loadKeyring } from "../lib/secrets";
import { getSecurityConfig } from "./app-deps";
import type { SessionDeps } from "./session";
import { prismaTx } from "./start-app-deps";

export const sessionAppDeps: SessionDeps = {
  security: getSecurityConfig,
  piiKeys: () => loadKeyring(process.env, "NAZIR_PII_ENC"),
  tx: prismaTx,
};
