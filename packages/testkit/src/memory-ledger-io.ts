// A tombstone ledger's file operations kept in memory, with failures a test injects
// (I04-R17 crash matrix). The shape is the storage port's (`LedgerIo`), declared here
// because testkit does not depend on storage; a port that no longer fits fails to
// typecheck at the call site.
export type LedgerIoOperation = "read" | "append" | "truncate" | "rename";

export interface MemoryLedgerIo {
  read(path: string): string | undefined;
  append(path: string, text: string): void;
  truncate(path: string, bytes: number): void;
  rename(from: string, to: string): void;
  exists(path: string): boolean;
  /** The files by path. A test seeds or reads them directly. */
  files: Map<string, string>;
  /** Every operation performed, in order, failed ones too: `append:<path>` and so on. */
  log: string[];
  /** Return an error to fail that operation (nothing is written), undefined to let it pass. */
  fail?: (operation: LedgerIoOperation, path: string, text?: string) => Error | undefined;
}

export function memoryLedgerIo(): MemoryLedgerIo {
  const io: MemoryLedgerIo = {
    files: new Map(),
    log: [],
    read: (path) => io.files.get(path),
    append: (path, text) => {
      io.log.push(`append:${path}`);
      const error = io.fail?.("append", path, text);
      if (error) throw error;
      io.files.set(path, (io.files.get(path) ?? "") + text);
    },
    truncate: (path, bytes) => {
      io.log.push(`truncate:${path}`);
      const error = io.fail?.("truncate", path);
      if (error) throw error;
      io.files.set(
        path,
        Buffer.from(io.files.get(path) ?? "", "utf8")
          .subarray(0, bytes)
          .toString("utf8"),
      );
    },
    rename: (from, to) => {
      io.log.push(`rename:${from}`);
      const error = io.fail?.("rename", from);
      if (error) throw error;
      io.files.set(to, io.files.get(from) ?? "");
      io.files.delete(from);
    },
    exists: (path) => io.files.has(path),
  };
  return io;
}
