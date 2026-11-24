// A per-read memo of identical SQL reads (P3F-R1, #233). The wrapper lives as long as one analytical read; any write
// through it forgets every answer, so a memoized answer is never older than the last write the wrapper saw.
import type { SqlDriver, SqlRow, SqlValue, TransactionOptions } from "./sql-driver.ts";

const unkeyable = (v: SqlValue): boolean => typeof v === "bigint" || v instanceof Uint8Array;
const keyOf = (sql: string, params?: readonly SqlValue[]) =>
  `${sql}\u0000${JSON.stringify(params ?? [])}`;

/** The point read `SELECT columns FROM from WHERE key = ? [AND where] [ORDER BY order]` and its twin over many keys. */
export function keyedRead(spec: {
  columns: string;
  from: string;
  key: string;
  /** More conditions after the key; their `?` are the `fixed` params of `preloadReads`. */
  where?: string;
  order?: string;
  distinct?: boolean;
}): KeyedRead {
  const { columns, from, key } = spec;
  const select = spec.distinct ? "SELECT DISTINCT" : "SELECT";
  const more = spec.where ? ` AND ${spec.where}` : "";
  return {
    one: `${select} ${columns} FROM ${from} WHERE ${key} = ?${more}${spec.order ? ` ORDER BY ${spec.order}` : ""}`,
    many: `${select} ${key} AS key, ${columns} FROM ${from} WHERE ${key} IN (SELECT value FROM json_each(?))${more}
 ORDER BY ${key}${spec.order ? `, ${spec.order}` : ""}`,
  };
}

/** The memo of each wrapper `memoReads` made, with the driver under it: what `preloadReads` fills. */
const memos = new WeakMap<object, { seen: Map<string, readonly SqlRow[]>; under: SqlDriver }>();

/**
 * A point read (`one`: one id, then `fixed` params) and its twin (`many`: a JSON array of ids, then the same
 * `fixed` params). `many` selects the id as the first column `key`, then exactly `one`'s columns, ordered by
 * `key` and then as `one` is, so each id's rows equal what `one` returns for it (ARB-R1).
 */
export interface KeyedRead {
  readonly one: string;
  readonly many: string;
}

/** Returns `db` with `all` answered once per identical (sql, params); rows and lists come back frozen. */
// No return annotation: the module boundary lint reads `: SqlDriver` on an object literal as a new adapter; the
// assignment at the one call site checks the shape.
export function memoReads(db: SqlDriver) {
  const seen = new Map<string, readonly SqlRow[]>();
  const wrapper = {
    exec: (sql: string) => {
      seen.clear();
      db.exec(sql);
    },
    run: (sql: string, params?: readonly SqlValue[]) => {
      seen.clear();
      return db.run(sql, params);
    },
    all: (sql: string, params?: readonly SqlValue[]): SqlRow[] => {
      if (params?.some(unkeyable)) return db.all(sql, params);
      const key = keyOf(sql, params);
      let rows = seen.get(key);
      if (rows === undefined) {
        rows = Object.freeze(db.all(sql, params).map((row) => Object.freeze(row)));
        seen.set(key, rows);
      }
      return rows as SqlRow[];
    },
    transaction: <T>(fn: () => T, options?: TransactionOptions): T => {
      seen.clear();
      try {
        return db.transaction(fn, options);
      } finally {
        seen.clear();
      }
    },
    close: () => db.close(),
  };
  memos.set(wrapper, { seen, under: db });
  return wrapper;
}

/**
 * Answers `read.one` for every id in one query: the ids it has no answer for go to `read.many` together and each
 * is stored, an id with no row as the empty list, under the key `one` would be asked by. A driver that is not a
 * `memoReads` wrapper is left alone, so a write path never meets a stored answer (ARB-R1).
 */
export function preloadReads(
  db: SqlDriver,
  read: KeyedRead,
  ids: readonly number[],
  fixed: readonly SqlValue[] = [],
): void {
  const memo = memos.get(db);
  if (!memo) return;
  const missing = [...new Set(ids)].filter((id) => !memo.seen.has(keyOf(read.one, [id, ...fixed])));
  if (missing.length === 0) return;
  const groups = new Map<number, SqlRow[]>(missing.map((id) => [id, []]));
  for (const { key, ...row } of memo.under.all(read.many, [JSON.stringify(missing), ...fixed])) {
    groups.get(key as number)?.push(Object.freeze(row));
  }
  for (const [id, rows] of groups)
    memo.seen.set(keyOf(read.one, [id, ...fixed]), Object.freeze(rows));
}
