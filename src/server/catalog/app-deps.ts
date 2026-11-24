import "server-only";
import { getAppClock } from "../db/app-clock";
import { getPrisma } from "../db/client";
import type { CatalogDeps } from "./http";

/** The real dependencies of the catalog API: the app's Prisma client (DATABASE_URL, pooled) and DB time. */
export function appCatalogDeps(): CatalogDeps {
  return { db: getPrisma(), clock: getAppClock() };
}
