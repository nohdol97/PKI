// I02B-T04 T1 (I02B-R9, R37; C11): a relink keeps the location's id, goes through the approval's checks
// and, outside a test build, needs the picker's one-time ticket (the typed path would reopen what D14 closed).
import {
  createLocalFileIndex,
  newLocalId,
  closeLocation,
  listLocations,
  insertLocation,
  registerConnectorInstance,
  type LocalLocation,
  type SqlDriver,
} from "@pki/storage";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCanonicalDb } from "./composition.ts";
import { createApprovalTickets, createLocalLocations } from "./local-locations.ts";

let root: string;
let data: string;
let docs: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pki-local-relink-")));
  data = join(root, "data");
  docs = join(root, "docs");
  mkdirSync(docs);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function setup(buildKind: "production" | "test") {
  const db: SqlDriver = openCanonicalDb(data);
  registerConnectorInstance(db, "local-files", "local-files");
  const tickets = createApprovalTickets();
  const stat = statSync(docs, { bigint: true });
  const id = newLocalId();
  insertLocation(db, {
    id,
    type: "folder",
    displayPath: docs,
    realPath: docs,
    rootDev: stat.dev.toString(),
    rootIno: stat.ino.toString(),
    createdAt: "2026-11-23T00:00:00.000Z",
  });
  const locations = createLocalLocations({
    db,
    index: createLocalFileIndex(db),
    forbidden: [data],
    buildKind,
    tickets,
    onApproved: vi.fn(),
    normalizerUnavailable: () => false,
  });
  const moved = join(root, "moved");
  const rename = () => {
    renameSync(docs, moved);
    closeLocation(db, id, "unavailable", "root-missing");
  };
  return { db, id, locations, tickets, moved, rename };
}
const row = (db: SqlDriver, id: string) =>
  listLocations(db).find((l) => l.id === id) as LocalLocation;

describe("relink", () => {
  it("an unavailable location is relinked to the renamed folder: the id stays, the path and identity are new, it is active", async () => {
    const { db, id, locations, moved, rename } = setup("test");
    try {
      rename();
      const answer = await locations.relink({ locationId: id, path: moved });
      expect(answer).toMatchObject({ id, displayPath: moved, state: "active" });
      const stat = statSync(moved, { bigint: true });
      expect(row(db, id)).toMatchObject({
        realPath: moved,
        rootIno: stat.ino.toString(),
        state: "active",
        stateReason: null,
      });
    } finally {
      db.close();
    }
  });

  it("outside a test build a relink needs a one-time ticket (M9); an active location is not relinked", async () => {
    const { db, id, locations, tickets, moved, rename } = setup("production");
    try {
      expect(await locations.relink({ locationId: id, path: docs })).toEqual({
        error: "bad-request",
      });
      rename();
      const typed = await locations.relink({ locationId: id, path: moved });
      expect(typed).toEqual({ error: "approval-rejected", code: "ticket-required" });
      expect(row(db, id)).toMatchObject({ realPath: docs, state: "unavailable" });
      tickets.register({ ticket: "r".repeat(32), type: "folder", path: moved });
      expect(await locations.relink({ locationId: id, ticket: "r".repeat(32) })).toMatchObject({
        id,
        state: "active",
      });
      expect(await locations.relink({ locationId: newLocalId(), path: moved })).toEqual({
        error: "not-found",
      });
    } finally {
      db.close();
    }
  });
});

describe("relink of a jsonl-file location (DPF-R6)", () => {
  function setupFile() {
    const db: SqlDriver = openCanonicalDb(data);
    const path = join(root, "notes.jsonl");
    writeFileSync(path, "{}\n");
    const stat = statSync(path, { bigint: true });
    const id = newLocalId();
    insertLocation(db, {
      id,
      type: "jsonl-file",
      displayPath: path,
      realPath: path,
      rootDev: stat.dev.toString(),
      rootIno: stat.ino.toString(),
      createdAt: "2026-11-24T00:00:00.000Z",
    });
    const relinked = vi.fn();
    const locations = createLocalLocations({
      db,
      index: createLocalFileIndex(db),
      forbidden: [data],
      buildKind: "test",
      tickets: createApprovalTickets(),
      onApproved: vi.fn(),
      normalizerUnavailable: () => false,
      jsonlFile: { approved: vi.fn(), revoked: vi.fn(), relinked },
    });
    return { db, id, path, stat, locations, relinked };
  }

  it("takes an unavailable location to the file chosen: the id stays, the identity is the new file's, the instance is told", async () => {
    const { db, id, path, stat, locations, relinked } = setupFile();
    try {
      closeLocation(db, id, "unavailable", "root-changed");
      writeFileSync(join(root, "fresh.jsonl"), "{}\n");
      renameSync(join(root, "fresh.jsonl"), path);
      const now = statSync(path, { bigint: true });
      expect(now.ino).not.toBe(stat.ino);
      expect(await locations.relink({ locationId: id, path })).toMatchObject({
        id,
        state: "active",
      });
      expect(row(db, id)).toMatchObject({ rootIno: now.ino.toString(), state: "active" });
      expect(relinked).toHaveBeenCalledWith(expect.objectContaining({ id }));
    } finally {
      db.close();
    }
  });

  it("refuses a file that is not .jsonl and a folder and changes nothing; an active location is not relinked", async () => {
    const { db, id, path, locations, relinked } = setupFile();
    try {
      expect(await locations.relink({ locationId: id, path })).toEqual({ error: "bad-request" });
      closeLocation(db, id, "unavailable", "root-changed");
      const before = row(db, id);
      const dir = join(root, "dir.jsonl");
      mkdirSync(dir);
      const text = join(root, "notes.txt");
      writeFileSync(text, "{}\n");
      for (const target of [dir, text]) {
        expect(await locations.relink({ locationId: id, path: target })).toMatchObject({
          error: "approval-rejected",
        });
      }
      expect(row(db, id)).toEqual(before);
      expect(relinked).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
