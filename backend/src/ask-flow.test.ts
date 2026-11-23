// X01-C1b (R2, R10, offline), C2a (R6~R10, the real API) and C2b (R10, cancel) through the product's pieces: a
// synthetic JSONL goes in through the import API, the knowledge its labels name is planted (the extraction
// schema has no kind for `release_date` or `check_day`, so the fixture extraction cannot give these rows;
// X01-D12 plants labelled knowledge the same way), and `POST /api/ask` answers as newline-delimited JSON.
import { askRoute, AskEventSchema, routes, type AskEvent } from "@pki/contracts";
import { DEFAULT_ENABLED_STRATEGIES, locateQuote } from "@pki/knowledge-engine";
import { DEFAULT_PROVIDER_SETTING, type EgressControls } from "@pki/providers";
import {
  addEvidence,
  insertAssertionLink,
  insertItem,
  saveFact,
  saveRelation,
  writeSetting,
  type SqlDriver,
} from "@pki/storage";
import { FakeProvider, send, type FakeStep } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ask } from "./ask.ts";
import {
  openCanonicalDb,
  productAdapters,
  productCalls,
  productEgress,
  productImporter,
} from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { defaultReadRegistry } from "./read-gate.ts";
import { startServer, type RunningServer } from "./server.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const text = readFileSync(resolve(FIXTURES, "x01-ask.jsonl"), "utf8");
const expected = JSON.parse(readFileSync(resolve(FIXTURES, "x01-expected.json"), "utf8")) as {
  entities: Record<string, { type: string; name: string }>;
  relations: { subject: string; type: string; object: string; evidence: Evidence }[];
  facts: Record<
    string,
    { entity: string; attribute: string; value: string; valid_at?: string; evidence: Evidence }
  >;
  links: { type: "SUPERSEDES" | "CONTRADICTS"; from: string; to: string }[];
};
interface Evidence {
  record_id: string;
  quote: string;
}
const records = text
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { id: string; external_id: string; version: number });

const TOKEN = "a".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const attrs = {
  epistemic: "explicit",
  status: "verified",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
} as const;

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-ask-flow-"));
  db = openCanonicalDb(dir);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function consent(egress: EgressControls) {
  const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
  const granted = egress.grant("local-model", ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

/** The backend over `db`; with `provider` it is the user's default and consented, without it none is chosen. */
async function backend(options: { provider?: FakeProvider; strategies?: boolean } = {}) {
  const egress = productEgress(db);
  const { provider } = options;
  if (provider) {
    writeSetting(db, DEFAULT_PROVIDER_SETTING, provider.id);
    consent(egress);
  }
  const calls = productCalls(db, egress, { providers: provider ? [provider] : [] });
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    calls,
    importer: productImporter(db),
    ...(options.strategies ? { askStrategies: [...DEFAULT_ENABLED_STRATEGIES, "vector"] } : {}),
    ...productAdapters(dir),
  });
  const port = server.port;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  const imported = await send(port, routes.importJsonl.path, headers, routes.importJsonl.method, {
    text,
  });
  expect(imported.status).toBe(200);
  return { port, headers, calls };
}

/** The version row of a fixture record, by its external id and version number. */
const versionOf = (recordId: string) => {
  const r = records.find((x) => x.id === recordId) as (typeof records)[number];
  return db.all(
    `SELECT v.id FROM source_versions v JOIN sources s ON s.id = v.source_id
      WHERE s.external_id = ? ORDER BY v.id`,
    [r.external_id],
  )[r.version - 1]?.id as number;
};

/** Plants the knowledge the labels name over the imported versions (the answer's "related" and its marks read these rows). */
function plant() {
  const cite = (target: { factId: number } | { relationId: number }, e: Evidence) => {
    const id = versionOf(e.record_id);
    const body = db.all("SELECT body FROM source_versions WHERE id = ?", [id])[0]?.body as string;
    const span = locateQuote(body, e.quote);
    if ("dropped" in span) throw new Error(`fixture quote not found: ${e.quote}`);
    addEvidence(db, { target, sourceVersionId: id, quote: e.quote, ...span });
  };
  const item = new Map(
    Object.entries(expected.entities).map(([key, e]) => [
      key,
      insertItem(db, { type: e.type, name: e.name, ...attrs }),
    ]),
  );
  for (const r of expected.relations) {
    const id = saveRelation(db, {
      subjectId: item.get(r.subject) as number,
      type: r.type,
      objectId: item.get(r.object) as number,
      ...attrs,
    }).id;
    cite({ relationId: id }, r.evidence);
  }
  const fact = new Map<string, number>();
  for (const [key, f] of Object.entries(expected.facts)) {
    const id = saveFact(db, {
      itemId: item.get(f.entity) as number,
      kind: f.attribute,
      value: f.value,
      ...attrs,
      validAt: f.valid_at ?? null,
    }).id;
    fact.set(key, id);
    cite({ factId: id }, f.evidence);
  }
  for (const l of expected.links) {
    insertAssertionLink(db, {
      type: l.type,
      fromFactId: fact.get(l.from) as number,
      toFactId: fact.get(l.to) as number,
      createdBy: "rule",
      at: "2026-11-23T00:00:00.000Z",
    });
  }
}

