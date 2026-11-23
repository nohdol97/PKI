// X01-C4a (R12, R14, R15, negative test) and C4b (R8, R13, R15, R16, least context) through the product's
// Broker composition: a question runs `retrieve`, passes the registry's `visible` for a search before any hit
// leaves, is re-judged for an answer and for what may be put together before the one Broker call, and the
// sentences come back through the quote check. Documents the policy hides, or a tombstone covers, are not in
// the events, the Provider's request, the call history or the log; nothing is stored but a provider_calls row.
// The data is synthetic. Mutation checks of this file (R12 check removed, R13 step 1 removed) are in the PR.
import { createProductRegistry } from "@pki/knowledge-engine";
import { DEFAULT_PROVIDER_SETTING, type EgressControls } from "@pki/providers";
import {
  addEvidence,
  insertItem,
  migrate,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  writeSetting,
  type KnowledgeAttributes,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, memoryDbTemplate, seedLegacyTombstone } from "@pki/testkit";
import type { AskEvent, StructuredRequest } from "@pki/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "./ask.ts";
import { askQuestions, withAskQuestions } from "./ask-questions.ts";
import { productCalls, productEgress } from "./composition.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);
const QUERY = "카나리질의";
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "verified",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

/** Refuses a scope naming "denied" for every purpose, one naming "noanswer" for an answer only, and puts groupA and groupB together never. */
const policy: ScopePolicy = {
  compare: () => "equal",
  strictest: (scopes) => scopes[0] ?? null,
  combinable: (scopes) =>
    !(scopes.some((s) => s?.includes("groupA")) && scopes.some((s) => s?.includes("groupB"))),
  allows: (scopes, purpose) =>
    !scopes.some((s) => s?.includes("denied")) &&
    !(purpose === "answer" && scopes.some((s) => s?.includes("noanswer"))),
};

let db: SqlDriver;
let logged: string[];
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
  logged = [];
  spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  spy.mockRestore();
  db.close();
});

