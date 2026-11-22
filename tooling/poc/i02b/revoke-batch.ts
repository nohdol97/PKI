/* eslint-disable pki/module-boundary -- a throwaway measurement script that reaches into the packages' sources on purpose (I02B-T01) */
// I02B-T01 PoC (throwaway), the last R50 row: how long does ONE canonical transaction that writes
// `user-deleted` tombstones for N synthetic sources hold the canonical write (and, because the
// SQLite driver is synchronous, the backend's event loop)? Real code path: the product's
// `applyTombstone` (purge through the derivative registry, supersede jobs, invalidation record,
// ledger line) inside `canonicalTransaction`, on a file-backed database with the real tombstone
// ledger file on the real file system (fsync before COMMIT), journal_mode DELETE and
// secure_delete ON as the product driver sets them.
// Each source: V versions, a fact per version, an evidence row per fact ("with evidence").
// Usage: node revoke-batch.ts <scratchDir> <reps> <sizes...>
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { applyTombstone } from "../../../knowledge-engine/src/index.ts";
import {
  addEvidence,
  attachLedger,
  canonicalTransaction,
  insertItem,
  migrate,
  nodeLedgerIo,
  openLedger,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
} from "../../../storage/src/index.ts";
import { openBetterSqlite3 } from "../../../storage/src/adapters/index.ts";

const [scratch, repsArg, ...sizeArgs] = process.argv.slice(2);
if (!scratch || !repsArg || sizeArgs.length === 0)
  throw new Error("usage: revoke-batch.ts <dir> <reps> <sizes...>");
const reps = Number(repsArg);
const VERSIONS = 3;
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
console.log(
  `node ${process.version} ${process.platform}-${process.arch}; versions per source=${VERSIONS}, 1 fact + 1 evidence per version`,
);

function seed(db: SqlDriver, n: number): number {
  registerConnectorInstance(db, "local-files", "local-files");
  const item = insertItem(db, { type: "Project", name: "synthetic", ...attrs });
  for (let s = 0; s < n; s++) {
    for (let v = 0; v < VERSIONS; v++) {
      const body = `synthetic body ${s} version ${v} `.repeat(40);
      const saved = saveSourceRecord(db, "local-files", {
        namespace: "loc1",
        externalId: `file-${s}`,
        title: `file-${s}`,
        body,
      });
      if (saved.status !== "created") throw new Error(String(saved.status));
      const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
      const fact = saveFact(db, {
        itemId: item,
        kind: "synthetic-kind",
        value: `v-${s}-${v}`,
        ...attrs,
      });
      addEvidence(db, {
        target: { factId: fact.id },
        sourceVersionId: versionId,
        start: 0,
        end: 40,
        quote: body.slice(0, 40),
      });
    }
  }
  return item;
}

for (const size of sizeArgs.map(Number)) {
  const times: number[] = [];
  for (let rep = 0; rep < reps; rep++) {
    const dir = join(scratch, `n${size}-r${rep}`);
    mkdirSync(dir, { recursive: true });
    const db = openBetterSqlite3(join(dir, "canonical.sqlite"));
    migrate(db);
    const ledger = openLedger({
      path: join(dir, "tombstone-ledger.jsonl"),
      key: new Uint8Array(32).fill(7),
      canonicalSeq: 0,
      hasData: false,
      io: nodeLedgerIo,
    });
    attachLedger(db, ledger);
    seed(db, size);
    const t0 = performance.now();
    const outcomes = canonicalTransaction(db, (tx) => {
      const o: string[] = [];
      for (let s = 0; s < size; s++) {
        o.push(
          applyTombstone(tx, {
            identity: {
              connectorInstanceId: "local-files",
              namespace: "loc1",
              externalId: `file-${s}`,
            },
            reason: "user-deleted",
            lastRevision: null,
            at: "2026-11-22T00:00:00.000Z",
          }).outcome,
        );
      }
      return o;
    });
    const ms = performance.now() - t0;
    times.push(ms);
    const left = db.all("SELECT count(*) AS n FROM source_versions")[0]?.n;
    const tomb = db.all("SELECT count(*) AS n FROM tombstones")[0]?.n;
    if (rep === 0)
      console.log(
        `  n=${size}: outcomes ${[...new Set(outcomes)].join(",")}; source_versions left=${left}; tombstones=${tomb}`,
      );
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const s = [...times].sort((a, b) => a - b);
  console.log(
    `n=${size} sources in one transaction: reps=${s.length} ms min=${(s[0] ?? NaN).toFixed(0)} median=${(s[Math.floor(s.length / 2)] ?? NaN).toFixed(0)} max=${(s.at(-1) ?? NaN).toFixed(0)}`,
  );
}
