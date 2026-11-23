// The `insight-interpret` job (P01-R7, D12-D18): an LLM reading of one Insight. It has no source and no version
// fence: its target is `<insight id>#<basis>`, the Insight as it was when the job was queued. It ends without a
// Provider call when the setting is off, the Insight is gone, not active, an `opportunity`, changed since (its
// basis differs) or already interpreted, has no lineage or too many versions, the policy will not put its
// lineage together, or its documents do not fit one call. Otherwise it makes one Broker call of IDs only (the
// lineage's version rows, the two items and the Insight itself as a graded candidate); the Broker grades, and
// asks consent and egress. A call that was not answered goes back to the runner as the Broker gave it (a
// blocked one holds the job); no other Provider is tried. The answer is checked by the Broker's schema; the
// code writes three columns of the Insight row, only while its basis still holds, and, when the answer
// proposes an opportunity, one `opportunity` row that copies the parent's evidence and lines (code decides
// evidence, duplicates and state; the model supplies the statement alone).
import {
  INSIGHT_INTERPRET_SCHEMA_VERSION,
  type BrokerResult,
  type InsightInterpretOutput,
} from "@pki/providers";
import {
  findSourceVersionId,
  INSIGHT_INTERPRET_KIND,
  INSIGHT_INTERPRET_MAX_VERSIONS,
  insightBasis,
  OPPORTUNITY_RULE,
  readInsight,
  readInsightById,
  readInsightInterpret,
  readSourceVersion,
  saveInsight,
  writeInsightInterpretation,
  type DerivedItem,
  type DerivativeRegistry,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { derivativeRegistry } from "./canonical-kinds.ts";
import { insightGradingLineage } from "./linking.ts";
import { EXTRACT_TIMEOUT_MS, MAX_EXTRACT_CODE_POINTS, type RunBroker } from "./extraction.ts";
import { OPPORTUNITY_CONFIDENCE_CAP } from "./insight-code-rules.ts";

/** What the handler hands the runner (a subset of backend job-outcomes.ts JobResult). */
export type InsightInterpretResult =
  { status: "succeeded"; items: readonly DerivedItem[] } | Exclude<BrokerResult, { status: "ok" }>;

export interface InsightInterpretHandlerOptions {
  db: SqlDriver;
  /** The registry whose policy says whether a lineage may be put together; default the entries' own. */
  registry?: Pick<DerivativeRegistry, "combinable" | "lineage">;
  now?: () => Date;
}

const nothing: InsightInterpretResult = { status: "succeeded", items: [] };

export function createInsightInterpretHandler(options: InsightInterpretHandlerOptions) {
  const { db } = options;
  const registry = options.registry ?? derivativeRegistry;
  const now = options.now ?? (() => new Date());

  return async (
    job: StoredJob,
    context: { broker: RunBroker },
  ): Promise<InsightInterpretResult> => {
    const cut = job.target.lastIndexOf("#");
    const id = Number(job.target.slice(0, cut));
    const basis = job.target.slice(cut + 1);
    const insight = readInsightById(db, id);
    if (!readInsightInterpret(db) || !insight || insight.state !== "active") return nothing;
    if (insight.rule === OPPORTUNITY_RULE || insight.interpretation !== null) return nothing;
    if (insightBasis(insight) !== basis) return nothing;
    // R9: a combination the policy refuses is not put in one call, and so not in one reading
    const lineage = registry.lineage(db, { kind: "insight", id: String(id) });
    if (lineage.length === 0 || lineage.length > INSIGHT_INTERPRET_MAX_VERSIONS) return nothing;
    // the call also carries the two items' names (candidates) and the text built from them: the policy is asked
    // over the Insight's lineage and the items' group lineage together, as the candidate lookup grades it (D26)
    if (!registry.combinable(db, insightGradingLineage(db, registry, insight))) return nothing;

    const versionIds: string[] = [];
    let size = 0;
    for (const ref of lineage) {
      const versionId = findSourceVersionId(db, ref.sourceId, ref.version);
      const stored = versionId === undefined ? undefined : readSourceVersion(db, versionId);
      if (versionId === undefined || !stored) return nothing;
      size += [...stored.title].length + [...stored.body].length;
      versionIds.push(String(versionId));
    }
    if (size > MAX_EXTRACT_CODE_POINTS) return nothing;

    const result = await context.broker.call({
      taskKind: INSIGHT_INTERPRET_KIND,
      sourceVersionIds: versionIds,
      candidateItemIds: [
        ...new Set([String(insight.xItemId), String(insight.yItemId)]),
        `insight:${id}`,
      ],
      origin: { jobId: String(job.id), leaseToken: String(job.leaseToken) },
      schemaVersion: INSIGHT_INTERPRET_SCHEMA_VERSION,
      budget: { timeoutMs: EXTRACT_TIMEOUT_MS },
      retryable: false,
    });
    if (result.status !== "ok") return result;

    // the Broker checked the answer against the strict schema
    const { reasoningSummary, impact, actionability, opportunity } =
      result.output as InsightInterpretOutput;
    const at = now().toISOString();
    return {
      status: "succeeded",
      items: [
        {
          kind: "insight",
          itemKey: `interpret:${id}`,
          lineage,
          write: (tx: SqlDriver) => {
            // refused when the Insight changed or resolved meanwhile: then nothing of the answer is kept
            if (
              !writeInsightInterpretation(tx, id, basis, {
                reasoningSummary,
                impact,
                actionability,
              })
            )
              return;
            if (opportunity) proposeOpportunity(tx, id, opportunity.statement, at);
          },
        },
      ],
    };
  };
}

/**
 * Writes the proposal as an `opportunity` row on the parent's key (D18): the statement is its summary (an
 * inference), everything else is the parent's, copied by code. Dropped while an active row holds the key; a
 * resolved row is brought back in place.
 */
function proposeOpportunity(tx: SqlDriver, parentId: number, statement: string, at: string): void {
  const parent = readInsightById(tx, parentId);
  if (!parent) return;
  const key = { rule: OPPORTUNITY_RULE, xItemId: parent.xItemId, yItemId: parent.yItemId };
  if (readInsight(tx, key)?.state === "active") return;
  saveInsight(tx, key, {
    state: "active",
    summary: statement,
    factLines: parent.factLines,
    reasoningSummary:
      "해석 작업이 부모 Insight의 근거를 바탕으로 제안한 기회입니다. 근거와 상태는 코드가 정합니다.",
    confidence: Math.min(
      OPPORTUNITY_CONFIDENCE_CAP,
      parent.confidence ?? OPPORTUNITY_CONFIDENCE_CAP,
    ),
    urgencyDate: parent.urgencyDate,
    evidenceIds: parent.evidenceIds,
    userInputs: parent.userInputs,
    linkIds: parent.linkIds,
    changedAt: at,
  });
}
