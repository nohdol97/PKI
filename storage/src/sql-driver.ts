// Narrow SQL driver port in front of the canonical SQLite file (ADR 0004):
// open, execute, transaction. Code above this port never names a driver, so
// the driver can be swapped (e.g. for an encrypting build, ADR 0010).
// Extension loading is deliberately absent until a vector index needs it.

export type SqlValue = string | number | bigint | Uint8Array | null;

export type SqlRow = Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** How a transaction begins; one object so later options sit beside this one. */
export interface TransactionOptions {
  immediate?: boolean;
}

export interface SqlDriver {
  /** Runs one or more statements without parameters (schema scripts). */
  exec(sql: string): void;
  /** Runs one statement that returns no rows. */
  run(sql: string, params?: readonly SqlValue[]): RunResult;
  /** Runs one statement and returns every row. */
  all(sql: string, params?: readonly SqlValue[]): SqlRow[];
  /**
   * Commits when `fn` returns, rolls back and rethrows when it throws. The write
   * lock is taken at the first write unless `immediate` (I03-R4) takes it as the
   * transaction begins (`BEGIN IMMEDIATE`). A nested call joins the outer one.
   */
  transaction<T>(fn: () => T, options?: TransactionOptions): T;
  close(): void;
}

/** Opens (creating if absent) the database file at `path`; `:memory:` is allowed. */
export type OpenSqlDriver = (path: string) => SqlDriver;
