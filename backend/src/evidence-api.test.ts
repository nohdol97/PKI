// V02-R14 evidence routes (spec "T10이 넘기는 것" 1): Home's active Insights, an
// Insight's evidence, and the source version an evidence row points to with its
// code point span. The DB is filled by the product pipeline with the fixture
// double (v02-seed.e2e.ts), so what the routes read is what extraction wrote.
import { ErrorResponseSchema, routes } from "@pki/contracts";
import { saveInsight, type SqlDriver } from "@pki/storage";
import { send } from "@pki/testkit";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress, productImporter } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";
import { seedV02 } from "./v02-seed.e2e.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
interface Evidence {
  record_id: string;
  version: number;
  span: [number, number];
  quote: string;
}
const expected = JSON.parse(read("v02-expected.json")) as {
  sets: Record<string, { insights: { evidence: Evidence[] }[] }>;
};
const TOKEN = "e".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let dir: string;
let db: SqlDriver;
let server: RunningServer;
let valid: Record<string, string>;

async function start(sets: readonly string[]) {
  expect(await seedV02(db, sets)).toBe(0);
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    importer: productImporter(db),
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-evidence-api-"));
  db = openCanonicalDb(dir);
});
afterEach(async () => {
  await server?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = <Name extends "insights" | "insightEvidence" | "evidenceSource">(
  name: Name,
  body?: unknown,
) => send(server.port, routes[name].path, valid, routes[name].method, body);

/** The title of each fixture record id. */
const titles = new Map(
  ["v02-mail.jsonl", "v02-wiki.jsonl", "v02-messenger.jsonl", "v02-malicious.jsonl"].flatMap(
    (file) =>
      read(file)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: string; title: string })
        .map((r) => [r.id, r.title] as const),
  ),
);

describe.each(["plain", "malicious"])("evidence routes on the %s set", (set) => {
  it("lists the one active Insight as an inference, opens its three evidence and each source span", async () => {
    await start([set]);
    const listed = await call("insights");
    expect(listed.status).toBe(200);
    const insights = routes.insights.response.parse(listed.body).insights;
    expect(insights).toHaveLength(1);
    const [insight] = insights;
    expect(insight).toMatchObject({ epistemic: "inferred", evidenceCount: 3 });
    expect(insight?.summary).toContain("추론");

    const opened = await call("insightEvidence", { insightId: insight?.id });
    expect(opened.status).toBe(200);
    const { evidence } = routes.insightEvidence.response.parse(opened.body);
    const want = expected.sets[set]?.insights[0]?.evidence ?? [];
    expect(evidence.map((e) => e.quote).sort()).toEqual(want.map((e) => e.quote).sort());
    for (const row of evidence) {
      const fixture = want.find((e) => e.quote === row.quote) as Evidence;
      expect(row).toMatchObject({
        version: fixture.version,
        current: true,
        status: "candidate",
        sourceTitle: titles.get(fixture.record_id),
      });

      const source = await call("evidenceSource", { evidenceId: row.id });
      expect(source.status).toBe(200);
      const shown = routes.evidenceSource.response.parse(source.body);
      expect(shown).toMatchObject({
        evidenceId: row.id,
        quote: fixture.quote,
        start: fixture.span[0],
        end: fixture.span[1],
        sourceVersion: {
          id: row.sourceVersionId,
          version: fixture.version,
          latestVersion: fixture.version,
        },
      });
      // code points, not UTF-16 units: the fixtures put emoji before some quotes
      expect(Array.from(shown.sourceVersion.body).slice(shown.start, shown.end).join("")).toBe(
        fixture.quote,
      );
    }
  });
});