function consent(egress: EgressControls) {
  const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
  const granted = egress.grant("local-model", ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

/** The product's Broker composition over `db` with a Provider that cites every document it is given whole. */
function backend(answer?: (request: StructuredRequest) => unknown) {
  const registry = createProductRegistry({ policy });
  const egress = productEgress(db);
  writeSetting(db, DEFAULT_PROVIDER_SETTING, "local-model");
  consent(egress);
  const provider = new FakeProvider({
    id: "local-model",
    transport: "http",
    answer:
      answer ??
      ((request) => ({
        sentences: request.input.untrustedDocuments.map((d) => ({
          text: "답 문장",
          documentId: d.id,
          quote: d.body,
        })),
        insufficient: false,
      })),
  });
  const calls = productCalls(db, egress, { providers: [provider], registry });
  return {
    provider,
    deps: { db, registry, broker: calls.broker, issuer: calls.issuer },
  };
}

let seq = 0;
/** A stored document holding the query word and `mark`; returns its version row id and source id. */
function source(mark: string, scope: string[], extra = "") {
  const externalId = `ext-${++seq}`;
  saveSourceRecord(db, "c1", {
    externalId,
    title: `제목-${mark}`,
    body: `${QUERY} ${mark} ${extra}`.trim(),
    accessScope: scope,
  });
  const row = db.all(
    "SELECT v.id AS id, v.source_id AS sourceId FROM source_versions v ORDER BY v.id DESC LIMIT 1",
  )[0] as { id: number; sourceId: number };
  return { id: row.id, sourceId: row.sourceId, mark };
}

async function run(deps: ReturnType<typeof backend>["deps"], question = QUERY) {
  const events: AskEvent[] = [];
  for await (const event of ask(deps, { question, answer: true }, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}
const hitIds = (events: AskEvent[]) =>
  events.flatMap((e) => (e.type === "hits" ? e.hits.map((h) => h.versionId) : []));
const documentIds = (provider: FakeProvider) =>
  provider.requests.flatMap((r) => r.input.untrustedDocuments.map((d) => d.id));

describe("ask.gate: a document the policy or a tombstone hides leaves no trace (X01-C4a)", () => {
  it("shows only the visible document in the events, the Provider's request, the call history and the log", async () => {
    const shown = source("자홍빛", ["open"]);
    const denied = source("남색빛", ["denied"]);
    const deleted = source("청록빛", ["open"]);
    // a cover whose purge never ran: the keyword index still holds the row, so only the gate keeps it out
    seedLegacyTombstone(db, {
      sourceId: deleted.sourceId,
      version: 1,
      at: "2026-11-23T00:00:00.000Z",
      reason: "user-deleted",
    });
    const { deps, provider } = backend();

    const events = await run(deps);

    expect(hitIds(events)).toEqual([shown.id]);
    expect(documentIds(provider)).toEqual([String(shown.id)]);
    const seen = JSON.stringify([
      events,
      provider.requests,
      db.all("SELECT * FROM provider_calls"),
      logged,
    ]);
    expect(seen).toContain(shown.mark);
    for (const hidden of [denied, deleted]) {
      expect(seen).not.toContain(hidden.mark);
      expect(seen).not.toContain(`제목-${hidden.mark}`);
    }
    // the ids of the hidden versions and their sources are in no event either
    const eventText = JSON.stringify(events);
    for (const hidden of [denied, deleted]) {
      expect(eventText).not.toMatch(new RegExp(`"(versionId|sourceId)":${hidden.id}[,}]`));
    }
    // the log names the route and counts, never the question
    expect(logged.join("\n")).not.toContain(QUERY);
  });

  it("keeps a document the policy allows for a search but not for an answer in the hits and out of the Provider's request", async () => {
    const shown = source("자홍빛", ["open"]);
    const searchOnly = source("보라빛", ["noanswer"]);
    const { deps, provider } = backend();

    const events = await run(deps);

    expect(hitIds(events).sort()).toEqual([shown.id, searchOnly.id].sort());
    expect(documentIds(provider)).toEqual([String(shown.id)]);
    expect(JSON.stringify(provider.requests)).not.toContain(searchOnly.mark);
  });
});

describe("ask.gate: the judgement after the Provider answered (X01-R9, R14)", () => {
  it("drops the sentence of a document deleted while the Provider worked, and one whose quote is not in the document", async () => {
    const live = source("자홍빛", ["open"]);
    const going = source("남색빛", ["open"]);
    const { deps } = backend((request) => {
      // the deletion lands between the call and its answer
      seedLegacyTombstone(db, {
        sourceId: going.sourceId,
        version: 1,
        at: "2026-11-23T00:00:00.000Z",
        reason: "user-deleted",
      });
      return {
        sentences: [
          ...request.input.untrustedDocuments.map((d) => ({
            text: "답 문장",
            documentId: d.id,
            quote: d.body,
          })),
          { text: "지어낸 문장", documentId: String(live.id), quote: "본문에 없는 글" },
        ],
        insufficient: false,
      };
    });

    const events = await run(deps);

    const sentences = events.filter((e) => e.type === "sentence");
    expect(sentences.map((e) => e.citation.versionId)).toEqual([live.id]);
    expect(JSON.stringify(sentences)).not.toContain(going.mark); // it was a hit when the search ran
    expect(events.at(-1)).toMatchObject({ type: "done", sentences: 1, dropped: 1 });
  });
});

describe("ask.gate: the least context and nothing stored (X01-C4b)", () => {
  it("① sends at most five documents and the question as the only candidate, with no item name, for eight hits", async () => {
    const docs = Array.from({ length: 8 }, (_, i) => source(`표식${i}`, ["open"]));
    const item = insertItem(db, { type: "Project", name: "항목이름큐", ...attrs });
    const first = docs[0] as (typeof docs)[number];
    const body = db.all("SELECT body FROM source_versions WHERE id = ?", [first.id])[0]
      ?.body as string;
    const factId = saveFact(db, { itemId: item, kind: "memo", value: "값", ...attrs }).id;
    addEvidence(db, {
      target: { factId },
      sourceVersionId: first.id,
      start: 0,
      end: [...body].length,
      quote: body,
    });
    const { deps, provider } = backend();

    const events = await run(deps);

    expect(hitIds(events)).toHaveLength(8);
    const request = provider.requests[0];
    expect(request?.input.untrustedDocuments.length).toBeLessThanOrEqual(5);
    expect(request?.input.untrustedDocuments.length).toBeGreaterThan(0);
    expect(request?.input.candidates).toHaveLength(1);
    expect(request?.input.candidates[0]?.id).toMatch(/^question:/);
    expect(JSON.stringify(request)).not.toContain("항목이름큐");
    // the related-knowledge link of a shown hit may name the item; the request may not
    expect(JSON.stringify(events)).toContain("항목이름큐");
  });

  it("② leaves a hit out of the documents when the policy will not put it with the ones taken", async () => {
    const a = source("가군", ["groupA"]);
    const b = source("나군", ["groupB"]);
    const { deps, provider } = backend();

    const events = await run(deps);

    expect(hitIds(events).sort()).toEqual([a.id, b.id].sort());
    expect(provider.requests[0]?.input.untrustedDocuments).toHaveLength(1);
  });

  it("③ writes no row to any table but provider_calls, and takes the question token back", async () => {
    source("자홍빛", ["open"]);
    const { deps } = backend();
    const rows = () =>
      Object.fromEntries(
        db
          .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .map((t) => [
            t.name as string,
            db.all(`SELECT count(*) AS n FROM "${t.name as string}"`)[0]?.n as number,
          ])
          .filter(([name]) => name !== "provider_calls"),
      );
    const before = rows();

    await run(deps);

    expect(rows()).toEqual(before);
    expect(db.all("SELECT count(*) AS n FROM provider_calls")[0]?.n).toBeGreaterThan(0);
  });
});

describe("ask.questions: the one-shot question token (X01-R8, D10)", () => {
  it("reads the question as an unsourced candidate once, only while the request lives", async () => {
    const inner = {
      lookup: (id: string) =>
        id === "7" ? { name: "항목", evidenceSourceVersionIds: [] } : undefined,
    };
    const candidates = withAskQuestions(inner);
    let token = "";
    await askQuestions.hold("질문 글", async (t) => {
      token = t;
      expect(t).toMatch(/^question:/);
      expect(candidates.lookup(t)).toEqual({
        name: "질문 글",
        evidenceSourceVersionIds: [],
        nameUnsourced: true,
      });
      expect(candidates.lookup(t)).toBeUndefined(); // used once
    });
    expect(candidates.lookup(token)).toBeUndefined(); // gone with the request
    expect(candidates.lookup("question:guess")).toBeUndefined();
    expect(candidates.lookup("7")?.name).toBe("항목"); // anything else is the inner lookup's
  });
});
