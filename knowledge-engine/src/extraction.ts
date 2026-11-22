// The extract job handler (V02-R6, R7, R8; ADR 0003): one source version, one
// structured Broker call (asked once more only when the answer did not match the
// schema). The handler sends IDs only: the version, the candidate items whose name
// the text holds, and the running job with its lease token as origin, taken from
// the job the runner leased and from nothing else. The Broker reads the text,
// attaches the instructions, grades and gates the call (background, consent,
// egress). A call that was not answered is handed to the runner as the Broker
// gave it; the runner's outcome table decides (a blocked call holds the job with
// the Broker's reason, a transient failure is retried; I03-R9): there is no
// other Provider to fall back to. A source too large for one call is held
// without a call (no chunking). The answer's facts and relations are kept only
// with a quote the body holds exactly once; the code computes the span. Rows are
// the same row by the tables' keys (V02-R8); a same row gets evidence only, and a
// superseded same row is revived by it (V02-R11). The result is handed over as
// items (I04-R11): one per kept fact or relation, then the rule "의존 업무 지연" with
// the dropped counts. The runner writes them through commitDerived, inside the
// fence transaction, and only when the source version and every source a kept
// entry drew on (a candidate item's evidence, read when the item was offered) are
// still stored and uncovered; otherwise none of it is written.
// Just before the call, an engine with the propose capability is asked for its
// candidates for the same version (V02-R13); they pass the same checks as the
// answer (the extraction schema, the offered candidate IDs, the exact quote) and
// are written with it, as candidates. An engine that fails proposes nothing.
import type { KnowledgeCandidate, KnowledgeEngine, SourceVersionRef } from "@pki/contracts";
import {
  EXTRACT_SCHEMA_VERSION,
  TASKS,
  type BrokerResult,
  type ExtractionOutput,
} from "@pki/providers";
import {
  addEvidence,
  findSourceVersionId,
  insertItem,
  readSourceVersion,
  recordExtractionDrops,
  reviveSuperseded,
  saveFact,
  saveRelation,
  type DerivedItem,
  type EvidenceTarget,
  type KnowledgeAttributes,
  type SourceVersionRef as LineageRef,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { derivativeRegistry } from "./canonical-kinds.ts";
import { isDate, recomputeDependencyDelay } from "./dependency-delay.ts";
import { findCandidates } from "./linking.ts";
import { locateQuote, type QuoteSpan } from "./quote.ts";

/** What the handler hands the runner (a subset of backend job-outcomes.ts JobResult). */
export type ExtractResult =
  | { status: "succeeded"; items: readonly DerivedItem[] }
  | { status: "held"; reason: string }
  | { status: "fail"; code: string; retryable: false }
  | Exclude<BrokerResult, { status: "ok" }>;

/** The hold reason of a source too large for one call; changing settings does not release it. */
export const EXTRACT_HOLD_TOO_LARGE = "source-too-large";
/** Provisional: title and body, in code points, that one call takes (no chunking, V02-R8). */
export const MAX_EXTRACT_CODE_POINTS = 20_000;
/** Provisional: the Broker's ceiling for one request. */
export const EXTRACT_TIMEOUT_MS = 120_000;

export interface ExtractHandlerOptions {
  db: SqlDriver;
  /** The bound KnowledgeEngine (composition.ts); asked only when it reports the propose capability. */
  engine?: Pick<KnowledgeEngine, "capabilities" | "proposeKnowledge">;
  /** An engine error; its message may carry engine text, so log its class only. */
  onEngineError?: (error: unknown) => void;
  /**
   * True while the engine missed a notice (projections.ts isStale): it may still
   * hold purged text, which a proposed item name could carry back, so it is not asked.
   */
  isEngineStale?: () => boolean;
  now?: () => Date;
}

type Item = ExtractionOutput["items"][number];
interface Planned {
  /** `fact` or `relation`: the registered kind of the row it writes. */
  kind: "fact" | "relation";
  /** The same-row key's content, for the item's record (hashed before it is kept, I04-R7). */
  key: string;
  target: { item: string } | { subject: string; object: string };
  save: (tx: SqlDriver, ids: (ref: string) => number) => EvidenceTarget;
  span: QuoteSpan;
  quote: string;
}

/** Calls once, and once more only for an answer that did not match the schema. */
async function extractOnce(broker: RunBroker, request: object): Promise<BrokerResult> {
  const first = await broker.call(request);
  if (first.status === "failed" && first.error === "invalid-output") return broker.call(request);
  return first;
}

/** The engine's candidates for `ref`; none without the capability or when it fails. */
async function proposals(
  options: ExtractHandlerOptions,
  ref: SourceVersionRef,
): Promise<readonly KnowledgeCandidate[]> {
  const { engine } = options;
  try {
    if (!engine?.capabilities().propose || options.isEngineStale?.()) return [];
    const proposed = await engine.proposeKnowledge(ref);
    return Array.isArray(proposed) ? proposed : [];
  } catch (error) {
    options.onEngineError?.(error);
    return [];
  }
}

const OUTPUT = TASKS.extract[EXTRACT_SCHEMA_VERSION].output;

/**
 * The candidates in the answer's shape, each checked against the extraction
 * schema like the answer (V02-R6). A candidate for another version, or one the
 * schema rejects, is dropped. Candidates naming the same item share its ref.
 */
function engineAnswer(
  candidates: readonly KnowledgeCandidate[],
  ref: SourceVersionRef,
  drops: { other: number },
): ExtractionOutput {
  const out: ExtractionOutput = { items: [], facts: [], relations: [] };
  const refs = new Map<string, string>();
  // engine output is untrusted: read defensively, the schema decides
  for (const c of candidates) {
    if (c?.ref?.sourceId !== ref.sourceId || c.ref.version !== ref.version) {
      drops.other++;
      continue;
    }
    // this candidate's new refs, kept only if it passes
    const pending = new Map<string, string>();
    const items: unknown[] = [];
    const refOf = (item: unknown) => {
      const { type, name, existingItemId } = (item ?? {}) as Record<string, unknown>;
      const key = JSON.stringify([type, name, existingItemId]);
      const known = refs.get(key) ?? pending.get(key);
      if (known) return known;
      const fresh = `e${refs.size + pending.size}`;
      pending.set(key, fresh);
      items.push({ ref: fresh, type, name, existingItemId });
      return fresh;
    };
    const one =
      c.kind === "fact"
        ? {
            facts: [
              {
                item: refOf(c.item),
                kind: c.factKind,
                value: c.value,
                epistemic: c.epistemic,
                quote: c.quote,
              },
            ],
            relations: [],
          }
        : c.kind === "relation"
          ? {
              facts: [],
              relations: [
                {
                  subject: refOf(c.subject),
                  type: c.type,
                  object: refOf(c.object),
                  quote: c.quote,
                },
              ],
            }
          : undefined;
    const parsed = one && OUTPUT.safeParse({ items, ...one });
    if (!parsed?.success) {
      drops.other++;
      continue;
    }
    const valid = parsed.data as ExtractionOutput;
    for (const [key, fresh] of pending) refs.set(key, fresh);
    out.items.push(...valid.items);
    out.facts.push(...valid.facts);
    out.relations.push(...valid.relations);
  }
  return out;
}

/** The answers in one, each answer's refs kept to itself. */
function merged(answers: readonly ExtractionOutput[]): ExtractionOutput {
  const out: ExtractionOutput = { items: [], facts: [], relations: [] };
  answers.forEach((answer, i) => {
    const ns = (ref: string) => `${i}:${ref}`;
    out.items.push(...answer.items.map((item) => ({ ...item, ref: ns(item.ref) })));
    out.facts.push(...answer.facts.map((fact) => ({ ...fact, item: ns(fact.item) })));
    out.relations.push(
      ...answer.relations.map((r) => ({ ...r, subject: ns(r.subject), object: ns(r.object) })),
    );
  });
  return out;
}

/** The run's Broker: the job context's wrapped one counts and cancels (I03-R14). */
export interface RunBroker {
  call(raw: unknown): Promise<BrokerResult>;
}

export function createExtractHandler(options: ExtractHandlerOptions) {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  return async (job: StoredJob, context: { broker: RunBroker }): Promise<ExtractResult> => {
    const { broker } = context;
    const { sourceId, fenceVersion } = job; // an extract job has both (schema v10 CHECK)
    const versionId =
      sourceId === null || fenceVersion === null
        ? undefined
        : findSourceVersionId(db, sourceId, fenceVersion);
    const stored = versionId === undefined ? undefined : readSourceVersion(db, versionId);
    if (versionId === undefined || !stored) {
      return { status: "fail", code: "missing-version", retryable: false };
    }
    if ([...stored.title].length + [...stored.body].length > MAX_EXTRACT_CODE_POINTS) {
      return { status: "held", reason: EXTRACT_HOLD_TOO_LARGE };
    }
    const candidates = findCandidates(db, `${stored.title}\n${stored.body}`).map(String);
    // What each candidate item came from, read now, when it is offered: a source it
    // draws on that is gone when the result is written makes the result stale
    // (I04-R11). Read after the call, a deleted item's lineage would be empty.
    const candidateLineage = new Map(
      candidates.map((id) => [id, derivativeRegistry.lineage(db, { kind: "item", id })]),
    );
    const ref = { sourceId: String(sourceId), version: fenceVersion as number };
    const proposed = await proposals(options, ref);
    const result = await extractOnce(broker, {
      taskKind: "extract",
      sourceVersionIds: [String(versionId)],
      candidateItemIds: candidates,
      origin: { jobId: String(job.id), leaseToken: String(job.leaseToken) },
      schemaVersion: EXTRACT_SCHEMA_VERSION,
      budget: { timeoutMs: EXTRACT_TIMEOUT_MS },
      // one call (V02-R6): a transient failure is retried by the job after its
      // backoff (I03-R10), not inside the Broker (provisional: the run's request
      // budget, I03-R14, counts requests, and each is up to three Provider attempts)
      retryable: false,
    });
    if (result.status !== "ok") return result;
    const body = stored.body;
    const drops = { quotes: 0, other: 0 };
    // the Broker checked its output against the schema
    const answer = merged([result.output as ExtractionOutput, engineAnswer(proposed, ref, drops)]);

    // items of this answer by its refs; an existing ID must be one of the candidates sent
    const items = new Map<string, Item>();
    const seen = new Set<string>();
    for (const item of answer.items) {
      // the first entry of a ref decides it: a ref whose first entry was dropped stays dropped
      if (seen.has(item.ref)) continue;
      seen.add(item.ref);
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
    /** What an entry on these refs draws on besides this version: the candidates it names. */
    const drawnOn = (refs: string[]): LineageRef[] =>
      refs.flatMap((ref) => {
        const id = items.get(ref)?.existingItemId;
        return id === null || id === undefined ? [] : (candidateLineage.get(id) ?? []);
      });
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
        kind: "fact",
        key: JSON.stringify(["fact", items.get(fact.item)?.name, fact.kind, value]),
        target: { item: fact.item },
        save: (tx, ids) => ({
          factId: saveFact(tx, {
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
        kind: "relation",
        key: JSON.stringify([
          "relation",
          items.get(relation.subject)?.name,
          relation.type,
          items.get(relation.object)?.name,
        ]),
        target: { subject: relation.subject, object: relation.object },
        save: (tx, ids) => ({
          relationId: saveRelation(tx, {
            subjectId: ids(relation.subject),
            type: relation.type,
            objectId: ids(relation.object),
            ...attributes("explicit"),
          }).id,
        }),
      });
    }

    // The items share what they create: an item is made for a fact or relation that
    // is kept, once per ref; the rule below recomputes the items they touched.
    const ids = new Map<string, number>();
    const touched = new Set<number>();
    const own: LineageRef = { sourceId: sourceId as number, version: fenceVersion as number };
    const lineageOf = (extra: LineageRef[]) => [own, ...extra];
    for (const [ref, item] of items) {
      if (item.existingItemId !== null) ids.set(ref, Number(item.existingItemId));
    }
    // an existing item's id came from the candidates (checked above); a deleted one
    // makes the result stale through its lineage before any of this runs
    const written: DerivedItem[] = planned.map((entry) => {
      const refs =
        "item" in entry.target ? [entry.target.item] : [entry.target.subject, entry.target.object];
      return {
        kind: entry.kind,
        itemKey: entry.key,
        lineage: lineageOf(drawnOn(refs)),
        write: (tx) => {
          const idOf = (ref: string): number => {
            const known = ids.get(ref);
            if (known !== undefined) return known;
            const item = items.get(ref) as Item;
            const id = insertItem(tx, {
              type: item.type,
              name: item.name,
              ...attributes("explicit"),
            });
            ids.set(ref, id);
            return id;
          };
          for (const id of refs.map(idOf)) touched.add(id);
          const target = entry.save(tx, (ref) => ids.get(ref) as number);
          addEvidence(tx, {
            target,
            sourceVersionId: versionId,
            ...entry.span,
            quote: entry.quote,
          });
          // the evidence just added is current (the fence held), so a superseded row lives again
          reviveSuperseded(tx, target);
        },
      };
    });
    // the rule runs last, over what the written items touched, and the drop counts
    // are recorded with it (also when nothing was kept)
    const rule: DerivedItem = {
      kind: "insight",
      itemKey: "dependency-delay",
      lineage: lineageOf(written.flatMap((w) => w.lineage.slice(1))),
      write: (tx) => {
        recordExtractionDrops(tx, job.id, drops);
        recomputeDependencyDelay(tx, [...touched]);
      },
    };
    return { status: "succeeded", items: [...written, rule] };
  };
}
