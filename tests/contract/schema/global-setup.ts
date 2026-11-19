/**
 * Vitest globalSetup for the schema contract tests.
 *
 * 1. Resolve and validate the test server (see helpers/pg.ts for the safety rules).
 * 2. Create ONE template database and apply every migration with `prisma migrate deploy`
 *    (the same command shared environments use).
 * 3. Test files clone the template (`CREATE DATABASE ... TEMPLATE ...`) for isolation.
 *
 * MIG-01 does NOT rely on this template: it applies the migrations to its own empty database.
 */
import type { TestProject } from "vitest/node";
import {
  createDatabase,
  dropDatabase,
  newThrowawayName,
  resolveTestServer,
  runPrisma,
  sweepStaleDatabases,
} from "./helpers/pg";

declare module "vitest" {
  export interface ProvidedContext {
    templateDb: string;
  }
}

export default async function setup(project: TestProject) {
  const server = resolveTestServer();
  await sweepStaleDatabases(server);

  const template = newThrowawayName();
  await createDatabase(server, template);

  const res = await runPrisma(["migrate", "deploy"], { databaseUrl: server.urlFor(template) });
  if (res.code !== 0) {
    await dropDatabase(server, template);
    throw new Error(`prisma migrate deploy failed for the template database:\n${res.stdout}\n${res.stderr}`);
  }

  project.provide("templateDb", template);

  return async () => {
    await dropDatabase(server, template);
  };
}
