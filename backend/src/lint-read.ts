// The lint's read path and the user's decisions on it (K02-R12, R14, R15). A finding is stored without its
// scope: what leaves the backend is judged now. It is shown only while every row it bears on is stored and
// shown (the read gate), the whole lineage is shown (the registry's `visible`) and the policy lets that lineage
// be put together (`combinable`). The counts are of the shown findings alone, so a hidden finding leaves no
// trace in a number. A finding the caller may not see answers `not-found`, as for any hidden row.
import type { RouteRequest, RouteResponse } from "@pki/contracts";
import {
  decideFinding,
  hasRuleShape,
  itemsOfFinding,
  reportMissed,
  type LintEntries,
} from "@pki/knowledge-engine";
import {
  countDirty,
  lineageOfFinding,
  listFindings,
  LINT_RULES,
  readFinding,
  type DerivativeRegistry,
  type FindingTarget,
  type SqlDriver,
  type StoredFinding,
} from "@pki/storage";
import type { ReadGate } from "./read-gate.ts";

type Lint = RouteResponse<"lint">;
type Finding = Lint["findings"][number];

/** Provisional: evidence ids one finding lists. */
const EVIDENCE_PER_FINDING = 10;

class HiddenReport extends Error {}

export interface LintReads {
  list(): Lint;
  decide(request: RouteRequest<"lintDecide">, at: string): RouteResponse<"lintDecide">;
  report(
    request: RouteRequest<"lintReport">,
    at: string,
  ): RouteResponse<"lintReport"> | { error: "bad-request" };
}

