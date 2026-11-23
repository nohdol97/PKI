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
// the same row by the tables' keys (V02-R8); a same row gets evidence only, a row
// propagation superseded is restored by it, and an explicit statement lifts a
// hypothesis row (V02-R11, S01-R5, R11): each through the lifecycle gate, which
// writes the history line, as does each row it creates. Last, the automatic promotion is judged once on the rows of the answer
// and their siblings (S01-R9, auto-verify.ts; the setting is off by default and then nothing is written). The result is handed over as
// items (I04-R11): the job's bookkeeping (drop counts, records of earlier refusals), one
// per kept fact or relation, then the rule "의존 업무 지연". The runner writes them through commitDerived, inside the
// fence transaction, and only when the source version and every source a kept
// entry drew on (a candidate item's evidence, read when the item was offered) are
// still stored and uncovered; otherwise none of it is written.
// Just before the call, an engine with the propose capability is asked for its
// candidates for the same version (V02-R13); they pass the same checks as the
// answer (the extraction schema, the offered candidate IDs, the exact quote) and
// are written with it, as candidates. An engine that fails proposes nothing.
// Schema 3 (S01-R17) adds surface forms (`terms`) and definitions: facts of the kinds `alias.*` and
// `definition`. A form must be in its quote and the quote in the stored text; a definition is a literal span
// of the text (the value is the quote, at most 500 code points) with an optional short context tag; the same
// form is judged by the V02-R7 processing (surface-form.ts). A `confidence` outside 0..1 drops its entry; one
// inside is written when the row is created and never changed (S01-R10).
// Schema 4 (S02-R4, R5) adds the thirteen item types and six relations, identifiers (facts of the kinds
// `identifier.*`: the value must be in its quote; the context tag of an `identifier.key` is written), the
// `statement` kind of a definition entry, validity input fields (read, written by S02-T08) and `proposedTypes`:
// each proposal that passes the checks below is handed over as an `ontology` item that enters the candidate
// entry of the type definitions (S01-R20) with this version as its basis.
// Schema 5 (S03-R7) adds the analytical item types, fact kinds and relations. A value of an analytical type is
// stored in its normalized form; a `metric.unit` or `metric.version` must be verbatim in its quote (at most 40 code
// points), and a value naming columns that are not all in its quote is a hypothesis whatever the answer says. The
// extraction of a table source drops its analytical items and everything pointing at them: the profile owns them.
// Before anything is planned each fact and relation is fitted to the type definitions (S01-R21):
// its item types, fact kind or relation type must be `verified` elements, the value must be of
// the kind the fact kind's rule names, and a relation's ends must fit its direction; what does not
// fit is dropped and counted in `other`. A `one` value count does not stop a write (R9 reads it).
import type { KnowledgeCandidate, KnowledgeEngine, SourceVersionRef } from "@pki/contracts";
import {
  EXTRACT_ALIAS_FACT_KIND,
  EXTRACT_ANALYTICAL_ITEM_TYPES,
  EXTRACT_ANALYTICAL_MAX_TEXT_CODE_POINTS,
  EXTRACT_DEFINITION_FACT_KIND,
  EXTRACT_DEFINITION_MAX_CODE_POINTS,
  EXTRACT_IDENTIFIER_FACT_KINDS,
  EXTRACT_MAX_PROPOSED_TYPES,
  EXTRACT_SCHEMA_VERSION,
  EXTRACT_STATEMENT_FACT_KIND,
  TASKS,
  type BrokerResult,
  type ExtractionOutput,
} from "@pki/providers";
import {
  ANALYTICAL_VALUE_TYPES,
  addEvidence,
  applyOntologyChange,
  findSameForm,
  isElementName,
  normalizeForLinking,
  automatedLifecycle,
  findSourceVersionId,
  insertItem,
  listOntologyElements,
  readItem,
  readSourceVersion,
  BOOKKEEPING_KIND,
  recordExtractionDrops,
  recordWithheldCandidate,
  fillValidity,
  followMovedRow,
  isDate,
  isTabularVersion,
  judgeWaitingOn,
  normalizeColumnName,
  normalizeValue,
  saveFact,
  saveRelation,
  valueFits,
  type DerivativeRegistry,
  type DerivedItem,
  type AnalyticalValueType,
  type ElementRule,
  type EvidenceTarget,
  type KnowledgeAttributes,
  type SourceVersionRef as LineageRef,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { linkPropagationSupersedes, refreshConflicts } from "./conflicts.ts";
import { assessAfterExtraction } from "./auto-verify.ts";
import { derivativeRegistry, RECOMPUTE_PREFIX } from "./canonical-kinds.ts";
import { recomputeInsights } from "./insight-code-rules.ts";
import {
  linkRefused,
  markLinkRefused,
  recordRefusedCandidate,
  refreshCandidates,
} from "./entity-resolution.ts";
import { findCandidates, groupLineage } from "./linking.ts";
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
/** Provisional: the longest context tag of a definition, in code points (S01-R3 says "short"); a longer one is dropped from an otherwise kept definition. */
export const MAX_CONTEXT_CODE_POINTS = 80;
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
  /**
   * The registry that names a candidate item's lineage and judges, with its policy, which sources
   * may be put together; default the entries' own (canonical-kinds.ts).
   */
  registry?: Pick<DerivativeRegistry, "lineage" | "combinable" | "visible">;
  now?: () => Date;
}

