// I04-T02 (R3, C1): the registration checks. `derivatives.schema-coverage` classifies every table,
// `derivatives.data-dir` every entry of the data directory after a flow, `derivatives.unregistered-adapter`
// the implementations the composition binds. Each fails closed on what nobody registered.
import { routes } from "@pki/contracts";
import { createProductRegistry, NO_POLICY_YET } from "@pki/knowledge-engine";
import { NullKnowledgeEngine } from "@pki/knowledge-engine/adapters";
import { createDerivativeRegistry, migrate, type DerivativeKind } from "@pki/storage";
import { EmptyVectorIndex, openBetterSqlite3 } from "@pki/storage/adapters";
import { send } from "@pki/testkit";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { productEngine, productRegistry } from "./composition.ts";
import {
  checkBoundAdapters,
  checkDataDirectory,
  checkTableCoverage,
  TABLE_CLASSIFICATION,
} from "./derivative-coverage.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "c".repeat(43);
const MAIL = readFileSync(resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"), "utf8");
const registry = productRegistry({ engine: productEngine(), vectorIndex: new EmptyVectorIndex() });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-coverage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function freshDb() {
  const db = openBetterSqlite3(":memory:");
  migrate(db);
  return db;
}

describe("derivatives.schema-coverage", () => {
  it("every table of the migrated schema is classified, and nothing classified is missing", () => {
    const db = freshDb();
    expect(checkTableCoverage(db, registry)).toEqual([]);
    db.close();
  });

  it("an unclassified table fails and the message names it and where to classify it", () => {
    const db = freshDb();
    db.exec("CREATE TABLE brand_new (id INTEGER PRIMARY KEY)");
    const problems = checkTableCoverage(db, registry);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"brand_new"');
    expect(problems[0]).toContain("TABLE_CLASSIFICATION");
    db.close();
  });

  it("each existing table fails when its classification entry is removed (all of them, not the first)", () => {
    const db = freshDb();
    for (const table of Object.keys(TABLE_CLASSIFICATION)) {
      const rest = Object.fromEntries(
        Object.entries(TABLE_CLASSIFICATION).filter(([name]) => name !== table),
      );
      const problems = checkTableCoverage(db, registry, rest);
      expect(
        problems.some((p) => p.includes(`"${table}"`)),
        table,
      ).toBe(true);
    }
    db.close();
  });

  it("a kind marker that is not in the registry fails", () => {
    const db = freshDb();
    const problems = checkTableCoverage(db, registry, {
      ...TABLE_CLASSIFICATION,
      evidence: { class: "kind", kind: "no-such-kind" },
    });
    expect(problems).toEqual([expect.stringContaining('"evidence"')]);
    expect(problems[0]).toContain("no-such-kind");
    db.close();
  });

  it("an entry for a table that does not exist fails (the list stays the schema's)", () => {
    const db = freshDb();
    const problems = checkTableCoverage(db, registry, {
      ...TABLE_CLASSIFICATION,
      ghost: { class: "operational", reason: "none" },
    });
    expect(problems).toEqual([expect.stringContaining('"ghost"')]);
    db.close();
  });

  it("an operational table with a foreign key to evidence fails", () => {
    const db = freshDb();
    db.exec("CREATE TABLE op_fk (e INTEGER REFERENCES evidence(id))");
    const problems = checkTableCoverage(db, registry, {
      ...TABLE_CLASSIFICATION,
      op_fk: { class: "operational", reason: "test" },
    });
    expect(problems).toEqual([expect.stringContaining('foreign key to "evidence"')]);
    db.close();
  });

  it("an operational table with an evidence_id column and no foreign key fails", () => {
    const db = freshDb();
    db.exec("CREATE TABLE op_col (evidence_id INTEGER)");
    const problems = checkTableCoverage(db, registry, {
      ...TABLE_CLASSIFICATION,
      op_col: { class: "operational", reason: "test" },
    });
    expect(problems).toEqual([expect.stringContaining('"evidence_id"')]);
    db.close();
  });

  it("each id column fails on an operational table (the others, not only evidence_id)", () => {
    const db = freshDb();
    for (const col of ["source_version_id", "fact_id", "relation_id", "item_id", "insight_id"]) {
      db.exec(`CREATE TABLE op_${col} (${col} INTEGER)`);
      const problems = checkTableCoverage(db, registry, {
        ...TABLE_CLASSIFICATION,
        [`op_${col}`]: { class: "operational", reason: "test" },
      });
      expect(problems, col).toEqual([expect.stringContaining(`"${col}"`)]);
      db.exec(`DROP TABLE op_${col}`);
    }
    db.close();
  });

  it("registered kinds without a table are the projection ones; every canonical kind owns a table", () => {
    const tableKinds = new Set(
      Object.values(TABLE_CLASSIFICATION).flatMap((c) => (c.class === "kind" ? [c.kind] : [])),
    );
    const tableless = registry.kinds.filter((k) => !tableKinds.has(k.kind));
    expect(tableless.map((k) => k.kind).sort()).toEqual(["engine", "vectorIndex"]);
    expect(tableless.every((k) => k.storage === "projection")).toBe(true);
  });
});

describe("derivatives.data-dir", () => {
  const boot = () =>
    bootBackend({
      dataDir: dir,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      providers: [],
    });

  it("after the default configuration starts and imports a file, every entry is claimed", async () => {
    const booted = await boot(); // the null engine and the empty vector index: the start is not refused
    const { port } = booted.server;
    const res = await send(
      port,
      routes.importJsonl.path,
      { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` },
      "POST",
      { text: MAIL },
    );
    expect(res.status).toBe(200);
    await booted.server.close();
    booted.db.close();
    expect(checkDataDirectory(dir, registry)).toEqual([]);
  });

  it("the operational entries of the product are accepted", () => {
    mkdirSync(join(dir, "models/embedder"), { recursive: true });
    mkdirSync(join(dir, "cli-runs/123.abc"), { recursive: true });
    for (const f of ["pki.sqlite", "pki.sqlite-journal", "pki.sqlite-wal", "pki.sqlite-shm"])
      writeFileSync(join(dir, f), "");
    writeFileSync(join(dir, "secrets.json"), "");
    writeFileSync(join(dir, "secrets.json.1a2b.tmp"), "");
    expect(checkDataDirectory(dir, registry)).toEqual([]);
  });

  it("an unknown file fails and the message names it", () => {
    writeFileSync(join(dir, "pki.sqlite"), "");
    writeFileSync(join(dir, "stray.bin"), "");
    const problems = checkDataDirectory(dir, registry);
    expect(problems).toEqual([expect.stringContaining('"stray.bin"')]);
  });

  it("near misses of operational names fail (a backup of the DB or of the secrets)", () => {
    for (const f of ["pki.sqlite.bak", "secrets.json.bak", "models.old", "cli-runs-old"])
      writeFileSync(join(dir, f), "");
    expect(checkDataDirectory(dir, registry)).toHaveLength(4);
  });

  it("a kind that writes a file without declaring its path fails; declaring it passes", () => {
    const writer = (dataPaths: string[]): DerivativeKind => ({
      kind: "writer",
      layer: "delivery",
      references: [],
      storage: "canonical",
      dataPaths,
      lineage: () => [],
      affected: () => [],
      invalidate: () => ({ removed: 0, recomputed: 0 }),
    });
    const withKind = (k: DerivativeKind) =>
      createDerivativeRegistry({ kinds: [...registry.kinds, k], policy: NO_POLICY_YET });
    mkdirSync(join(dir, "derived"));
    writeFileSync(join(dir, "derived/index.bin"), "");
    writeFileSync(join(dir, "derived/other.bin"), "");
    expect(checkDataDirectory(dir, withKind(writer([])))).toEqual([
      expect.stringContaining('"derived"'),
    ]);
    expect(checkDataDirectory(dir, withKind(writer(["derived/index.bin"])))).toEqual([
      expect.stringContaining('"derived/other.bin"'),
    ]);
    expect(checkDataDirectory(dir, withKind(writer(["derived"])))).toEqual([]);
  });
});

describe("derivatives.unregistered-adapter", () => {
  const without = (name: string) =>
    createDerivativeRegistry({
      kinds: createProductRegistry({ policy: NO_POLICY_YET }).kinds.filter((k) => k.kind !== name),
      policy: NO_POLICY_YET,
    });
  const options = () => ({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
  });
  class SidecarEngine extends NullKnowledgeEngine {}
  class SidecarIndex extends EmptyVectorIndex {}

  it("the default configuration has no problem", () => {
    expect(
      checkBoundAdapters(registry, {
        engine: productEngine(),
        vectorIndex: new EmptyVectorIndex(),
      }),
    ).toEqual([]);
  });

  it("an engine bound while the registry has no engine kind: the backend refuses to start", async () => {
    await expect(bootBackend({ ...options(), registry: without("engine") })).rejects.toThrow(
      /refusing to start.*engine/,
    );
  });

  it("a vector index bound while the registry has no vector kind: the backend refuses to start", async () => {
    await expect(bootBackend({ ...options(), registry: without("vectorIndex") })).rejects.toThrow(
      /refusing to start.*vectorIndex/,
    );
  });

  it("an engine that subclasses the null engine: the backend refuses to start", async () => {
    await expect(bootBackend({ ...options(), engine: new SidecarEngine() })).rejects.toThrow(
      /subclasses NullKnowledgeEngine/,
    );
  });

  it("a vector index that subclasses the empty one is reported", () => {
    expect(
      checkBoundAdapters(registry, { engine: productEngine(), vectorIndex: new SidecarIndex() }),
    ).toEqual([expect.stringContaining("subclasses EmptyVectorIndex")]);
  });
});
