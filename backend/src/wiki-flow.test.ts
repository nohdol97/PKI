// K01-C2a (R3, R4, R5, R6, R15) and K01-C3c (R10, R11) through the product's pieces: a synthetic JSONL goes
// in through the import, the fixture extraction runs, and the `wiki-build` job the runner queued itself writes
// the pages. Then the API reads them: claims open to their source span, a backlink on the other end of a
// relation, a second document that disagrees changes the same page and leaves an unrelated one alone, and a
// "rebuild" keeps every page's hash, the user's note and the hidden claim.
import { routes, type RouteName, type RouteRequest, type RouteResponse } from "@pki/contracts";
import { DEFAULT_PROVIDER_SETTING, type EgressControls } from "@pki/providers";
import { writeSetting, type SqlDriver } from "@pki/storage";
import { FakeProvider, fixtureExtraction, send } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openCanonicalDb,
  productAdapters,
  productCalls,
  productEgress,
  productImporter,
  productRunner,
} from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { releaseHeldOnEvent } from "./held-release.ts";
import type { JobRunner } from "./job-runner.ts";
import { startServer, type RunningServer } from "./server.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
const TOKEN = "w".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let runner: JobRunner | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-wiki-flow-"));
  db = openCanonicalDb(dir);
});
afterEach(async () => {
  await server?.close();
  await runner?.stop();
  server = undefined;
  runner = undefined;
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

/** The product's runner (it queues `wiki-build` itself), the import and the API over one database. */
async function backend() {
  const extraction = fixtureExtraction();
  const egress = productEgress(db);
  const provider = new FakeProvider({
    id: "local-model",
    transport: "http",
    answer: (request) =>
      request.taskKind === "wiki-summary"
        ? {
            sentences: request.input.untrustedDocuments.slice(0, 1).map((d) => ({
              text: "요약 문장",
              documentId: d.id,
              quote: d.body,
            })),
          }
        : extraction(request),
  });
  writeSetting(db, DEFAULT_PROVIDER_SETTING, provider.id);
  const calls = productCalls(db, egress, { providers: [provider] });
  const run = productRunner(db, calls.broker, { policyFingerprint: calls.policyFingerprint });
  runner = run;
  consent(egress);
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    onRunConditionsChanged: () => void run.wake(),
    ...productAdapters(dir),
  });
  const headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  const port = server.port;
  const call = async <Name extends RouteName>(name: Name, body?: RouteRequest<Name>) => {
    const route = routes[name];
    const res = await send(port, route.path, headers, route.method, body);
    return { status: res.status, body: res.body as RouteResponse<Name> };
  };
  const importer = productImporter(db, { runner: run });
  return {
    call,
    run,
    egress,
    provider,
    importIn: async (text: string) => (await importer(text), await run.wake()),
  };
}

const pages = () =>
  Object.fromEntries(
    db
      .all("SELECT key, content_hash, updated_at FROM wiki_pages ORDER BY key")
      .map((r) => [
        r.key as string,
        { hash: r.content_hash as string, at: r.updated_at as string },
      ]),
  );
const keyOf = (name: string) =>
  db.all("SELECT key FROM wiki_pages WHERE title = ?", [name])[0]?.key as string;