/** A Provider that cites each document it is given whole, and adds one sentence whose quote is nowhere in it. */
const citing = (script: FakeStep[] = []) =>
  new FakeProvider({
    id: "local-model",
    transport: "http",
    script,
    answer: (req) => ({
      sentences: [
        ...req.input.untrustedDocuments.map((d) => ({
          text: "답 문장",
          documentId: d.id,
          quote: d.body,
        })),
        {
          text: "지어낸 문장",
          documentId: req.input.untrustedDocuments[0]?.id ?? "",
          quote: "원문에 없는 글",
        },
      ],
      insufficient: false,
    }),
  });

/** One streamed request: the lines as they arrive, and a way to close the connection. */
function stream(port: number, headers: Record<string, string>, body: unknown) {
  const lines: string[] = [];
  const response: { status: number; type: string } = { status: 0, type: "" };
  let pending = "";
  let closeIt = () => {};
  const ended = new Promise<void>((resolveEnded) => {
    const req = request(
      { host: "127.0.0.1", port, path: askRoute.path, method: "POST", headers },
      (res) => {
        response.status = res.statusCode ?? 0;
        response.type = String(res.headers["content-type"]);
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          pending += chunk;
          const parts = pending.split("\n");
          pending = parts.pop() ?? "";
          lines.push(...parts.filter(Boolean));
        });
        res.on("end", resolveEnded);
      },
    );
    req.on("error", () => resolveEnded());
    req.end(JSON.stringify(body));
    closeIt = () => req.destroy();
  });
  return {
    lines,
    response,
    ended,
    close: () => closeIt(),
    events: () => lines.map((l) => AskEventSchema.parse(JSON.parse(l))),
  };
}