type Item = ExtractionOutput["items"][number];

/**
 * The interval an answer states for a row (S02-R17): each stated end must be a real date and, when both are
 * stated, the start must be before the end. Otherwise the row is kept with no interval and counted.
 */
function validityOf(from: string | null | undefined, until: string | null | undefined) {
  const stated = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
  const start = stated(from);
  const end = stated(until);
  const real = (v: string | null) => v === null || isDate(v);
  const ordered = start === null || end === null || start < end;
  return real(start) && real(end) && ordered
    ? { from: start, until: end, dropped: false }
    : { from: null, until: null, dropped: true };
}
interface Planned {
  /** `fact` or `relation`: the registered kind of the row it writes. */
  kind: "fact" | "relation";
  /** The same-row key's content, for the item's record (hashed before it is kept, I04-R7). */
  key: string;
  target: { item: string } | { subject: string; object: string };
  save: (
    tx: SqlDriver,
    ids: (ref: string) => number,
  ) => { target: EvidenceTarget; created: boolean };
  /** The answer states it as explicit (S01-R11): a hypothesis row with this evidence becomes explicit. */
  explicit: boolean;
  /** The valid interval the answer states (S02-R17); `dropped` when it was not accepted and the row is kept without one. */
  validity?: { from: string | null; until: string | null; dropped: boolean };
  span: QuoteSpan;
  quote: string;
}

/** The analytical facts whose value is a span of the document, not a normalized one (S03-R7). */
const QUOTED_TEXT_FACT_KINDS: readonly string[] = ["metric.unit", "metric.version"];

/** The column names a stored analytical value holds, in the processed form; none for a value naming no column. */
function columnNames(valueType: AnalyticalValueType, stored: string): string[] {
  switch (valueType) {
    case "column":
      return [stored];
    case "column-set":
      return JSON.parse(stored) as string[];
    case "calculation": {
      const { column } = JSON.parse(stored) as { column?: string };
      return column === undefined ? [] : [column];
    }
    case "key-pairs":
      return (JSON.parse(stored) as string[][]).flat();
    default:
      return [];
  }
}

/** The context tag of an entry: trimmed, null when empty. */
const tagOf = (raw: string | null | undefined): string | null => raw?.trim() || null;

/** S01-R10: the model's number is 0..1 or absent; an entry with a number outside is dropped. */
const confidenceInRange = (c: number | null | undefined): boolean =>
  c === undefined || c === null || (c >= 0 && c <= 1);

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

