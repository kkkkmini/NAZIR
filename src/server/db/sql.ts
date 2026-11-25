/** Parameterised SQL executor (node-pg client/pool, or Prisma `$queryRawUnsafe` / a transaction client's). */
export type SqlExecutor = <T>(sql: string, params: unknown[]) => Promise<T[]>;

/** Runs `fn` in one READ COMMITTED transaction and commits (or rolls back on throw). */
export type TxRunner = <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
