// One Ask request (X01-R8~R15): retrieve, judge, call the Broker once, confirm, and say it as events.
//   1. `retrieve` ranks source versions (the strategies, the merge, the marks and links).
//   2. R12: the merged ranking passes the registry's `visible` for a search in one call before anything leaves;
//      what falls out leaves no trace (not in a count, a rank, a mark or a link). A registry that cannot judge
//      throws before the first event, so the route answers an error and nothing was shown unjudged.
//   3. R13: the answer's documents are chosen again just before the Broker is asked: judged for an answer,
//      at most ASK_CONTEXT_LIMIT of them, within one call's size, each added only if the policy lets it be put
//      with those already taken. No document left means no Provider call.
//   4. R8: one Broker call of kind `answer` as the user's own action, IDs and the one-shot question token only.
//   5. R9, R14: a sentence is sent only when its quote is found exactly once in the document it names, and
//      that document is judged for an answer once more after the Provider answered.
// Nothing here writes to the store; the log names a count and a state, never text or an id (R15).
import type { AskEvent, AskRequest } from "@pki/contracts";
import {
  feedbackPreference,
  locateQuote,
  MAX_EXTRACT_CODE_POINTS,
  retrieve,
  type StrategyName,
  type VectorDeps,
} from "@pki/knowledge-engine";
import {
  ANSWER_MAX_SENTENCES,
  ANSWER_SCHEMA_VERSION,
  errorClass,
  log,
  type AnswerOutput,
  type Broker,
  type UserActionIssuer,
} from "@pki/providers";
import type { DerivativeRegistry, SqlDriver } from "@pki/storage";
import type { EmbeddingProvider } from "@pki/contracts";
import { queryEmbedding } from "./ask-embedding.ts";
import { createAskReads } from "./ask-read.ts";
import { askQuestions } from "./ask-questions.ts";

/** X01-R13, D9 (provisional): the most documents one answer is made from. */
export const ASK_CONTEXT_LIMIT = 5;
/** Provisional: below the Broker's own ceiling, as the connection test's is. */
const ASK_TIMEOUT_MS = 60_000;

export interface AskDeps {
  db: SqlDriver;
  registry: DerivativeRegistry;
  /** Without the Broker and the issuer (composition.ts productCalls) an answer is `blocked`, `broker-not-bound`. */
  broker?: Pick<Broker, "call"> | undefined;
  issuer?: UserActionIssuer | undefined;
  /** The embedding provider and the vector index as the server holds them; none reports `vector` unavailable. */
  vector?:
    | (Omit<VectorDeps, "embedding"> & {
        embedding: Pick<EmbeddingProvider, "status" | "embed" | "describe">;
      })
    | undefined;
  /** X01-R5: not the request's to set; a test or the evaluation runner passes another list. */
  enabled?: readonly StrategyName[] | undefined;
}

type Taken = { versionId: number; sourceId: number; version: number; body: string };

