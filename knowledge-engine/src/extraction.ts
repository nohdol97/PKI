// The extract job handler (V02-R6, R7, R8; ADR 0003): one source version, one
// structured Broker call (asked once more only when the answer did not match the
// schema). The handler sends IDs only: the version, the candidate items whose name
// the text holds, and the leased job with its lease token as origin, taken from
// the job the runner leased and from nothing else. The Broker reads the text,
// attaches the instructions, grades and gates the call (background, consent,
// egress). A blocked call holds the job with the Broker's reason; there is no
// other Provider to fall back to. A source too large for one call is held
// without a call (no chunking). The answer's facts and relations are kept only
// with a quote the body holds exactly once; the code computes the span. Rows are
// the same row by the tables' keys (V02-R8); a same row gets evidence only. The
// result is written by the runner inside the fence transaction, with the dropped
// counts and the rule "의존 업무 지연" over the items written.
import {
  EXTRACT_SCHEMA_VERSION,
  type Broker,
  type BrokerResult,
  type ExtractionOutput,
} from "@pki/providers";
import {
  addEvidence,
  findSourceVersionId,
  insertItem,
  readItem,
  readSourceVersion,
  recordExtractionDrops,
  saveFact,
  saveRelation,
  type EvidenceTarget,
  type JobClosing,
  type KnowledgeAttributes,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { isDate, recomputeDependencyDelay } from "./dependency-delay.ts";
import { findCandidates } from "./linking.ts";
import { locateQuote, type QuoteSpan } from "./quote.ts";

/** What the handler hands the runner (job-runner.ts JobResult). */
export type ExtractResult = Exclude<JobClosing, { status: "superseded" }>;

/** The hold reason of a source too large for one call; changing settings does not release it. */
export const EXTRACT_HOLD_TOO_LARGE = "source-too-large";
/** Provisional: title and body, in code points, that one call takes (no chunking, V02-R8). */
export const MAX_EXTRACT_CODE_POINTS = 20_000;
/** Provisional: the Broker's ceiling for one request. */
export const EXTRACT_TIMEOUT_MS = 120_000;

export interface ExtractHandlerOptions {
  db: SqlDriver;
  broker: Pick<Broker, "call">;
  now?: () => Date;
}

type Item = ExtractionOutput["items"][number];
interface Planned {
  target: { item: string } | { subject: string; object: string };
  save: (ids: (ref: string) => number) => EvidenceTarget;
  span: QuoteSpan;
  quote: string;
}

/** Calls once, and once more only for an answer that did not match the schema. */
async function extractOnce(
  broker: ExtractHandlerOptions["broker"],
  request: object,
): Promise<BrokerResult> {
  const first = await broker.call(request);
  if (first.status === "failed" && first.error === "invalid-output") return broker.call(request);
  return first;
}

export function createExtractHandler(options: ExtractHandlerOptions) {
  const { db, broker } = options;
  const now = options.now ?? (() => new Date());

  return async (job: StoredJob): Promise<ExtractResult> => {
    const versionId = findSourceVersionId(db, job.sourceId, job.fenceVersion);
    const stored = versionId === undefined ? undefined : readSourceVersion(db, versionId);
    if (versionId === undefined || !stored) return { status: "failed", reason: "missing-version" };
    if ([...stored.title].length + [...stored.body].length > MAX_EXTRACT_CODE_POINTS) {
      return { status: "held", reason: EXTRACT_HOLD_TOO_LARGE };
    }
    const candidates = findCandidates(db, `${stored.title}\n${stored.body}`).map(String);
    const result = await extractOnce(broker, {
      taskKind: "extract",
      sourceVersionIds: [String(versionId)],
      candidateItemIds: candidates,
      origin: { jobId: String(job.id), lease: String(job.leaseToken) },
      schemaVersion: EXTRACT_SCHEMA_VERSION,
      budget: { timeoutMs: EXTRACT_TIMEOUT_MS },
      // one call (V02-R6): a transient failure fails the job; retry policy is I03's
      retryable: false,
    });
    switch (result.status) {
      case "blocked":
        return { status: "held", reason: result.reason };
      case "rejected":
        return { status: "failed", reason: result.reason };
      case "failed":
        return { status: "failed", reason: result.error };
    }
    const answer = result.output as ExtractionOutput; // the Broker checked it against the schema
    const body = stored.body;
    const drops = { quotes: 0, other: 0 };

    // items of this answer by its refs; an existing ID must be one of the candidates sent
    const items = new Map<string, Item>();
    for (const item of answer.items) {
      if (items.has(item.ref)) continue; // the first entry of a ref is the one used
      if (item.existingItemId !== null && !candidates.includes(item.existingItemId)) {
        drops.other++;
        continue;
      }
      items.set(item.ref, item);
    }

    const planned: Planned[] = [];
    const plan = (refs: string[], quote: string, entry: Omit<Planned, "span" | "quote">) => {
      if (!refs.every((ref) => items.has(ref))) return void drops.other++;
      const span = locateQuote(body, quote);
      if ("dropped" in span) return void drops.quotes++;
      planned.push({ ...entry, span, quote });
    };
    const attributes = (epistemic: KnowledgeAttributes["epistemic"]): KnowledgeAttributes => ({
      epistemic,
      status: "candidate",
      validAt: null,
      observedAt: now().toISOString(),
    });
    for (const fact of answer.facts) {
      const value = fact.value.trim();
      if (!isDate(value)) {
        drops.other++;
        continue;
      }
      plan([fact.item], fact.quote, {
        target: { item: fact.item },
        save: (ids) => ({
          factId: saveFact(db, {
            itemId: ids(fact.item),
            kind: fact.kind,
            value,
            ...attributes(fact.epistemic),
          }).id,
        }),
      });
    }
    for (const relation of answer.relations) {
      plan([relation.subject, relation.object], relation.quote, {
        target: { subject: relation.subject, object: relation.object },
        save: (ids) => ({
          relationId: saveRelation(db, {
            subjectId: ids(relation.subject),
            type: relation.type,
            objectId: ids(relation.object),
            ...attributes("explicit"),
          }).id,
        }),
      });
    }

    return {
      status: "done",
      write: () => {
        // an item is created only for a fact or relation that is kept
        const ids = new Map<string, number>();
        const touched = new Set<number>();
        const idOf = (ref: string): number | undefined => {
          if (ids.has(ref)) return ids.get(ref);
          const item = items.get(ref) as Item;
          let id: number | undefined;
          if (item.existingItemId !== null) {
            id = readItem(db, Number(item.existingItemId))?.id; // deleted meanwhile: undefined
          } else {
            id = insertItem(db, { type: item.type, name: item.name, ...attributes("explicit") });
          }
          if (id !== undefined) ids.set(ref, id);
          return id;
        };
        for (const entry of planned) {
          const refs =
            "item" in entry.target
              ? [entry.target.item]
              : [entry.target.subject, entry.target.object];
          const resolved = refs.map(idOf);
          if (resolved.some((id) => id === undefined)) {
            drops.other++;
            continue;
          }
          for (const id of resolved) touched.add(id as number);
          addEvidence(db, {
            target: entry.save((ref) => ids.get(ref) as number),
            sourceVersionId: versionId,
            ...entry.span,
            quote: entry.quote,
          });
        }
        recordExtractionDrops(db, job.id, drops);
        recomputeDependencyDelay(db, [...touched]);
      },
    };
  };
}
