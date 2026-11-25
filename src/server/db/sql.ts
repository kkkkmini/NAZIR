/** Parameterised SQL executor (node-pg client/pool, or Prisma `$queryRawUnsafe` / a transaction client's). */
export type SqlExecutor = <T>(sql: string, params: unknown[]) => Promise<T[]>;
