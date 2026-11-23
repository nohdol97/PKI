// #181: migrate once per test file, hand each case a private copy. The helpers take the product's
// open/migrate functions as arguments, so testkit imports neither storage nor backend.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Prepares one database when the test file loads; each call opens a private in-memory copy of it.
 * A SQLite file's bytes are a valid serialized database, which `better-sqlite3` accepts where the
 * path goes; the cast below is the one place that relies on it.
 */
export function memoryDbTemplate<D extends { close(): void }>(
  open: (path: string) => D,
  prepare: (db: D) => void,
): () => D {
  const root = mkdtempSync(join(tmpdir(), "pki-db-template-"));
  let bytes: Buffer;
  try {
    const file = join(root, "template.sqlite");
    const db = open(file);
    prepare(db);
    db.close();
    bytes = readFileSync(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return () => open(bytes as unknown as string);
}

/** Builds one directory when the test file loads; each call copies it to `dir`. Removed after the file's tests. */
export function dirTemplate(build: (dir: string) => void): (dir: string) => void {
  const root = mkdtempSync(join(tmpdir(), "pki-dir-template-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  try {
    build(root);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return (dir) => cpSync(root, dir, { recursive: true });
}