describe("hidden and old rows", () => {
  it("does not list or open a resolved Insight", async () => {
    await start(["plain"]);
    const [insight] = routes.insights.response.parse((await call("insights")).body).insights;
    const key = db.all("SELECT rule, x_item_id, y_item_id FROM insights WHERE id = ?", [
      insight?.id ?? 0,
    ])[0];
    saveInsight(
      db,
      {
        rule: key?.rule as string,
        xItemId: key?.x_item_id as number,
        yItemId: key?.y_item_id as number,
      },
      { state: "resolved" },
    );
    expect((await call("insights")).body).toEqual({ insights: [] });
    const opened = await call("insightEvidence", { insightId: insight?.id });
    expect(opened.status).toBe(404);
    expect(ErrorResponseSchema.parse(opened.body)).toEqual({ error: "not-found" });
  });

  it("opens past evidence on the version it points to, not the source's latest", async () => {
    await start(["plain"]);
    const [insight] = routes.insights.response.parse((await call("insights")).body).insights;
    const { evidence } = routes.insightEvidence.response.parse(
      (await call("insightEvidence", { insightId: insight?.id })).body,
    );
    const chat = evidence.find((e) => e.quote.startsWith("물결 API 개발")) as (typeof evidence)[0];
    const before = routes.evidenceSource.response.parse(
      (await call("evidenceSource", { evidenceId: chat.id })).body,
    );

    // version 2 of the chat source moves B's date; T07 leaves the old evidence on version 1
    const line = JSON.parse(read("v02-messenger.jsonl").trim()) as { content: string };
    const content = line.content.replace("2026-12-10", "2026-12-03");
    const edit = JSON.stringify({
      ...line,
      content,
      content_hash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
      version: 2,
    });
    expect(await productImporter(db)(edit)).toMatchObject({ created: 1 });
    expect((await call("insights")).body).toEqual({ insights: [] });

    const after = routes.evidenceSource.response.parse(
      (await call("evidenceSource", { evidenceId: chat.id })).body,
    );
    expect(after.sourceVersion).toEqual({ ...before.sourceVersion, latestVersion: 2 });
    expect(after.sourceVersion.body).toContain("2026-12-10");
    expect(after.sourceVersion.version).toBe(1);
  });

  it("answers not-found for evidence that does not exist", async () => {
    await start(["plain"]);
    const res = await call("evidenceSource", { evidenceId: 9999 });
    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "not-found" });
  });
});

// "T10이 넘기는 것" 7: the test T08 owes. After the Sources screen deletes a source
// (V02-R12), its Insight's evidence list and its evidence's source view are
// not-found and carry nothing of it; evidence of the other sources still opens.
describe("after a source is deleted (V02-T08)", () => {
  it("answers not-found with no content for the purged source's Insight and evidence", async () => {
    await start(["plain"]);
    const [insight] = routes.insights.response.parse((await call("insights")).body).insights;
    const { evidence } = routes.insightEvidence.response.parse(
      (await call("insightEvidence", { insightId: insight?.id })).body,
    );
    const chat = JSON.parse(read("v02-messenger.jsonl").trim()) as Record<string, string>;
    const purged = evidence.filter((e) => e.sourceTitle === chat.title);
    const kept = evidence.filter((e) => e.sourceTitle !== chat.title);
    expect([purged.length, kept.length]).toEqual([1, 2]);

    const { path, method } = routes.deleteSource;
    const deleted = await send(server.port, path, valid, method, {
      connectorId: chat.connector_instance_id,
      externalId: chat.external_id,
    });
    expect(deleted.body).toEqual({ outcome: "deleted" });

    expect((await call("insights")).body).toEqual({ insights: [] });
    const responses = [
      await call("insightEvidence", { insightId: insight?.id }),
      ...(await Promise.all(purged.map((e) => call("evidenceSource", { evidenceId: e.id })))),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not-found" });
    }
    for (const e of kept) {
      expect((await call("evidenceSource", { evidenceId: e.id })).status).toBe(200);
    }
  });
});

describe("request validation", () => {
  it.each([
    ["insightEvidence", { insightId: 1, extra: 1 }],
    ["insightEvidence", { insightId: 0 }],
    ["insightEvidence", { insightId: -1 }],
    ["insightEvidence", { insightId: 1.5 }],
    ["insightEvidence", { insightId: "1" }],
    ["insightEvidence", {}],
    ["insightEvidence", "not json"],
    ["evidenceSource", { evidenceId: 1, extra: 1 }],
    ["evidenceSource", { evidenceId: 0 }],
    ["evidenceSource", { evidenceId: 2 ** 53 }],
    ["evidenceSource", { evidenceId: null }],
    ["evidenceSource", {}],
  ] as const)("%s rejects %j", async (name, body) => {
    await start(["plain"]);
    const res = await call(name, body);
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "bad-request" });
  });

  it("keeps the routes behind the session token", async () => {
    await start(["plain"]);
    for (const name of ["insights", "insightEvidence", "evidenceSource"] as const) {
      const { path, method } = routes[name];
      const res = await send(server.port, path, { ...valid, authorization: "Bearer x" }, method, {
        insightId: 1,
        evidenceId: 1,
      });
      expect(res.status).toBe(401);
    }
  });
});
