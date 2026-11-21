// What Settings shows about the canonical file's encryption (V01-R13, ADR 0010),
// read from the file rather than assumed: a plain SQLite database begins with the
// 16-byte header "SQLite format 3\0"; an encrypted one does not. Without that
// header (or without a file) nothing is claimed either way.
import { closeSync, openSync, readSync } from "node:fs";

const PLAIN_HEADER = Buffer.from("SQLite format 3\0", "latin1");

export function databaseEncryption(file: string | undefined): "not-applied" | "unknown" {
  if (file === undefined) return "unknown";
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return "unknown";
  }
  try {
    const head = Buffer.alloc(PLAIN_HEADER.length);
    const read = readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.equals(PLAIN_HEADER) ? "not-applied" : "unknown";
  } finally {
    closeSync(fd);
  }
}
