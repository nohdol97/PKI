// I04-C1 `derivatives.contract` (I04-R1, ARCHITECTURE 5.6): the invalidation
// contract every registered derivative kind runs from its own test file. testkit
// does not depend on storage, so the kind's shape the suite reads is declared here
// (as for the SQL driver contract); a kind that no longer fits it fails to
// typecheck at the call site. The suite drives the kind through its fixture's
// `remove`, which runs the real deletion path (the registry's propagate for a
// registered kind), and judges what is left against the fixture's own record.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

export interface ContractDerivedRef {
  kind: string;
  id: string;
}

export interface ContractSourceVersionRef {
  sourceId: number;
  version: number;
}

/** What the suite reads of a DerivativeKind (storage's type is wider). */
export interface ContractDerivativeKind<Db> {
  readonly kind: string;
  readonly storage: "canonical" | "projection";
  readonly dataPaths: readonly string[];
  lineage(db: Db, ref: ContractDerivedRef): readonly ContractSourceVersionRef[];
}

/**
 * A fresh state built by the kind's own fixture: two sources, `a` (the one the
 * suite deletes) and `b`, and rows of the kind.
 */
export interface DerivativeContractFixture<Db> {
  db: Db;
  sources: { a: number; b: number };
  rows: {
    /** Its lineage holds versions of `a` only. */
    onlyA: ContractDerivedRef;
    /** Its lineage holds versions of `a` and `b`; null exactly where `has.shared` is false. */
    shared: ContractDerivedRef | null;
    /** No lineage at all (a user's own value); null exactly where `has.withoutLineage` is false. */
    withoutLineage: ContractDerivedRef | null;
  };
  /** The source versions that built a row, as the fixture recorded it (not the kind's lineage). */
  builtFrom(ref: ContractDerivedRef): readonly ContractSourceVersionRef[];
  /** Whether the row is still stored (or, for a projection, still held). */
  exists(ref: ContractDerivedRef): boolean | Promise<boolean>;
  /** Deletes the source through the real deletion path; this kind's counts of it. */
  remove(sourceId: number): Counts | Promise<Counts>;
  /**
   * An input made stale by `a`'s deletion (ARCHITECTURE 5.6 ⑥): `attempt` writes
   * it, and must answer `{ status: "stale" }` (commitDerived) or reject with a
   * `StaleFenceError` (projection); `ref` is the row it would have written.
   */
  staleInput(): { ref: ContractDerivedRef; attempt(): unknown };
  /** The data directory the kind's `dataPaths` are under; null for a kind without paths. */
  dataDirectory: string | null;
  /** Text only `onlyA` holds; must not be left in the kind's files (⑦). */
  canary: string;
  close?(): void | Promise<void>;
}

interface Counts {
  removed: number;
  recomputed: number;
}

export interface DerivativeContractSubject<Db> {
  kind: ContractDerivativeKind<Db>;
  /**
   * The rows the kind can have, declared up front so a case that does not apply
   * is reported as not applicable instead of passing (a source version has no
   * shared row: it belongs to one source).
   */
  has: { shared: boolean; withoutLineage: boolean };
  setup(): DerivativeContractFixture<Db> | Promise<DerivativeContractFixture<Db>>;
}

export interface DerivativeContractCase {
  id: string;
  title: string;
  /** Whether the case applies to the subject's kind (reported as not applicable otherwise). */
  applies<Db>(subject: DerivativeContractSubject<Db>): boolean;
  run<Db>(subject: DerivativeContractSubject<Db>): Promise<void>;
}

async function withFixture<Db>(
  subject: DerivativeContractSubject<Db>,
  body: (fx: DerivativeContractFixture<Db>) => Promise<void>,
): Promise<void> {
  const fx = await subject.setup();
  try {
    await body(fx);
  } finally {
    await fx.close?.();
  }
}

function present(ref: ContractDerivedRef | null, name: string): ContractDerivedRef {
  if (ref === null) throw new Error(`the subject declares a ${name} row but its fixture has none`);
  return ref;
}

const key = (v: ContractSourceVersionRef) => `${v.sourceId}@${v.version}`;
const versionSet = (vs: readonly ContractSourceVersionRef[]) => [...new Set(vs.map(key))].sort();