export function createLintReads(
  db: SqlDriver,
  registry: DerivativeRegistry,
  gate: ReadGate,
  decisions: () => LintEntries | undefined,
  /** Called after an accepted entry changed knowledge, in its transaction, with the rows it bore on (the Insight rules, candidates and conflicts follow). */
  afterEntry: (
    rows: readonly { kind: "item" | "fact" | "relation"; id: number }[],
    at: string,
  ) => void,
): LintReads {
  const rowsOf = (t: FindingTarget): { kind: "item" | "fact" | "relation"; id: number }[] =>
    t.kind === "item"
      ? [t.a, ...(t.b === null ? [] : [t.b])].map((id) => ({ kind: "item" as const, id }))
      : [{ kind: t.kind, id: t.a }];

  /**
   * Every row of the target and every item it sits on is stored and shown: a fact's or relation's lineage is
   * a part of its item's, so the row can be shown while the item it names is not (the graph read asks both).
   */
  const targetShown = (t: FindingTarget): boolean => {
    const items = itemsOfFinding(db, t);
    return (
      items !== undefined &&
      rowsOf(t).every((r) => gate.semanticShown(r.kind, r.id)) &&
      items.every((i) => gate.semanticShown("item", i))
    );
  };
  /** The one judgement every read goes through. */
  const shown = (f: StoredFinding): boolean =>
    targetShown(f.target) &&
    registry.visible(db, [{ kind: "lint-finding", id: String(f.id) }], "display").length === 1 &&
    registry.combinable(db, lineageOfFinding(db, f.id));

  const nameOf = (item: number) =>
    (db.all("SELECT name FROM items WHERE id = ?", [item])[0]?.name as string | undefined) ?? "";
  const label = (r: { kind: "item" | "fact" | "relation"; id: number }): string => {
    if (r.kind === "item") return nameOf(r.id);
    if (r.kind === "fact") {
      const f = db.all("SELECT item_id, kind, value FROM facts WHERE id = ?", [r.id])[0];
      return f ? `${nameOf(f.item_id as number)} · ${f.kind as string}: ${f.value as string}` : "";
    }
    const rel = db.all("SELECT subject_id, type, object_id FROM relations WHERE id = ?", [r.id])[0];
    return rel
      ? `${nameOf(rel.subject_id as number)} ${rel.type as string} ${nameOf(rel.object_id as number)}`
      : "";
  };
  /** The evidence rows of the target rows that lie in the finding's lineage and are shown. */
  const evidenceOf = (f: StoredFinding): number[] => {
    const lineage = JSON.stringify(
      lineageOfFinding(db, f.id).map((v) => ({ source_id: v.sourceId, version: v.version })),
    );
    const owners =
      f.target.kind === "item"
        ? `(e.fact_id IN (SELECT id FROM facts WHERE item_id IN (SELECT value FROM json_each(?)))
           OR e.relation_id IN (SELECT id FROM relations WHERE subject_id IN (SELECT value FROM json_each(?))
                                  OR object_id IN (SELECT value FROM json_each(?))))`
        : f.target.kind === "fact"
          ? "e.fact_id = ?"
          : "e.relation_id = ?";
    const ids = JSON.stringify(rowsOf(f.target).map((r) => r.id));
    const ids3 = f.target.kind === "item" ? [ids, ids, ids] : [f.target.a];
    const rows = db.all(
      `SELECT e.id FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
        WHERE ${owners}
          AND EXISTS (SELECT 1 FROM json_each(?) j
                      WHERE json_extract(j.value, '$.source_id') = v.source_id
                        AND json_extract(j.value, '$.version') = v.version)
        ORDER BY e.id LIMIT ?`,
      [...ids3, lineage, EVIDENCE_PER_FINDING * 4],
    );
    const ok = new Set(
      registry
        .visible(
          db,
          rows.map((r) => ({ kind: "evidence", id: String(r.id) })),
          "display",
        )
        .map((r) => r.id),
    );
    return rows
      .map((r) => r.id as number)
      .filter((id) => ok.has(String(id)))
      .slice(0, EVIDENCE_PER_FINDING);
  };
  const view = (f: StoredFinding): Finding => ({
    id: f.id,
    rule: f.rule,
    status: f.status,
    origin: f.origin,
    flips: f.flips,
    targets: rowsOf(f.target).map((r) => ({ ...r, label: label(r) })),
    evidence: evidenceOf(f),
  });

  return {
    list() {
      const visible = listFindings(db).filter(shown);
      const counts = LINT_RULES.map((rule) => {
        const mine = visible.filter((f) => f.rule === rule);
        const n = (pick: (f: StoredFinding) => boolean) => mine.filter(pick).length;
        return {
          rule,
          open: n((f) => f.status === "open"),
          accepted: n((f) => f.status === "accepted"),
          falsePositive: n((f) => f.origin === "rule" && f.status === "dismissed"),
          missed: n((f) => f.origin === "user"),
          oscillating: n((f) => f.status === "oscillating"),
        };
      });
      const run = db.all(
        `SELECT finished_at, result_counts FROM jobs WHERE kind = 'reflect' AND status = 'succeeded'
          ORDER BY finished_at DESC, id DESC LIMIT 1`,
      )[0];
      return {
        findings: visible.filter((f) => f.status !== "resolved").map(view),
        counts,
        lastRun: run
          ? {
              at: new Date(run.finished_at as number).toISOString(),
              counts: JSON.parse((run.result_counts as string | null) ?? "{}") as Record<
                string,
                number
              >,
            }
          : null,
        dirty: countDirty(db),
      };
    },

    decide(request, at) {
      const d = decisions();
      const found = readFinding(db, request.id);
      if (!d || !found || !shown(found)) return { status: "not-found" };
      return db.transaction(() => {
        const done = decideFinding(
          db,
          d,
          {
            id: request.id,
            op: request.op,
            ...(request.relationType === undefined ? {} : { relationType: request.relationType }),
          },
          at,
        );
        if (done.status === "not-found") return { status: "not-found" as const };
        if (done.status === "refused") return { status: "refused" as const, reason: done.reason };
        if (request.op === "accept") {
          afterEntry(rowsOf(found.target), at);
        }
        return { status: "applied" as const, finding: view(done.finding) };
      });
    },

    report(request, at) {
      const target: FindingTarget = { kind: request.kind, a: request.a, b: request.b ?? null };
      if (!hasRuleShape(request.rule, target)) return { error: "bad-request" };
      // a row that is absent, deleted or hidden: the one answer
      if (!targetShown(target)) return { status: "not-found" };
      // a report the caller could not see afterwards is rolled back whole, not left stored
      try {
        return db.transaction(() => {
          const done = reportMissed(db, { rule: request.rule, target }, at);
          if (done.status === "refused") return { status: "not-found" as const };
          if (!shown(done.finding)) throw new HiddenReport();
          return { status: done.status, finding: view(done.finding) };
        });
      } catch (error) {
        if (error instanceof HiddenReport) return { status: "not-found" };
        throw error;
      }
    },
  };
}
