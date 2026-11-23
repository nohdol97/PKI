// The product's real VectorIndex (H01C3-R1..R3, ADR 0026): a SQLite file of its own, beside the canonical
// one, holding generations of vectors. Search is a full scan of the active generation with cosine scores
// computed here; sqlite-vec is the replacement ADR 0004 left open (R07), swapped in behind this class.
// The file is a rebuildable projection: a file of another schema is deleted and started empty, and an
// unfinished build is dropped at open (the active generation keeps answering).
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  AdapterUnavailableError,
  StaleFenceError,
  type EmbeddingSpace,
  type IndexedRef,
  type VectorIndex,
  type VectorIndexStatus,
  type VectorRebuild,
} from "@pki/contracts";
import type { OpenSqlDriver, SqlDriver } from "../sql-driver.ts";

/** Bumped with every change of the tables below; a file of another value is not read. */
const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('building', 'active')),
    applied_seq INTEGER
  );
  CREATE UNIQUE INDEX generations_one_per_state ON generations (state);
  CREATE TABLE vectors (
    generation_id INTEGER NOT NULL REFERENCES generations (id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (generation_id, ref)
  ) WITHOUT ROWID;
  CREATE TABLE marks (
    generation_id INTEGER NOT NULL REFERENCES generations (id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    change_seq INTEGER NOT NULL,
    PRIMARY KEY (generation_id, ref)
  ) WITHOUT ROWID;
  PRAGMA user_version = ${SCHEMA_VERSION};
`;

function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

const toBlob = (vector: Float32Array) =>
  new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));

function fromBlob(blob: unknown): Float32Array {
  const bytes = blob as Uint8Array;
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

interface Generation {
  id: number;
  space: EmbeddingSpace;
  applied: number | null;
}

export class SqliteVectorIndex implements VectorIndex {
  readonly #db: SqlDriver;

  constructor(path: string, open: OpenSqlDriver) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = SqliteVectorIndex.#openCurrent(path, open);
    this.#db.run("DELETE FROM generations WHERE state = 'building'");
  }

  static #openCurrent(path: string, open: OpenSqlDriver): SqlDriver {
    const attempt = (): SqlDriver | null => {
      let db: SqlDriver | undefined;
      try {
        db = open(path);
        const version = Number(db.all("PRAGMA user_version")[0]?.user_version);
        const tables = db.all("SELECT count(*) AS n FROM sqlite_master")[0]?.n;
        if (version === SCHEMA_VERSION) return db;
        if (version === 0 && tables === 0) {
          db.exec(SCHEMA);
          return db;
        }
      } catch {
        // no database at all: treated like another schema
      }
      db?.close();
      return null;
    };
    const current = attempt();
    if (current) return current;
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    const fresh = attempt();
    if (!fresh) throw new Error("the vector index file cannot be created");
    return fresh;
  }

  close() {
    this.#db.close();
  }

  #generation(state: "active" | "building"): Generation | null {
    const row = this.#db.all(
      "SELECT id, model_id, revision, dimension, applied_seq FROM generations WHERE state = ?",
      [state],
    )[0];
    if (!row) return null;
    return {
      id: row.id as number,
      space: {
        modelId: row.model_id as string,
        revision: row.revision as string,
        dimension: row.dimension as number,
      },
      applied: row.applied_seq as number | null,
    };
  }

  #requireActive(): Generation {
    const active = this.#generation("active");
    if (!active) throw new AdapterUnavailableError("no active vector generation");
    return active;
  }

  async status(): Promise<VectorIndexStatus> {
    if (this.#generation("active")) return "ready";
    return this.#generation("building") ? "rebuilding" : { unavailable: "no vector generation" };
  }

  async embeddingSpace() {
    return this.#generation("active")?.space ?? null;
  }

  async appliedChangeSeq() {
    return this.#generation("active")?.applied ?? null;
  }

  async beginRebuild(space: EmbeddingSpace): Promise<VectorRebuild> {
    const id = this.#db.transaction(() => {
      this.#db.run("DELETE FROM generations WHERE state = 'building'");
      return this.#db.run(
        "INSERT INTO generations (model_id, revision, dimension, state) VALUES (?, ?, ?, 'building')",
        [space.modelId, space.revision, space.dimension],
      ).lastInsertRowid;
    });
    const current = () => {
      const building = this.#generation("building");
      if (building?.id !== id) throw new Error("this build is no longer the current one");
      return building;
    };
    return {
      refs: async () => {
        current();
        return this.#db
          .all("SELECT ref FROM vectors WHERE generation_id = ? ORDER BY ref", [id])
          .map((row) => row.ref as string);
      },
      upsert: async (items, changeSeq) =>
        this.#db.transaction(() => this.#write(current(), items, changeSeq)),
      activate: async (expectedRefs, appliedChangeSeq) =>
        this.#db.transaction(
          () => {
            current();
            const held = this.#db
              .all("SELECT ref FROM vectors WHERE generation_id = ?", [id])
              .map((row) => row.ref as string);
            const expected = new Set(expectedRefs);
            if (expected.size !== held.length || held.some((ref) => !expected.has(ref))) {
              throw new Error("the building generation's refs differ from the expected ones");
            }
            this.#db.run("DELETE FROM generations WHERE state = 'active'");
            this.#db.run("UPDATE generations SET state = 'active', applied_seq = ? WHERE id = ?", [
              appliedChangeSeq,
              id,
            ]);
          },
          { immediate: true },
        ),
      discard: async () =>
        void this.#db.run("DELETE FROM generations WHERE id = ? AND state = 'building'", [id]),
    };
  }

  #checkOrder(generationIds: readonly number[], refs: readonly IndexedRef[], changeSeq: number) {
    for (const generationId of generationIds) {
      for (const ref of refs) {
        const mark = this.#db.all(
          "SELECT change_seq FROM marks WHERE generation_id = ? AND ref = ?",
          [generationId, ref],
        )[0]?.change_seq as number | undefined;
        if (mark !== undefined && changeSeq < mark) {
          throw new StaleFenceError(`${ref}: change ${changeSeq} < applied ${mark}`);
        }
      }
    }
  }

  #mark(generation: Generation, refs: readonly IndexedRef[], changeSeq: number) {
    for (const ref of refs) {
      this.#db.run(
        "INSERT INTO marks (generation_id, ref, change_seq) VALUES (?, ?, ?) ON CONFLICT (generation_id, ref) DO UPDATE SET change_seq = excluded.change_seq",
        [generation.id, ref, changeSeq],
      );
    }
  }

  /** The active generation's applied sequence only moves up; a building one gets its own at `activate`. */
  #advance(generation: Generation, changeSeq: number) {
    this.#db.run("UPDATE generations SET applied_seq = ? WHERE id = ? AND state = 'active'", [
      Math.max(generation.applied ?? changeSeq, changeSeq),
      generation.id,
    ]);
  }

  /** Both checks come before any write, so a rejected batch changes nothing. */
  #write(
    generation: Generation,
    items: readonly { ref: IndexedRef; vector: Float32Array }[],
    changeSeq: number,
  ) {
    for (const { vector } of items) {
      if (vector.length !== generation.space.dimension) {
        throw new Error(
          `vector length ${vector.length} != dimension ${generation.space.dimension}`,
        );
      }
    }
    const refs = items.map((item) => item.ref);
    this.#checkOrder([generation.id], refs, changeSeq);
    for (const { ref, vector } of items) {
      this.#db.run(
        "INSERT INTO vectors (generation_id, ref, vector) VALUES (?, ?, ?) ON CONFLICT (generation_id, ref) DO UPDATE SET vector = excluded.vector",
        [generation.id, ref, toBlob(vector)],
      );
    }
    this.#mark(generation, refs, changeSeq);
    this.#advance(generation, changeSeq);
  }

  async upsert(items: readonly { ref: IndexedRef; vector: Float32Array }[], changeSeq: number) {
    this.#db.transaction(() => this.#write(this.#requireActive(), items, changeSeq));
  }

  async remove(refs: readonly IndexedRef[], changeSeq: number) {
    this.#db.transaction(() => {
      const generations = (["active", "building"] as const)
        .map((state) => this.#generation(state))
        .filter((g) => g !== null);
      this.#checkOrder(
        generations.map((g) => g.id),
        refs,
        changeSeq,
      );
      for (const generation of generations) {
        for (const ref of refs) {
          this.#db.run("DELETE FROM vectors WHERE generation_id = ? AND ref = ?", [
            generation.id,
            ref,
          ]);
        }
        this.#mark(generation, refs, changeSeq);
        this.#advance(generation, changeSeq);
      }
    });
  }

  async search(query: Float32Array, k: number) {
    const active = this.#requireActive();
    if (query.length !== active.space.dimension) {
      throw new Error(`vector length ${query.length} != dimension ${active.space.dimension}`);
    }
    return this.#db
      .all("SELECT ref, vector FROM vectors WHERE generation_id = ?", [active.id])
      .map((row) => ({ ref: row.ref as string, score: cosine(query, fromBlob(row.vector)) }))
      .sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
      .slice(0, k);
  }
}