export async function* ask(
  deps: AskDeps,
  request: AskRequest,
  signal?: AbortSignal,
): AsyncGenerator<AskEvent> {
  const { db, registry } = deps;
  const reads = createAskReads(db, registry);
  const found = await retrieve(
    db,
    registry,
    request.question,
    { connectorIds: request.connectorIds, from: request.from, to: request.to },
    {
      enabled: deps.enabled,
      vector: deps.vector && {
        ...deps.vector,
        embedding: queryEmbedding(deps.vector.embedding),
      },
      signal,
      preference: feedbackPreference(db, registry),
    },
  );
  if (signal?.aborted) return;

  // R12: one `visible` call over the merged ranking; the ranks are renumbered over what is left
  const searchable = reads.shown(
    found.hits.map((h) => h.versionId),
    "search",
  );
  const hits = found.hits.filter((h) => searchable.has(h.versionId));
  const notes =
    hits.length === 0
      ? [{ kind: "insufficient" } as const]
      : found.notes.flatMap((n) =>
          n.kind !== "insufficient" && searchable.has(n.versionId) ? [n] : [],
        );
  const titles = new Map(hits.map((h) => [h.versionId, reads.version(h.versionId)?.title ?? ""]));

  yield {
    type: "route",
    route: Object.fromEntries(
      Object.entries(found.route).map(([strategy, entry]) => [
        strategy,
        entry.status === "unavailable"
          ? { status: entry.status, reason: entry.reason }
          : { status: entry.status },
      ]),
    ),
  };
  yield {
    type: "hits",
    hits: hits.map((h, i) => ({
      versionId: h.versionId,
      sourceId: h.sourceId,
      version: h.version,
      rank: i + 1,
      title: titles.get(h.versionId) ?? "",
      strategies: [...h.strategies],
      related: h.related.map((r) => ({ ...r })),
    })),
    notes: [...notes],
  };

  let outcome = "not-requested";
  let sent = 0;
  let dropped = 0;
  try {
    if (!request.answer) {
      yield { type: "answer", status: "none", reason: "not-requested" };
      yield { type: "done", sentences: 0, dropped: 0, insufficient: false };
      return;
    }

    // R13: the documents of the answer, chosen again
    const answerable = reads.shown(
      hits.map((h) => h.versionId),
      "answer",
    );
    const taken: Taken[] = [];
    let size = 0;
    for (const hit of hits) {
      if (taken.length >= ASK_CONTEXT_LIMIT) break;
      if (!answerable.has(hit.versionId)) continue;
      const stored = reads.version(hit.versionId);
      if (!stored) continue;
      const weight = [...stored.title].length + [...stored.body].length;
      if (size + weight > MAX_EXTRACT_CODE_POINTS) continue;
      if (!reads.combinable([...taken, hit])) continue;
      taken.push({ ...hit, body: stored.body });
      size += weight;
    }
    if (taken.length === 0) {
      outcome = "insufficient";
      yield { type: "answer", status: "none", reason: "insufficient" };
      yield { type: "done", sentences: 0, dropped: 0, insufficient: true };
      return;
    }
    const { broker, issuer } = deps;
    if (!broker || !issuer) {
      outcome = "blocked";
      yield { type: "answer", status: "blocked", reason: "broker-not-bound" };
      yield { type: "done", sentences: 0, dropped: 0, insufficient: false };
      return;
    }

    // R8: the one call, as the user's action; IDs and the question's token only
    const result = await askQuestions.hold(request.question, (token) =>
      issuer.during(
        (userActionId) =>
          broker.call(
            {
              taskKind: "answer",
              sourceVersionIds: taken.map((t) => String(t.versionId)),
              candidateItemIds: [token],
              origin: { userActionId },
              schemaVersion: ANSWER_SCHEMA_VERSION,
              budget: { timeoutMs: ASK_TIMEOUT_MS },
              retryable: false,
            },
            signal,
          ),
        { acknowledgeUnverified: request.acknowledgeUnverified === true },
      ),
    );
    // a closed connection is the cancel: nothing is written after it
    if (signal?.aborted) {
      outcome = "cancelled";
      return;
    }
    if (result.status !== "ok") {
      const [status, reason] =
        result.status === "blocked"
          ? (["blocked", result.reason] as const)
          : result.status === "rejected"
            ? (["failed", result.reason] as const)
            : result.status === "failed"
              ? (["failed", result.error] as const)
              : (["cancelled", null] as const);
      outcome = status;
      yield { type: "answer", status, reason };
      yield { type: "done", sentences: 0, dropped: 0, insufficient: false };
      return;
    }

    // R9: only a sentence whose quote is found exactly once in the document it names
    const output = result.output as AnswerOutput;
    const byId = new Map(taken.map((t) => [String(t.versionId), t]));
    const confirmed = output.sentences.flatMap((s) => {
      const doc = byId.get(s.documentId);
      const span = doc && locateQuote(doc.body, s.quote);
      if (!doc || !span || "dropped" in span) {
        dropped++;
        return [];
      }
      return [{ text: s.text, doc, quote: s.quote, start: span.start, end: span.end }];
    });
    // R14: a document deleted or hidden while the Provider worked is judged out of the answer now
    const stillAnswerable = reads.shown(
      [...new Set(confirmed.map((c) => c.doc.versionId))],
      "answer",
    );
    const kept = confirmed
      .filter((c) => stillAnswerable.has(c.doc.versionId))
      .slice(0, ANSWER_MAX_SENTENCES);

    outcome = "started";
    yield { type: "answer", status: "started", reason: null };
    for (const c of kept) {
      if (signal?.aborted) {
        outcome = "cancelled";
        return;
      }
      sent++;
      yield {
        type: "sentence",
        text: c.text,
        citation: {
          versionId: c.doc.versionId,
          sourceId: c.doc.sourceId,
          version: c.doc.version,
          start: c.start,
          end: c.end,
          quote: c.quote,
        },
      };
    }
    if (signal?.aborted) {
      outcome = "cancelled";
      return;
    }
    yield {
      type: "done",
      sentences: sent,
      dropped,
      insufficient: sent === 0 || output.insufficient,
    };
  } catch (error) {
    if (signal?.aborted) {
      outcome = "cancelled";
      return;
    }
    // after the hits went out: say so, with the error's class only (R15)
    log("ask-failed", { error: errorClass(error) });
    outcome = "failed";
    yield { type: "answer", status: "failed", reason: "internal-error" };
    yield { type: "done", sentences: sent, dropped, insufficient: false };
  } finally {
    log("ask", { hits: hits.length, answer: outcome, sentences: sent, dropped });
  }
}