const waitFor = async (until: () => boolean) => {
  for (let i = 0; i < 500 && !until(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(until()).toBe(true);
};

const asked = async (
  port: number,
  headers: Record<string, string>,
  question: string,
  answer = true,
) => {
  const s = stream(port, headers, { question, answer });
  await s.ended;
  return { ...s, events: s.events() };
};
const hitsOf = (events: AskEvent[]) => {
  const e = events.find((x) => x.type === "hits");
  if (e?.type !== "hits") throw new Error("no hits event");
  return e;
};

describe("ask.flow: the offline default (X01-C1b)", () => {
  it("answers with keyword hits, the vector strategy unavailable with its reason and the answer blocked for want of a Provider, with no Provider attempt", async () => {
    const { port, headers } = await backend({ strategies: true });

    const { events, response } = await asked(port, headers, "연말 배포 목표");

    expect(response.status).toBe(200);
    expect(response.type).toContain("application/x-ndjson");
    expect(hitsOf(events).hits.map((h) => h.versionId)).toContain(versionOf("wiki-x01-0001"));
    const route = events.find((e) => e.type === "route");
    expect(route?.type === "route" && route.route.vector?.status).toBe("unavailable");
    expect(route?.type === "route" && route.route.vector).toMatchObject({
      reason: expect.stringMatching(/\S/) as string,
    });
    expect(events.find((e) => e.type === "answer")).toEqual({
      type: "answer",
      status: "blocked",
      reason: "no-provider",
    });
    expect(events.at(-1)).toMatchObject({ type: "done", sentences: 0 });
    expect(db.all("SELECT count(*) AS n FROM provider_calls")[0]?.n).toBe(0);
  });

  it("answers a bad body as 400, a GET as 405, and a vector strategy that is off by default as `off`", async () => {
    const { port, headers } = await backend();

    expect((await send(port, askRoute.path, headers, "POST", { question: "" })).status).toBe(400);
    expect((await send(port, askRoute.path, headers, "GET")).status).toBe(405);
    const { events } = await asked(port, headers, "연말 배포 목표", false);
    const route = events.find((e) => e.type === "route");
    expect(route?.type === "route" && route.route.vector).toEqual({ status: "off" });
    expect(events.find((e) => e.type === "answer")).toEqual({
      type: "answer",
      status: "none",
      reason: "not-requested",
    });
  });
});

describe("ask.flow: from an import to a confirmed answer (X01-C2a)", () => {
  it("streams route, hits, answer, sentences, done; a sentence's quote sits in the stored body at its span; the fabricated one is dropped; a hit has related knowledge", async () => {
    const provider = citing();
    const { port, headers } = await backend({ provider });
    plant();

    const { events } = await asked(port, headers, "배포일");

    const types = events.map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["route", "hits", "answer"]);
    expect(types.slice(3, -1).every((t) => t === "sentence")).toBe(true);
    expect(types.at(-1)).toBe("done");
    expect(events[2]).toEqual({ type: "answer", status: "started", reason: null });
    const sentences = events.flatMap((e) => (e.type === "sentence" ? [e] : []));
    expect(sentences.length).toBeGreaterThan(0);
    for (const { citation } of sentences) {
      const body = db.all("SELECT body FROM source_versions WHERE id = ?", [citation.versionId])[0]
        ?.body as string;
      expect([...body].slice(citation.start, citation.end).join("")).toBe(citation.quote);
    }
    expect(events.at(-1)).toMatchObject({ type: "done", dropped: 1, insufficient: false });
    expect(hitsOf(events).hits.flatMap((h) => h.related.map((r) => r.name))).toContain(
      "물결 프로젝트",
    );
    // the Provider was asked once, after the hits were chosen, with the question as the one candidate
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.input.candidates).toHaveLength(1);
  });

  it("marks a conflict, a stale past version and an insufficient result, and asks no Provider when nothing is found", async () => {
    const provider = citing();
    const { port, headers } = await backend({ provider });
    plant();

    const conflict = hitsOf((await asked(port, headers, "별빛 시스템 점검", false)).events);
    expect(conflict.notes).toEqual(
      expect.arrayContaining([
        { kind: "conflict", versionId: versionOf("wiki-x01-0003") },
        { kind: "conflict", versionId: versionOf("messenger-x01-0006") },
      ]),
    );
    const stale = hitsOf((await asked(port, headers, "배포일", false)).events);
    expect(stale.notes).toContainEqual({ kind: "stale", versionId: versionOf("mail-x01-0004") });

    const none = await asked(port, headers, "존재하지않는낱말");
    expect(hitsOf(none.events)).toMatchObject({ hits: [], notes: [{ kind: "insufficient" }] });
    expect(none.events.find((e) => e.type === "answer")).toEqual({
      type: "answer",
      status: "none",
      reason: "insufficient",
    });
    expect(provider.requests).toHaveLength(0);
  });

  it("writes the hits before it calls the Provider", async () => {
    const provider = citing();
    const { calls } = await backend({ provider });
    const events = ask(
      { db, registry: defaultReadRegistry, broker: calls.broker, issuer: calls.issuer },
      { question: "배포일", answer: true },
      new AbortController().signal,
    );

    expect((await events.next()).value).toMatchObject({ type: "route" });
    expect((await events.next()).value).toMatchObject({ type: "hits" });
    expect(provider.requests).toHaveLength(0); // the caller has the hits; the Provider is not asked yet
    expect((await events.next()).value).toMatchObject({ type: "answer", status: "started" });
    expect(provider.requests).toHaveLength(1);
  });
});

describe("ask.flow: cancel (X01-C2b)", () => {
  it("passes the abort to the Provider, records the call as cancelled, and writes nothing after the connection closes", async () => {
    const provider = citing(["hang", "hang"]);
    const { port, headers, calls } = await backend({ provider });

    const s = stream(port, headers, { question: "배포일", answer: true });
    await waitFor(() => provider.requests.length === 1);
    expect(s.events().map((e) => e.type)).toEqual(["route", "hits"]); // delivered while the call is pending
    expect(provider.signals[0]?.aborted).toBe(false);

    s.close();
    await waitFor(() => provider.signals[0]?.aborted === true);
    await waitFor(
      () => db.all("SELECT outcome FROM provider_calls").at(-1)?.outcome === "cancelled",
    );
    expect(provider.cancelled).toHaveLength(1);
    expect(s.events().map((e) => e.type)).toEqual(["route", "hits"]); // no answer, sentence or done

    // and the request's generator ends without another event once the signal is cut
    const controller = new AbortController();
    const events = ask(
      { db, registry: defaultReadRegistry, broker: calls.broker, issuer: calls.issuer },
      { question: "배포일", answer: true },
      controller.signal,
    );
    await events.next();
    await events.next();
    const next = events.next();
    await waitFor(() => provider.requests.length === 2);
    controller.abort();
    expect(await next).toEqual({ done: true, value: undefined });
  });
});