/** Every file under `path` (a file or a directory); none when it does not exist. */
function filesUnder(path: string): string[] {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

function filesHolding(directory: string, paths: readonly string[], canary: string): string[] {
  const needle = Buffer.from(canary, "utf8");
  return paths
    .flatMap((p) => filesUnder(join(directory, p)))
    .filter((file) => readFileSync(file).includes(needle));
}

async function staleOutcome(attempt: () => unknown): Promise<unknown> {
  try {
    return await attempt();
  } catch (error) {
    return error;
  }
}

/** The seven cases of ARCHITECTURE 5.6, runnable on their own (the suite's own tests use that). */
export const DERIVATIVE_CONTRACT_CASES: readonly DerivativeContractCase[] = [
  {
    id: "①",
    title: "deleting a source removes the rows whose lineage is that source only",
    applies: () => true,
    run: (subject) =>
      withFixture(subject, async (fx) => {
        expect(await fx.exists(fx.rows.onlyA)).toBe(true);
        await fx.remove(fx.sources.a);
        expect(await fx.exists(fx.rows.onlyA)).toBe(false);
      }),
  },
  {
    id: "②",
    title: "a row whose lineage keeps another source stays",
    applies: (subject) => subject.has.shared,
    run: (subject) =>
      withFixture(subject, async (fx) => {
        const shared = present(fx.rows.shared, "shared");
        expect(await fx.exists(shared)).toBe(true);
        await fx.remove(fx.sources.a);
        expect(await fx.exists(shared)).toBe(true);
      }),
  },
  {
    id: "③",
    title: "a row without lineage stays when an unrelated source is deleted",
    applies: (subject) => subject.has.withoutLineage,
    run: (subject) =>
      withFixture(subject, async (fx) => {
        const row = present(fx.rows.withoutLineage, "withoutLineage");
        expect(subject.kind.lineage(fx.db, row)).toEqual([]);
        await fx.remove(fx.sources.a);
        expect(await fx.exists(row)).toBe(true);
      }),
  },
  {
    id: "④",
    title: "the same change applied twice counts nothing the second time",
    applies: () => true,
    run: (subject) =>
      withFixture(subject, async (fx) => {
        const first = await fx.remove(fx.sources.a);
        expect(first.removed + first.recomputed).toBeGreaterThan(0);
        expect(await fx.remove(fx.sources.a)).toEqual({ removed: 0, recomputed: 0 });
      }),
  },
  {
    id: "⑤",
    title: "lineage names the source versions that built the row",
    applies: () => true,
    run: (subject) =>
      withFixture(subject, async (fx) => {
        const rows = [fx.rows.onlyA, fx.rows.shared, fx.rows.withoutLineage].filter(
          (r): r is ContractDerivedRef => r !== null,
        );
        for (const ref of rows) {
          expect(versionSet(subject.kind.lineage(fx.db, ref)), `${ref.kind}:${ref.id}`).toEqual(
            versionSet(fx.builtFrom(ref)),
          );
        }
      }),
  },
  {
    id: "⑥",
    title: "a stale input is refused and writes nothing",
    applies: () => true,
    run: (subject) =>
      withFixture(subject, async (fx) => {
        await fx.remove(fx.sources.a);
        const stale = fx.staleInput();
        const outcome = await staleOutcome(() => stale.attempt());
        const refused =
          (outcome instanceof Error && outcome.name === "StaleFenceError") ||
          (typeof outcome === "object" &&
            outcome !== null &&
            (outcome as { status?: unknown }).status === "stale");
        expect(refused, `outcome: ${String(outcome)}`).toBe(true);
        expect(await fx.exists(stale.ref)).toBe(false);
      }),
  },
  {
    id: "⑦",
    title: "no canary is left in the kind's data paths",
    applies: (subject) => subject.kind.dataPaths.length > 0,
    run: (subject) =>
      withFixture(subject, async (fx) => {
        const { dataPaths } = subject.kind;
        if (fx.dataDirectory === null) throw new Error("a kind with data paths needs a directory");
        expect(filesHolding(fx.dataDirectory, dataPaths, fx.canary)).not.toEqual([]);
        await fx.remove(fx.sources.a);
        expect(filesHolding(fx.dataDirectory, dataPaths, fx.canary)).toEqual([]);
      }),
  },
];

export function derivativeKindContract<Db>(
  name: string,
  subject: DerivativeContractSubject<Db>,
): void {
  describe(`derivatives.contract: ${name} (${subject.kind.kind})`, () => {
    for (const c of DERIVATIVE_CONTRACT_CASES) {
      if (c.applies(subject)) it(`${c.id} ${c.title}`, () => c.run(subject));
      // e.g. ⑦ for a kind with only an in-memory implementation: reported, not passed
      else it.skip(`${c.id} ${c.title}: not applicable`, () => {});
    }
  });
}
