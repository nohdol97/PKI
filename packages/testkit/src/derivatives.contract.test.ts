// I04-C1 `derivatives.contract`, the suite itself (I04-T01): a double kind kept in
// memory (and, in one variant, in files) passes every case, and each way of
// breaking the contract makes the case that guards it fail.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaleFenceError } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import {
  DERIVATIVE_CONTRACT_CASES,
  derivativeKindContract,
  type ContractDerivedRef,
  type ContractSourceVersionRef,
  type DerivativeContractSubject,
} from "./derivatives.contract.ts";

type Break =
  | "keeps-only-a"
  | "drops-shared"
  | "drops-without-lineage"
  | "counts-again"
  | "wrong-lineage"
  | "accepts-stale"
  | "leaves-file";

interface Row {
  lineage: ContractSourceVersionRef[];
  text: string;
}

interface MemoryDb {
  rows: Map<string, Row>;
  deleted: Set<number>;
}

const A = 1;
const B = 2;
const CANARY = "zqx-canary-only-a";
const PATH = "memory-double";
const ref = (id: string): ContractDerivedRef => ({ kind: "memory-double", id });
const BUILT: Record<string, ContractSourceVersionRef[]> = {
  "only-a": [{ sourceId: A, version: 1 }],
  shared: [
    { sourceId: A, version: 1 },
    { sourceId: B, version: 1 },
  ],
  mine: [],
};

function subject(
  options: { files?: boolean; broken?: Break } = {},
): DerivativeContractSubject<MemoryDb> {
  const broken = options.broken;
  return {
    kind: {
      kind: "memory-double",
      storage: "canonical",
      dataPaths: options.files ? [PATH] : [],
      lineage: (db, r) => {
        const lineage = db.rows.get(r.id)?.lineage ?? [];
        return broken === "wrong-lineage" ? lineage.filter((v) => v.sourceId !== B) : lineage;
      },
    },
    has: { shared: true, withoutLineage: true },
    setup: () => {
      const db: MemoryDb = { rows: new Map(), deleted: new Set() };
      const dir = options.files ? mkdtempSync(join(tmpdir(), "pki-derivatives-")) : null;
      if (dir) mkdirSync(join(dir, PATH));
      const file = (id: string) => join(dir ?? "", PATH, `${id}.txt`);
      const write = (id: string, row: Row) => {
        db.rows.set(id, row);
        if (dir) writeFileSync(file(id), row.text);
      };
      write("only-a", { lineage: BUILT["only-a"] ?? [], text: `body ${CANARY}` });
      write("shared", { lineage: BUILT.shared ?? [], text: "shared body" });
      write("mine", { lineage: [], text: "typed by the user" });

      const remove = (sourceId: number) => {
        let removed = 0;
        let recomputed = 0;
        const again = broken === "counts-again" && db.deleted.has(sourceId);
        db.deleted.add(sourceId);
        for (const [id, row] of [...db.rows]) {
          const lost = row.lineage.some((v) => v.sourceId === sourceId);
          const kept = row.lineage.filter((v) => v.sourceId !== sourceId);
          const goes =
            (lost && kept.length === 0 && broken !== "keeps-only-a") ||
            (id === "shared" && broken === "drops-shared") ||
            (row.lineage.length === 0 && broken === "drops-without-lineage");
          if (goes) {
            db.rows.delete(id);
            if (dir && broken !== "leaves-file") rmSync(file(id));
            removed++;
          } else if (lost) {
            db.rows.set(id, { ...row, lineage: kept });
            recomputed++;
          }
        }
        return again ? { removed: 1, recomputed: 0 } : { removed, recomputed };
      };
      return {
        db,
        sources: { a: A, b: B },
        rows: { onlyA: ref("only-a"), shared: ref("shared"), withoutLineage: ref("mine") },
        builtFrom: (r) => BUILT[r.id] ?? [],
        exists: (r) => db.rows.has(r.id),
        remove,
        staleInput: () => ({
          ref: ref("late"),
          attempt: () => {
            if (db.deleted.has(A) && broken !== "accepts-stale") {
              throw new StaleFenceError("source a is covered");
            }
            write("late", { lineage: [{ sourceId: A, version: 1 }], text: "late result" });
          },
        }),
        dataDirectory: dir,
        canary: CANARY,
        close: () => {
          if (dir) rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  };
}

derivativeKindContract("memory double", subject());
derivativeKindContract("memory double with files", subject({ files: true }));

const run = (id: string, s: DerivativeContractSubject<MemoryDb>) => {
  const c = DERIVATIVE_CONTRACT_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c.run(s);
};

describe("derivatives.contract: the suite catches a broken kind", () => {
  it.each([
    ["①", "keeps-only-a"],
    ["②", "drops-shared"],
    ["③", "drops-without-lineage"],
    ["④", "counts-again"],
    ["⑤", "wrong-lineage"],
    ["⑥", "accepts-stale"],
  ] as const)("case %s fails a kind that %s", async (id, broken) => {
    await expect(run(id, subject())).resolves.toBeUndefined();
    await expect(run(id, subject({ broken }))).rejects.toThrow();
  });

  it("case ⑦ fails a kind that leaves its canary in a file", async () => {
    await expect(run("⑦", subject({ files: true }))).resolves.toBeUndefined();
    await expect(run("⑦", subject({ files: true, broken: "leaves-file" }))).rejects.toThrow();
  });

  it("does not apply ⑦ to a kind without data paths, and applies the rest", () => {
    const applies = (s: DerivativeContractSubject<MemoryDb>) =>
      DERIVATIVE_CONTRACT_CASES.filter((c) => c.applies(s)).map((c) => c.id);
    expect(applies(subject())).toEqual(["①", "②", "③", "④", "⑤", "⑥"]);
    expect(applies(subject({ files: true }))).toHaveLength(7);
  });

  it("does not apply ② and ③ to a kind declaring no such rows", () => {
    const narrow = { ...subject(), has: { shared: false, withoutLineage: false } };
    expect(DERIVATIVE_CONTRACT_CASES.filter((c) => c.applies(narrow)).map((c) => c.id)).toEqual([
      "①",
      "④",
      "⑤",
      "⑥",
    ]);
  });
});