/** The `verified` type definitions, read when an answer is planned: the only ones a write may use. */
function verifiedRules(db: SqlDriver) {
  const rules = new Map<string, ElementRule>();
  for (const e of listOntologyElements(db)) {
    if (e.status === "verified") rules.set(`${e.elementKind}:${e.name}`, e.rule);
  }
  return {
    itemType: (type: string | undefined) => type !== undefined && rules.has(`item-type:${type}`),
    factKind: (name: string) => {
      const rule = rules.get(`fact-kind:${name}`);
      return rule?.elementKind === "fact-kind" ? rule : undefined;
    },
    relationType: (name: string) => {
      const rule = rules.get(`relation-type:${name}`);
      return rule?.elementKind === "relation-type" ? rule : undefined;
    },
  };
}

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
  const out: ExtractionOutput = { items: [], facts: [], relations: [], terms: [], definitions: [] };
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
            terms: [],
            definitions: [],
          }
        : c.kind === "relation"
          ? {
              facts: [],
              terms: [],
              definitions: [],
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

/** An answer with its type proposals present (an answer without any has none). */
type MergedAnswer = Omit<ExtractionOutput, "proposedTypes"> & {
  proposedTypes: NonNullable<ExtractionOutput["proposedTypes"]>;
};

/** The answers in one, each answer's refs kept to itself. */
function merged(answers: readonly ExtractionOutput[]): MergedAnswer {
  const out: MergedAnswer = {
    items: [],
    facts: [],
    relations: [],
    terms: [],
    definitions: [],
    proposedTypes: [],
  };
  answers.forEach((answer, i) => {
    const ns = (ref: string) => `${i}:${ref}`;
    out.items.push(...answer.items.map((item) => ({ ...item, ref: ns(item.ref) })));
    out.facts.push(...answer.facts.map((fact) => ({ ...fact, item: ns(fact.item) })));
    out.relations.push(
      ...answer.relations.map((r) => ({ ...r, subject: ns(r.subject), object: ns(r.object) })),
    );
    out.terms.push(...answer.terms.map((t) => ({ ...t, item: ns(t.item) })));
    out.definitions.push(...answer.definitions.map((d) => ({ ...d, item: ns(d.item) })));
    out.proposedTypes.push(...(answer.proposedTypes ?? []));
  });
  return out;
}

/** The run's Broker: the job context's wrapped one counts and cancels (I03-R14). */
export interface RunBroker {
  call(raw: unknown): Promise<BrokerResult>;
}

export function createExtractHandler(options: ExtractHandlerOptions) {
  const { db } = options;
  const registry = options.registry ?? derivativeRegistry;
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
    const own: LineageRef = { sourceId: sourceId as number, version: fenceVersion as number };
    // A re-extraction queued by a scope change whose records are gone already (another one cleared
    // them) has nothing to judge again: it ends without a Provider call (I04-R15).
    if (
      job.target.startsWith(RECOMPUTE_PREFIX) &&
      db.all("SELECT 1 FROM scope_policy_drops WHERE source_id = ? LIMIT 1", [own.sourceId])
        .length === 0
    ) {
      return { status: "succeeded", items: [] };
    }
    // What each candidate item came from, read now, when it is offered: a source it
    // draws on that is gone when the result is written makes the result stale
    // (I04-R11). Read after the call, a deleted item's lineage would be empty. An item
    // whose sources the policy will not let be put together with this version is not
    // offered at all (I04-R14): its name would leave the machine in a call that mixes them.
    // The check is cumulative, in id order: a candidate is offered only if its sources may be put
    // together with this version and with every candidate already offered, so one request never
    // carries a combination the policy refuses. The ones left out are counted as dropped.
    const drops = { quotes: 0, other: 0, validity: 0 };
    const candidateLineage = new Map<string, LineageRef[]>();
    /** The stored type of each candidate item, read with its lineage: a candidate deleted during the call still has one. */
    const candidateType = new Map<string, string>();
    const together: LineageRef[] = [own];
    const withheld: string[] = [];
    for (const found of findCandidates(db, `${stored.title}\n${stored.body}`, registry)) {
      const id = String(found);
      const lineage = groupLineage(db, registry, found);
      if (registry.combinable(db, [...together, ...lineage])) {
        candidateLineage.set(id, lineage);
        candidateType.set(id, (readItem(db, found) as { type: string }).type);
        together.push(...lineage);
      } else {
        drops.other++;
        withheld.push(id);
      }
    }
    const candidates = [...candidateLineage.keys()];
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
    // the Broker checked its output against the schema
    const answer = merged([result.output as ExtractionOutput, engineAnswer(proposed, ref, drops)]);

    // items of this answer by its refs; an existing ID must be one of the candidates sent
    const items = new Map<string, Item>();
    const seen = new Set<string>();
    // S03-R7: a table source's own extraction writes no analytical item (the profile does); what points at a
    // dropped item has no item to point at and is dropped below by the checks every entry passes
    const tabular = isTabularVersion(db, own.sourceId, own.version);
    for (const item of answer.items) {
      // the first entry of a ref decides it: a ref whose first entry was dropped stays dropped
      if (seen.has(item.ref)) continue;
      seen.add(item.ref);
      if (item.existingItemId !== null && !candidates.includes(item.existingItemId)) {
        drops.other++;
        continue;
      }
      const type =
        item.existingItemId === null ? item.type : candidateType.get(item.existingItemId);
      if (
        tabular &&
        (EXTRACT_ANALYTICAL_ITEM_TYPES as readonly string[]).includes(type as string)
      ) {
        drops.other++;
        continue;
      }
      items.set(item.ref, item);
    }

    // S02-R8 2: a link to an existing item X is checked before anything is written. When the key the answer
    // gives it under a tag is none of the keys X's group holds under that tag, the link is refused: the item is
    // made new (the answer's type and name), and a mark between it and X is written below. The type half of R8
    // is not checked (spec decision 29). Only keys the write path below keeps count: quote located, confidence in range.
    const refused: { ref: string; existing: number }[] = [];
    for (const [ref, item] of items) {
      if (item.existingItemId === null) continue;
      const keys = answer.facts
        .filter(
          (f) =>
            f.item === ref &&
            f.kind === "identifier.key" &&
            f.quote.includes(f.value.trim()) &&
            confidenceInRange(f.confidence) &&
            !("dropped" in locateQuote(body, f.quote)), // only a key the write path will keep
        )
        .map((f) => {
          const tag = tagOf(f.context);
          return {
            tag: tag !== null && [...tag].length > MAX_CONTEXT_CODE_POINTS ? null : tag,
            value: f.value.trim(),
          };
        });
      if (!linkRefused(db, Number(item.existingItemId), keys)) continue;
      // a refused link makes the item new with the answer's own type: a table source writes no analytical one
      if (tabular && (EXTRACT_ANALYTICAL_ITEM_TYPES as readonly string[]).includes(item.type)) {
        items.delete(ref);
        drops.other++;
        continue;
      }
      refused.push({ ref, existing: Number(item.existingItemId) });
      items.set(ref, { ...item, existingItemId: null });
    }

    // S01-R21: what does not fit the verified type definitions is dropped. An existing item has the type
    // it is stored with; a new one the type of the answer.
    const rules = verifiedRules(db);
    const typeOf = (ref: string): string | undefined => {
      const item = items.get(ref);
      if (!item) return undefined;
      return item.existingItemId === null ? item.type : candidateType.get(item.existingItemId);
    };
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
    const attributes = (
      epistemic: KnowledgeAttributes["epistemic"],
      confidence: number | null | undefined,
    ): KnowledgeAttributes => ({
      epistemic,
      status: "candidate",
      validAt: null,
      observedAt: now().toISOString(),
      confidence: confidence ?? null,
    });
    for (const fact of answer.facts) {
      const value = fact.value.trim();
      const validity = validityOf(fact.validFrom, fact.validUntil);
      const rule = rules.factKind(fact.kind);
      const type = typeOf(fact.item);
      if (
        !confidenceInRange(fact.confidence) ||
        !rule ||
        !rules.itemType(type) ||
        !rule.itemTypes.includes(type as string) ||
        !valueFits(rule.valueType, value)
      ) {
        drops.other++;
        continue;
      }
      // S03-R7: an analytical value is stored normalized; a unit or version is a span of the quote; a value
      // naming columns is the answer's explicit only when the quote holds every column name
      let stored = value;
      let epistemic = fact.epistemic;
      if (QUOTED_TEXT_FACT_KINDS.includes(fact.kind)) {
        if (!fact.quote.includes(value)) {
          drops.quotes++;
          continue;
        }
        if ([...value].length > EXTRACT_ANALYTICAL_MAX_TEXT_CODE_POINTS) {
          drops.other++;
          continue;
        }
      } else if ((ANALYTICAL_VALUE_TYPES as readonly string[]).includes(rule.valueType)) {
        const valueType = rule.valueType as AnalyticalValueType;
        stored = normalizeValue(valueType, value) as string; // valueFits said it is one
        const quoted = normalizeColumnName(fact.quote);
        if (!columnNames(valueType, stored).every((name) => quoted.includes(name))) {
          epistemic = "hypothesis";
        }
      }
      // S02-R4: an identifier is written as the document writes it, so the quote must hold it; the context
      // tag of an `identifier.key` is the system its number belongs to (S01-R3's `context` column)
      let tag: string | null = null;
      if ((EXTRACT_IDENTIFIER_FACT_KINDS as readonly string[]).includes(fact.kind)) {
        if (!fact.quote.includes(value)) {
          drops.quotes++;
          continue;
        }
        if (fact.kind === "identifier.key") tag = tagOf(fact.context);
        if (tag !== null && [...tag].length > MAX_CONTEXT_CODE_POINTS) {
          drops.other++;
          tag = null;
        }
      }
      plan([fact.item], fact.quote, {
        kind: "fact",
        key: JSON.stringify(["fact", items.get(fact.item)?.name, fact.kind, stored]),
        target: { item: fact.item },
        explicit: epistemic === "explicit",
        validity,
        save: (tx, ids) => {
          const saved = saveFact(tx, {
            itemId: ids(fact.item),
            kind: fact.kind,
            value: stored,
            context: tag,
            ...attributes(epistemic, fact.confidence),
            validAt: validity.from,
            validUntil: validity.until,
          });
          return { target: { factId: saved.id }, created: saved.created };
        },
      });
    }
    for (const relation of answer.relations) {
      const validity = validityOf(relation.validFrom, relation.validUntil);
      const rule = rules.relationType(relation.type);
      const subject = typeOf(relation.subject);
      const object = typeOf(relation.object);
      if (
        !confidenceInRange(relation.confidence) ||
        !rule ||
        !rules.itemType(subject) ||
        !rules.itemType(object) ||
        !rule.subjectTypes.includes(subject as string) ||
        !rule.objectTypes.includes(object as string)
      ) {
        drops.other++;
        continue;
      }
      plan([relation.subject, relation.object], relation.quote, {
        kind: "relation",
        key: JSON.stringify([
          "relation",
          items.get(relation.subject)?.name,
          relation.type,
          items.get(relation.object)?.name,
        ]),
        target: { subject: relation.subject, object: relation.object },
        explicit: true,
        validity,
        save: (tx, ids) => {
          const saved = saveRelation(tx, {
            subjectId: ids(relation.subject),
            type: relation.type,
            objectId: ids(relation.object),
            ...attributes("explicit", relation.confidence),
            validAt: validity.from,
            validUntil: validity.until,
          });
          return { target: { relationId: saved.id }, created: saved.created };
        },
      });
    }
    // S01-R2: a surface form is a fact of the kind `alias.<kind>` of its item; it must be in its quote.
    for (const term of answer.terms) {
      const form = term.form.trim();
      const kind = EXTRACT_ALIAS_FACT_KIND[term.kind];
      const rule = rules.factKind(kind);
      const type = typeOf(term.item);
      if (
        !confidenceInRange(term.confidence) ||
        !rule ||
        !rules.itemType(type) ||
        !rule.itemTypes.includes(type as string) ||
        !valueFits(rule.valueType, form)
      ) {
        drops.other++;
        continue;
      }
      if (!term.quote.includes(form)) {
        drops.quotes++;
        continue;
      }
      plan([term.item], term.quote, {
        kind: "fact",
        key: JSON.stringify(["fact", items.get(term.item)?.name, kind, normalizeForLinking(form)]),
        target: { item: term.item },
        explicit: true,
        save: (tx, ids) => {
          const itemId = ids(term.item);
          // the same form (V02-R7 processing) of this item and kind is the same row: evidence only
          const same = findSameForm(tx, itemId, kind, form);
          if (same !== undefined) return { target: { factId: same }, created: false };
          const saved = saveFact(tx, {
            itemId,
            kind,
            value: form,
            ...attributes("explicit", term.confidence),
          });
          return { target: { factId: saved.id }, created: saved.created };
        },
      });
    }
    // S01-R3, provisional decision 10: a definition is a literal span of the text, the value is the quote
    // (trimmed, still a span), at most 500 code points; the tag, when given, is short.
    for (const def of answer.definitions) {
      const value = def.quote.trim();
      let tag = tagOf(def.context);
      // S02-R4: the same entry, the same rules; the kind only names the fact kind it is stored as
      const defKind =
        def.kind === EXTRACT_STATEMENT_FACT_KIND
          ? EXTRACT_STATEMENT_FACT_KIND
          : EXTRACT_DEFINITION_FACT_KIND;
      const rule = rules.factKind(defKind);
      const type = typeOf(def.item);
      if (
        !confidenceInRange(def.confidence) ||
        !rule ||
        !rules.itemType(type) ||
        !rule.itemTypes.includes(type as string) ||
        !valueFits(rule.valueType, value) ||
        [...value].length > EXTRACT_DEFINITION_MAX_CODE_POINTS
      ) {
        drops.other++;
        continue;
      }
      // a literal definition is kept without a tag that is too long; the tag is counted as dropped
      if (tag !== null && [...tag].length > MAX_CONTEXT_CODE_POINTS) {
        drops.other++;
        tag = null;
      }
      plan([def.item], value, {
        kind: "fact",
        key: JSON.stringify(["fact", items.get(def.item)?.name, defKind, value]),
        target: { item: def.item },
        explicit: def.epistemic === "explicit",
        save: (tx, ids) => {
          const saved = saveFact(tx, {
            itemId: ids(def.item),
            kind: defKind,
            value,
            context: tag,
            ...attributes(def.epistemic, def.confidence),
          });
          return { target: { factId: saved.id }, created: saved.created };
        },
      });
    }

    // S02-R5: a type the answer proposes goes to the candidate entry of the type definitions (S01-R20) with
    // this version as its basis; the entry records it as a `candidate` of origin `source-proposed`, and a
    // name that is already a definition (any status) is absorbed there as a duplicate. The code checks first:
    // at most five entries are looked at, the quote is in the body (it is used for this check only and not
    // stored), the name has the shape of a type name, and a relation type's ends are `verified` item types.
    const proposalItems: DerivedItem[] = [];
    const proposedKeys = new Set<string>();
    answer.proposedTypes.forEach((proposal, index) => {
      const ends = (list: readonly string[] | null | undefined) =>
        list !== undefined && list !== null && list.length > 0 && list.every(rules.itemType)
          ? [...list]
          : undefined;
      const subjectTypes = ends(proposal.subjectTypes);
      const objectTypes = ends(proposal.objectTypes);
      if (index >= EXTRACT_MAX_PROPOSED_TYPES) return void drops.other++;
      if (!proposal.quote.trim() || !body.includes(proposal.quote)) return void drops.quotes++;
      if (
        !isElementName(proposal.name) ||
        (proposal.kind === "relation-type" && (!subjectTypes || !objectTypes))
      ) {
        return void drops.other++;
      }
      const key = JSON.stringify(["ontology", proposal.kind, proposal.name]);
      if (proposedKeys.has(key)) return;
      proposedKeys.add(key);
      proposalItems.push({
        kind: "ontology",
        itemKey: key,
        lineage: [own],
        write: (tx) => {
          applyOntologyChange(
            tx,
            {
              op: "add",
              name: proposal.name,
              rule:
                proposal.kind === "item-type"
                  ? { elementKind: "item-type" }
                  : {
                      elementKind: "relation-type",
                      subjectTypes: subjectTypes as string[],
                      objectTypes: objectTypes as string[],
                      symmetric: false,
                    },
            },
            "extraction",
            { sourceId: own.sourceId, version: own.version },
            now().toISOString(),
          );
        },
      });
    });

    // The items share what they create: an item is made for a fact or relation that
    // is kept, once per ref; the rule below recomputes the items they touched.
    // This state lives for one commit: closeJob calls each item's write once inside its
    // transaction, and a failed commit is never re-run with these items (a locked file
    // runs the handler again for a fresh closure, a throwing write closes the job).
    // a kept row whose stated interval was not accepted is counted (S02-R17)
    drops.validity = planned.filter((p) => p.validity?.dropped).length;
    const ids = new Map<string, number>();
    const touched = new Set<number>();
    const judgedFacts = new Set<number>();
    const judgedRelations = new Set<number>();
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
          const at = now().toISOString();
          const idOf = (ref: string): number => {
            const known = ids.get(ref);
            if (known !== undefined) return known;
            const item = items.get(ref) as Item;
            const id = insertItem(tx, {
              type: item.type,
              name: item.name,
              ...attributes("explicit", null),
            });
            automatedLifecycle.created(tx, { kind: "item", id }, "extraction", own, at);
            ids.set(ref, id);
            return id;
          };
          for (const id of refs.map(idOf)) touched.add(id);
          // a row the user split away from this item is not made again by this source's re-extraction (S02-R15)
          const { target, created } = followMovedRow(
            tx,
            entry.save(tx, (ref) => ids.get(ref) as number),
            own.sourceId,
          );
          const row =
            "factId" in target
              ? ({ kind: "fact", id: target.factId } as const)
              : ({ kind: "relation", id: target.relationId } as const);
          if (created) automatedLifecycle.created(tx, row, "extraction", own, at);
          // a stored row's interval is filled only while both ends are empty and the user never set it (S02-R17)
          else if (entry.validity) fillValidity(tx, row, entry.validity.from, entry.validity.until);
          addEvidence(tx, {
            target,
            sourceVersionId: versionId,
            ...entry.span,
            quote: entry.quote,
          });
          // the evidence just added is current (the fence held): a row propagation superseded is
          // restored (V02-R11, S01-R5), and a hypothesis row the answer states as explicit rises (R11)
          automatedLifecycle.evidenceReturned(tx, row, own, at);
          if (entry.explicit) automatedLifecycle.explicitEvidence(tx, row, own, at);
          // judged once, after every row of the answer is written (the rule item below)
          (row.kind === "fact" ? judgedFacts : judgedRelations).add(row.id);
        },
      };
    });
    // The job's own bookkeeping comes first and rests on this version alone, so a policy that
    // refuses a mix of sources cannot take it with the item it refuses: the drop counts are
    // recorded (also when nothing was kept) and the records of what the policy once left out of
    // this source, which this extraction judges again, are cleared before it records its own
    // (I04-R15; the records of a version before this one are out of date as well).
    const bookkeeping: DerivedItem = {
      kind: BOOKKEEPING_KIND,
      itemKey: "bookkeeping",
      lineage: [own],
      // no source content: a policy that errs must not lose the counts or skip the clean-up
      unjudged: true as const,
      write: (tx) => {
        recordExtractionDrops(tx, job.id, drops);
        tx.run("DELETE FROM scope_policy_drops WHERE source_id = ? AND version <= ?", [
          own.sourceId,
          own.version,
        ]);
        // a candidate the policy kept from this call is a record too: a widening extracts this version again
        for (const id of withheld) recordWithheldCandidate(tx, own, id, now().toISOString());
      },
    };
    // the rule runs last, over what the written items touched; it too judges each Insight's
    // evidence under the policy, so an Insight that mixes sources the policy will not mix is
    // not made even when the item as a whole was allowed through
    const rule: DerivedItem = {
      kind: "insight",
      itemKey: "dependency-delay",
      lineage: lineageOf(written.flatMap((w) => w.lineage.slice(1))),
      write: (tx) => {
        recomputeInsights(tx, [...touched], {
          scope: { combinable: (lineage) => registry.combinable(tx, lineage) },
          at: now().toISOString(),
        });
      },
    };
    // S02-R16: the mark of each refused link, between X and the item made instead, content-free like the
    // judgement below (the policy cannot skip it); an item no entry kept has nothing to mark.
    const linkMarks: DerivedItem = {
      kind: BOOKKEEPING_KIND,
      itemKey: "link-check",
      lineage: [own],
      unjudged: true as const,
      write: (tx) => {
        for (const { ref, existing } of refused) {
          const made = ids.get(ref);
          if (made !== undefined) markLinkRefused(tx, existing, made);
        }
      },
    };
    // S02-R10: the candidates of the groups this answer touched, judged over the final state; a pair the policy
    // will not put together leaves a content-free record bound to this version (a widening extracts it again).
    const candidatesItem: DerivedItem = {
      kind: BOOKKEEPING_KIND,
      itemKey: "merge-candidates",
      lineage: [own],
      unjudged: true as const,
      write: (tx) => {
        if (touched.size === 0) return;
        refreshCandidates(
          tx,
          [...touched],
          { combinable: (lineage) => registry.combinable(tx, lineage) },
          {
            onRefused: (a, b) => recordRefusedCandidate(tx, own, a, b, now().toISOString()),
          },
        );
      },
    };
    // S01-R9: the automatic promotion, judged once on the final state of this answer's rows. Its own
    // content-free item (status lines only, like the bookkeeping): a scope policy that refuses the
    // Insight rule's combined lineage must not skip it, or a rival written in this run would leave a
    // promoted sibling verified.
    // S02-R19: the links of the slots this answer touched, judged after every row is written and before the
    // promotion reads them (its condition 5 asks which values are superseded). Content-free like the judgement.
    const conflictsItem: DerivedItem = {
      kind: BOOKKEEPING_KIND,
      itemKey: "conflicts",
      lineage: [own],
      unjudged: true as const,
      write: (tx) => {
        const scope = { combinable: (lineage: LineageRef[]) => registry.combinable(tx, lineage) };
        const at = now().toISOString();
        linkPropagationSupersedes(tx, [...judgedFacts], own, scope, at);
        refreshConflicts(tx, [...touched], scope, { at });
      },
    };
    const judgement: DerivedItem = {
      kind: BOOKKEEPING_KIND,
      itemKey: "auto-verify",
      lineage: [own],
      unjudged: true as const,
      write: (tx) => {
        const at = now().toISOString();
        // S03-R16 ③: what still waits on this source after its extraction is not stated again
        judgeWaitingOn(tx, own.sourceId, at);
        assessAfterExtraction(
          tx,
          { factIds: [...judgedFacts], relationIds: [...judgedRelations] },
          at,
        );
      },
    };
    return {
      status: "succeeded",
      items: [
        bookkeeping,
        ...written,
        conflictsItem,
        judgement,
        rule,
        linkMarks,
        candidatesItem,
        ...proposalItems,
      ],
    };
  };
}
