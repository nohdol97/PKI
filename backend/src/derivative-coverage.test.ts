// I04-T02 (R3, C1): the registration checks. `derivatives.schema-coverage` classifies every table,
// `derivatives.data-dir` every entry of the data directory after a flow, `derivatives.unregistered-adapter`
// the implementations the composition binds. Each fails closed on what nobody registered.
import { routes } from "@pki/contracts";
import { computePolicyVersion, DEFAULT_PROVIDER_SETTING } from "@pki/providers";
import {
  candidatesReceiver,
  conflictsReceiver,
  createProductRegistry,
  insightsReceiver,
} from "@pki/knowledge-engine";
import { NullKnowledgeEngine } from "@pki/knowledge-engine/adapters";
import {
  createDerivativeRegistry,
  migrate,
  onMembershipChanged,
  saveConsent,
  writeSetting,
  type DerivativeKind,
  defaultScopePolicy,
} from "@pki/storage";
import { EmptyVectorIndex, openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, fixtureExtraction, send } from "@pki/testkit";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import {
  MEMBERSHIP_LISTENERS,
  openCanonicalDb,
  productEngine,
  productRegistry,
} from "./composition.ts";
import {
  checkBoundAdapters,
  checkDataDirectory,
  checkTableCoverage,
  TABLE_CLASSIFICATION,
} from "./derivative-coverage.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "c".repeat(43);
const registry = productRegistry({ engine: productEngine(), vectorIndex: new EmptyVectorIndex() });

const without = (name: string) =>
  createDerivativeRegistry({
    kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds.filter(
      (k) => k.kind !== name,
    ),
    policy: defaultScopePolicy,
  });

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

describe("resolution.group-reads: the membership receivers (S02-R13)", () => {
  it("are one fixed list with the rule's receiver first and the candidates' last, and both the registry and the user's entry are built from it", () => {
    expect(Object.isFrozen(MEMBERSHIP_LISTENERS)).toBe(true);
    expect(MEMBERSHIP_LISTENERS).toEqual([
      conflictsReceiver,
      insightsReceiver,
      onMembershipChanged,
      candidatesReceiver,
    ]);
  });
});

