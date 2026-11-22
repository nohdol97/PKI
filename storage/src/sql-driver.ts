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
  /**
   * Runs after `fn` returns and right before COMMIT (I04-R17: the ledger lines are written
   * here). A throw rolls back. Only the outermost transaction takes it: given inside an
   * open transaction the call throws (a savepoint's release is not a COMMIT, so the hook
   * would run before the outer one could still roll back).
   */
  beforeCommit?: () => void;
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
   * transaction begins (`BEGIN IMMEDIATE`). A nested call joins the outer one. With
   * `beforeCommit` a COMMIT that fails with `SQLITE_BUSY` is tried again with the
   * transaction open (the driver's retry delays), any other failure rolls back.
   */
  transaction<T>(fn: () => T, options?: TransactionOptions): T;
  close(): void;
}

/** What an adapter lets a test or the composition root change; the defaults are the product's. */
export interface SqlDriverOptions {
  /** How long a statement waits for a lock held by another connection (default 5000). */
  busyTimeoutMs?: number;
  /** The waits between the COMMIT retries after `SQLITE_BUSY` (default 100, 400, 1600). */
  commitRetryDelaysMs?: readonly number[];
  /** Waits `ms` (default blocks the thread: the driver is synchronous). A test replaces it. */
  sleep?: (ms: number) => void;
}

/** Opens (creating if absent) the database file at `path`; `:memory:` is allowed. */
export type OpenSqlDriver = (path: string, options?: SqlDriverOptions) => SqlDriver;
