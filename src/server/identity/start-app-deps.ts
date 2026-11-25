import "server-only";
import { getRuntimeConfig } from "../config/server-config";
import { getPrisma } from "../db/client";
import type { TxRunner } from "../db/sql";
import { loadKeyring } from "../lib/secrets";
import { getRateLimit } from "../rate-limit/app-deps";
import { getSecurityConfig } from "./app-deps";
import { createIdentityProvider } from "./providers/factory";
import type { StartDeps } from "./start";

/** Prisma interactive transaction (explicit READ COMMITTED, DATABASE §13.2) as the TxRunner. */
export const prismaTx: TxRunner = (fn) =>
  getPrisma().$transaction((tx) => fn((sql, params) => tx.$queryRawUnsafe(sql, ...params)), { isolationLevel: "ReadCommitted" });

/** Everything is resolved per request and lazily, so a missing key fails that request closed instead of crashing. */
export const startAppDeps: StartDeps = {
  security: getSecurityConfig,
  rateLimit: () => {
    const { limiter, config } = getRateLimit();
    return { limiter, ipSource: config.ipSource };
  },
  provider: () => createIdentityProvider(getRuntimeConfig(), getSecurityConfig().appOrigin),
  contextKeys: () => loadKeyring(process.env, "NAZIR_PROVIDER_CTX_ENC"),
  tx: prismaTx,
};