describe("derivatives.schema-coverage", () => {
  it("every table of the migrated schema is classified, and nothing classified is missing", () => {
    const db = freshDb();
    expect(checkTableCoverage(db, registry)).toEqual([]);
    db.close();
  });

  it("classifies the four tables S01-T01 adds under the kind of the row they record", () => {
    const db = freshDb();
    expect(checkTableCoverage(db, registry)).toEqual([]);
    expect(
      Object.fromEntries(
        ["item_history", "fact_history", "relation_history", "insight_user_inputs"].map((t) => [
          t,
          TABLE_CLASSIFICATION[t],
        ]),
      ),
    ).toEqual({
      item_history: { class: "kind", kind: "item" },
      fact_history: { class: "kind", kind: "fact" },
      relation_history: { class: "kind", kind: "relation" },
      insight_user_inputs: { class: "kind", kind: "insight" },
    });
    // each stands or falls with its classification: unclassified, the check names it
    const rest = Object.fromEntries(
      Object.entries(TABLE_CLASSIFICATION).filter(
        ([name]) => !name.endsWith("_history") || name.startsWith("ontology_"),
      ),
    );
    const problems = checkTableCoverage(db, registry, rest);
    expect(problems.filter((p) => p.includes("is not classified"))).toHaveLength(3);
    db.close();
  });

  it("classifies the three tables S01-T06 adds under the new kind `ontology`: seven new tables in all", () => {
    const db = freshDb();
    expect(checkTableCoverage(db, registry)).toEqual([]);
    const added = [
      "item_history",
      "fact_history",
      "relation_history",
      "insight_user_inputs",
      "ontology_elements",
      "ontology_basis",
      "ontology_history",
    ];
    expect(added).toHaveLength(7);
    expect(Object.fromEntries(added.slice(4).map((t) => [t, TABLE_CLASSIFICATION[t]]))).toEqual({
      ontology_elements: { class: "kind", kind: "ontology" },
      ontology_basis: { class: "kind", kind: "ontology" },
      ontology_history: { class: "kind", kind: "ontology" },
    });
    for (const t of added) {
      expect(
        db.all("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", [t]),
        t,
      ).toHaveLength(1);
    }
    // the kind is registered, and without it the three tables fail the check
    expect(registry.kinds.map((k) => k.kind)).toContain("ontology");
    const problems = checkTableCoverage(db, without("ontology"));
    expect(problems).toHaveLength(3);
    expect(problems.every((p) => p.includes('kind "ontology"'))).toBe(true);
    // unclassified, each is named
    const rest = Object.fromEntries(
      Object.entries(TABLE_CLASSIFICATION).filter(([name]) => !name.startsWith("ontology_")),
    );
    expect(
      checkTableCoverage(db, registry, rest).filter((p) => p.includes("is not classified")),
    ).toHaveLength(3);
    db.close();
  });

  it("classifies the two tables S03-T04 adds under the kind `analytical-check`, which is registered", () => {
    const db = freshDb();
    expect(checkTableCoverage(db, registry)).toEqual([]);
    expect(
      Object.fromEntries(
        ["dataset_tables", "analytical_checks"].map((t) => [t, TABLE_CLASSIFICATION[t]]),
      ),
    ).toEqual({
      dataset_tables: { class: "kind", kind: "analytical-check" },
      analytical_checks: { class: "kind", kind: "analytical-check" },
    });
    for (const t of ["dataset_tables", "analytical_checks"]) {
      expect(
        db.all("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", [t]),
        t,
      ).toHaveLength(1);
    }
    // the kind is registered after the fact, relation and item kinds (layer insight), and without it
    // the two tables fail the check
    const order = registry.kinds.map((k) => k.kind);
    for (const before of ["fact", "relation", "item"]) {
      expect(order.indexOf("analytical-check")).toBeGreaterThan(order.indexOf(before));
    }
    const problems = checkTableCoverage(db, without("analytical-check"));
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.includes('kind "analytical-check"'))).toBe(true);
    // unclassified, each is named
    const rest = Object.fromEntries(
      Object.entries(TABLE_CLASSIFICATION).filter(
        ([name]) => name !== "dataset_tables" && name !== "analytical_checks",
      ),
    );
    const unclassified = checkTableCoverage(db, registry, rest).filter((p) =>
      p.includes("is not classified"),
    );
    expect(unclassified).toHaveLength(2);
    expect(unclassified.join("\n")).toContain('"dataset_tables"');
    expect(unclassified.join("\n")).toContain('"analytical_checks"');
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

  it("a table whose kind is missing from the registry GIVEN fails (not the default registry)", () => {
    const db = freshDb();
    const problems = checkTableCoverage(db, without("fact"));
    // a fact's history table is classified under the fact kind too (S01-T01)
    expect(problems).toEqual([
      expect.stringContaining('"facts"'),
      expect.stringContaining('"fact_history"'),
    ]);
    expect(problems.every((p) => p.includes('"fact"'))).toBe(true);
    db.close();
  });

  it("SQLite names are case-insensitive: upper-case spellings do not evade the checks", () => {
    const db = freshDb();
    db.exec(`CREATE TABLE op_a (EVIDENCE_ID INTEGER);
      CREATE TABLE op_b (e INTEGER REFERENCES Evidence(id));
      CREATE TABLE op_c (f INTEGER REFERENCES "FACTS"(id));
      CREATE TABLE Op_D (x INTEGER)`);
    const operational = { class: "operational", reason: "test" } as const;
    const problems = checkTableCoverage(db, registry, {
      ...TABLE_CLASSIFICATION,
      op_a: operational,
      op_b: operational,
      op_c: operational,
      op_d: operational, // classified in lower case, created as Op_D: it is classified
    });
    expect(problems).toHaveLength(3);
    expect(problems).toEqual([
      expect.stringContaining('"op_a"'),
      expect.stringContaining('"op_b"'),
      expect.stringContaining('"op_c"'),
    ]);
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

  it("classifies the local file index (I02B-R33, C23): the entries as source identity, the other two operational", () => {
    const db = freshDb();
    expect(checkTableCoverage(db, registry)).toEqual([]);
    expect(TABLE_CLASSIFICATION.local_file_entries).toEqual({ class: "source" });
    expect(TABLE_CLASSIFICATION.local_locations?.class).toBe("operational");
    expect(TABLE_CLASSIFICATION.local_index_seq?.class).toBe("operational");
    // the index is not a derivative kind: the registry has the same kinds as without it (S02-T04 added the
    // two entity-resolution kinds, S03-T04 `analytical-check`)
    expect(registry.kinds.map((k) => k.kind).sort()).toEqual([
      "analytical-check",
      "assertion-link",
      "engine",
      "entity-merge",
      "evidence",
      "fact",
      "insight",
      "item",
      "lint-finding",
      "merge-candidate",
      "ontology",
      "relation",
      "scope-drop",
      "source",
      "vectorIndex",
      "wiki-page",
    ]);
    // each of the three stands or falls with its entry
    for (const table of ["local_locations", "local_index_seq", "local_file_entries"]) {
      const rest = Object.fromEntries(
        Object.entries(TABLE_CLASSIFICATION).filter(([name]) => name !== table),
      );
      expect(
        checkTableCoverage(db, registry, rest).some((p) => p.includes(`"${table}"`)),
        table,
      ).toBe(true);
    }
    db.close();
  });

  it("a source-class table without the trigger on `tombstones` that scrubs it fails (classified but nothing empties it)", () => {
    for (const trigger of ["tombstones_local_index_insert", "tombstones_local_index_update"]) {
      const db = freshDb();
      db.exec(`DROP TRIGGER ${trigger}`);
      const problems = checkTableCoverage(db, registry);
      expect(problems, trigger).toEqual([expect.stringContaining('"local_file_entries"')]);
      expect(problems[0]).toContain("tombstones");
      db.close();
    }
  });

  it("a second source-class table is accepted only with its own scrubbing trigger", () => {
    const db = freshDb();
    db.exec("CREATE TABLE other_identity (id INTEGER PRIMARY KEY)");
    const withIt = { ...TABLE_CLASSIFICATION, other_identity: { class: "source" as const } };
    expect(checkTableCoverage(db, registry, withIt)).toHaveLength(2); // for a new row, for a changed one
    db.exec(
      "CREATE TRIGGER tombstones_other_identity AFTER INSERT ON tombstones BEGIN DELETE FROM other_identity; END",
    );
    expect(checkTableCoverage(db, registry, withIt)).toEqual([expect.stringContaining("updated")]);
    db.exec(
      "CREATE TRIGGER tombstones_other_identity_u AFTER UPDATE ON tombstones BEGIN DELETE FROM other_identity; END",
    );
    expect(checkTableCoverage(db, registry, withIt)).toEqual([]);
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
  it("after import, extraction and an Insight on the default configuration, every entry is claimed", async () => {
    const seeding = openCanonicalDb(dir);
    writeSetting(seeding, DEFAULT_PROVIDER_SETTING, "local-model");
    saveConsent(seeding, {
      provider: "local-model",
      destination: "local-model",
      policyVersion: computePolicyVersion([]),
      allowedClasses: ["general"],
      grantedAt: "2026-11-22T00:00:00.000Z",
    });
    seeding.close();
    const provider = new FakeProvider({
      id: "local-model",
      transport: "http",
      answer: fixtureExtraction(),
    });
    // the null engine and the empty vector index: the start is not refused
    const booted = await bootBackend({
      dataDir: dir,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      providers: [provider],
    });
    const { port } = booted.server;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
    const text = ["v02-mail.jsonl", "v02-wiki.jsonl", "v02-messenger.jsonl"]
      .map((f) => readFileSync(resolve(import.meta.dirname, "../../fixtures", f), "utf8"))
      .join("\n");
    const res = await send(port, routes.importJsonl.path, headers, "POST", { text });
    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(
        booted.db.all("SELECT status FROM jobs WHERE kind = 'extract'").map((j) => j.status),
      ).toEqual(["succeeded", "succeeded", "succeeded"]),
    );
    // the flow reached the end: the directory is not checked after a flow that did nothing
    expect(booted.db.all("SELECT count(*) AS n FROM insights")[0]?.n).toBeGreaterThan(0);
    await booted.server.close();
    booted.db.close();
    expect(checkDataDirectory(dir, registry)).toEqual([]);
  });

  it("a kind path written with backslashes claims the file (Windows spelling)", () => {
    const winKind: DerivativeKind = {
      kind: "winwriter",
      layer: "delivery",
      references: [],
      storage: "canonical",
      dataPaths: ["derived\\index.bin"],
      lineage: () => [],
      affected: () => [],
      invalidate: () => ({ removed: 0, recomputed: 0 }),
    };
    mkdirSync(join(dir, "derived"));
    writeFileSync(join(dir, "derived/index.bin"), "");
    const reg = createDerivativeRegistry({
      kinds: [...registry.kinds, winKind],
      policy: defaultScopePolicy,
    });
    expect(checkDataDirectory(dir, reg)).toEqual([]);
  });

  it("the operational entries of the product are accepted", () => {
    mkdirSync(join(dir, "models/embedder"), { recursive: true });
    mkdirSync(join(dir, "cli-runs/123.abc"), { recursive: true });
    for (const f of ["pki.sqlite", "pki.sqlite-journal", "pki.sqlite-wal", "pki.sqlite-shm"])
      writeFileSync(join(dir, f), "");
    writeFileSync(join(dir, "secrets.json"), "");
    writeFileSync(join(dir, "secrets.json.1a2b.tmp"), "");
    // H01: the previous database while a restore is applied, the staged restore, the plain snapshot of a backup
    writeFileSync(join(dir, "pki.sqlite.before-restore"), "");
    mkdirSync(join(dir, "restore"));
    writeFileSync(join(dir, "restore/staged.sqlite"), "");
    writeFileSync(join(dir, "restore/pending.json"), "");
    mkdirSync(join(dir, "backup-tmp"));
    writeFileSync(join(dir, "backup-tmp/x.sqlite"), "");
    expect(checkDataDirectory(dir, registry)).toEqual([]);
  });

  it("the tombstone ledger and the names set aside beside it are accepted; look-alikes fail", () => {
    for (const f of [
      "tombstone-ledger.jsonl",
      "tombstone-ledger.other-key-1.jsonl",
      "tombstone-ledger.damaged-12.jsonl",
      "tombstone-ledger.jsonl.tmp",
    ])
      writeFileSync(join(dir, f), "");
    expect(checkDataDirectory(dir, registry)).toEqual([]);
    for (const f of [
      "tombstone-ledger.jsonl.bak",
      "tombstone-ledger.other-key-0.jsonl",
      "tombstone-ledger.other-key-.jsonl",
      "tombstone-ledger.stale-1.jsonl",
      "tombstone-ledger.jsonl.tmp2",
      "tombstone-ledger.jsonl.tmp.bak",
    ])
      writeFileSync(join(dir, f), "");
    expect(checkDataDirectory(dir, registry)).toHaveLength(6);
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
      createDerivativeRegistry({ kinds: [...registry.kinds, k], policy: defaultScopePolicy });
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
    await expect(bootBackend({ ...options(), registry: without("engine") })).rejects.toMatchObject({
      name: "UnregisteredAdapterError(engine)",
    });
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
