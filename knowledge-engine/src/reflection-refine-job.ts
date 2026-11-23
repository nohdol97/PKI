// The `reflection-refine` job (K02-R16, R17): an LLM opinion on one open `synonym` or `missing-link` finding. It
// has no source and no version fence: its target is `<finding id>#<lineage hash>`, the finding as it was when
// the job was queued. It ends without a Provider call when the setting is off, the finding is gone, not open,
// of another rule, changed since (its lineage differs) or already given an opinion, has no lineage or too many
// versions, the policy will not put its lineage together, or its documents do not fit one call. Otherwise it
// makes one Broker call of IDs only (the lineage's version rows and the two items); the Broker grades, and asks
// consent and egress. A call that was not answered goes back to the runner as the Broker gave it (a blocked
// one holds the job); no other Provider is tried. The verdict is kept only when its quote is found, exactly
// once, in the stored body of the document it names; the code computes the position. It is written to the
// finding's opinion column through commitDerived, and only while the finding is still open at that lineage.
import {
  REFLECTION_REFINE_SCHEMA_VERSION,
  type BrokerResult,
  type ReflectionRefineOutput,
} from "@pki/providers";
import {
  findSourceVersionId,
  lineageHash,
  lineageOfFinding,
  readFinding,
  readReflectionRefine,
  readSourceVersion,
  REFLECTION_REFINE_KIND,
  REFLECTION_REFINE_MAX_VERSIONS,
  writeFindingOpinion,
  type DerivedItem,
  type DerivativeRegistry,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { derivativeRegistry } from "./canonical-kinds.ts";
import { EXTRACT_TIMEOUT_MS, MAX_EXTRACT_CODE_POINTS, type RunBroker } from "./extraction.ts";
import { LINT_FINDING_KIND_NAME } from "./lint-kind.ts";
import { itemsOfFinding } from "./lint-rules.ts";
import { locateQuote } from "./quote.ts";

/** What the handler hands the runner (a subset of backend job-outcomes.ts JobResult). */
export type ReflectionRefineResult =
  { status: "succeeded"; items: readonly DerivedItem[] } | Exclude<BrokerResult, { status: "ok" }>;

export interface ReflectionRefineHandlerOptions {
  db: SqlDriver;
  /** The registry whose policy says whether a lineage may be put together; default the entries' own. */
  registry?: Pick<DerivativeRegistry, "combinable">;
}

const nothing: ReflectionRefineResult = { status: "succeeded", items: [] };

export function createReflectionRefineHandler(options: ReflectionRefineHandlerOptions) {
  const { db } = options;
  const registry = options.registry ?? derivativeRegistry;

  return async (
    job: StoredJob,
    context: { broker: RunBroker },
  ): Promise<ReflectionRefineResult> => {
    const split = job.target.lastIndexOf("#");
    const id = Number(job.target.slice(0, split));
    const asked = job.target.slice(split + 1);
    const finding = Number.isInteger(id) ? readFinding(db, id) : undefined;
    if (!readReflectionRefine(db) || !finding) return nothing;
    if (finding.status !== "open" || finding.target.b === null) return nothing;
    if (finding.rule !== "synonym" && finding.rule !== "missing-link") return nothing;
    const lineage = lineageOfFinding(db, id);
    if (lineage.length === 0 || lineage.length > REFLECTION_REFINE_MAX_VERSIONS) return nothing;
    if (lineageHash(lineage) !== asked || finding.opinionLineageHash === asked) return nothing;
    const items = itemsOfFinding(db, finding.target);
    if (!items || items.length !== 2) return nothing;
    // a combination the policy refuses is not put in one call, and so not in one opinion
    if (!registry.combinable(db, lineage)) return nothing;

    const documents = new Map<string, { sourceId: number; version: number; body: string }>();
    let size = 0;
    for (const ref of lineage) {
      const versionId = findSourceVersionId(db, ref.sourceId, ref.version);
      const stored = versionId === undefined ? undefined : readSourceVersion(db, versionId);
      if (versionId === undefined || !stored) return nothing;
      size += [...stored.title].length + [...stored.body].length;
      documents.set(String(versionId), { ...ref, body: stored.body });
    }
    if (size > MAX_EXTRACT_CODE_POINTS) return nothing;

    const result = await context.broker.call({
      taskKind: REFLECTION_REFINE_KIND,
      sourceVersionIds: [...documents.keys()],
      candidateItemIds: items.map(String),
      origin: { jobId: String(job.id), leaseToken: String(job.leaseToken) },
      schemaVersion: REFLECTION_REFINE_SCHEMA_VERSION,
      budget: { timeoutMs: EXTRACT_TIMEOUT_MS },
      retryable: false,
    });
    if (result.status !== "ok") return result;

    // the Broker checked the answer against the schema
    const answer = result.output as ReflectionRefineOutput;
    const document = documents.get(answer.documentId);
    const span = document && locateQuote(document.body, answer.quote);
    if (!document || !span || "dropped" in span) return nothing;
    const opinion = JSON.stringify({
      verdict: answer.verdict,
      sourceId: document.sourceId,
      version: document.version,
      start: span.start,
      end: span.end,
    });
    return {
      status: "succeeded",
      items: [
        {
          kind: LINT_FINDING_KIND_NAME,
          itemKey: `refine:${id}`,
          lineage,
          write: (tx: SqlDriver) => void writeFindingOpinion(tx, id, asked, opinion),
        },
      ],
    };
  };
}