describe("wiki.flow: from an import to a page the API reads (K01-C2a)", () => {
  it("builds pages with openable evidence and a backlink; a disagreeing second document changes the same page and adds only its Insight page", async () => {
    const { call, importIn } = await backend();
    await importIn(
      ["v02-mail", "v02-wiki", "v02-messenger"].map((n) => read(`${n}.jsonl`)).join("\n"),
    );

    // ① a page with claims whose evidence ids open to the span in the source
    const project = keyOf("미리내 프로젝트");
    const system = keyOf("물결 API");
    expect(project).toMatch(/^projects\//);
    expect(system).toMatch(/^systems\//);
    const index = await call("wiki");
    expect(index.body.stale).toBe(false);
    expect(index.body.kinds.map((k) => k.kind).sort()).toEqual([
      "projects",
      "syntheses",
      "systems",
    ]);
    const page = (await call("wikiPage", { key: project })).body;
    const claim = page.claims.find((c) => c.ref.kind === "fact");
    expect(claim?.evidence.length).toBeGreaterThan(0);
    const opened = await call("evidenceSource", { evidenceId: claim?.evidence[0] as number });
    const { quote, start, end, sourceVersion } = opened.body;
    expect([...sourceVersion.body].slice(start, end).join("")).toBe(quote);

    // ② the other end of the relation has the backlink
    const target = (await call("wikiPage", { key: system })).body;
    expect(target.backlinks.map((b) => b.fromKey)).toContain(project);

    // ③ a second document with another value for the same item: the same key changes, nothing new appears,
    //    the two claims point at each other, and an unrelated page keeps its hash and its time
    const before = pages();
    await importIn(read("v02-date-variant.jsonl"));
    const after = pages();
    // P01: the changed completion date also makes an important-change Insight, a new `syntheses/` page
    expect(Object.keys(after).filter((k) => !(k in before))).toEqual(["syntheses/2"]);
    expect(Object.keys(before).every((k) => k in after)).toBe(true);
    expect(after[system]?.hash).not.toBe(before[system]?.hash);
    expect(after[project]).toEqual(before[project]);
    const changed = (await call("wikiPage", { key: system })).body;
    const dates = changed.claims.filter((c) => c.kind === "completion_date");
    expect(dates).toHaveLength(2);
    expect(dates[0]?.contradicts).toEqual([dates[1]?.ref]);
    expect(dates[1]?.contradicts).toEqual([dates[0]?.ref]);
    const actions = changed.history.map((h) => h.action);
    expect(actions[0]).toBe("created");
    expect(actions.at(-1)).toBe("changed");
  });
});

describe("wiki.flow: rebuild and the user's edits (K01-C3c)", () => {
  it("keeps every page's hash, the note and the hidden claim through a rebuild", async () => {
    const { call, run, importIn } = await backend();
    await importIn(
      ["v02-mail", "v02-wiki", "v02-messenger"].map((n) => read(`${n}.jsonl`)).join("\n"),
    );
    const key = keyOf("물결 API");
    const claim = (await call("wikiPage", { key })).body.claims[0];
    expect(claim).toBeDefined();
    await call("wikiEdit", { op: "note-add", key, text: "내 메모" });
    await call("wikiEdit", { op: "hide", claim: claim?.ref as { kind: "fact"; id: number } });
    const before = pages();
    const built = () =>
      db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'wiki-build' AND status = 'succeeded'")[0]
        ?.n as number;
    const builds = built();

    expect((await call("wikiRebuild", {})).status).toBe(200);
    await run.wake();

    expect(built()).toBe(builds + 1); // it ran: it did not skip as "nothing changed"
    expect(pages()).toEqual(before);
    const page = (await call("wikiPage", { key })).body;
    expect(page.notes.map((n) => n.text)).toEqual(["내 메모"]);
    expect(page.claims.map((c) => c.ref)).not.toContainEqual(claim?.ref);
    expect(page.stale).toBe(false);
  });
});

const summaryJobs = () =>
  db.all("SELECT status, reason FROM jobs WHERE kind = 'wiki-summary' ORDER BY id");
const IMPORT = ["v02-mail", "v02-wiki", "v02-messenger"].map((n) => read(`${n}.jsonl`)).join("\n");

describe("wiki.summary-flow: the setting, consent and the state a page shows (K01-C4 ②③)", () => {
  it("③ with the setting off (the default) queues no summary job and the page says `off`", async () => {
    const { call, importIn } = await backend();
    await importIn(IMPORT);
    expect(summaryJobs()).toEqual([]);
    expect((await call("wikiPage", { key: keyOf("물결 API") })).body.summary).toEqual({
      state: "off",
    });
  });

  it("② without consent the job is held, no Provider is asked, the page says `held`; with consent it becomes `ready`", async () => {
    const { call, run, egress, provider, importIn } = await backend();
    await importIn(IMPORT);
    egress.revoke("local-model");
    const asked = provider.requests.length;

    await call("setSemanticSettings", { autoVerify: false, wikiSummary: true });
    await run.wake();

    expect(summaryJobs().length).toBeGreaterThan(0);
    expect(summaryJobs().every((j) => j.status === "held" && j.reason === "no-consent")).toBe(true);
    expect(provider.requests.length).toBe(asked);
    const key = keyOf("물결 API");
    expect((await call("wikiPage", { key })).body.summary).toEqual({ state: "held" });

    consent(egress);
    releaseHeldOnEvent(db, "consent");
    await run.wake();
    const { summary } = (await call("wikiPage", { key })).body;
    expect(summary.state).toBe("ready");
    expect(summary.sentences?.[0]?.text).toBe("요약 문장");
  });
});
