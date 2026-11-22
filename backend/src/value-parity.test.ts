// S01-T07 review F2 (S01-R21): the user's add and value fix (POST /api/semantic/correct) and an
// extraction judge a fact's value by the same type definitions. For a seed date kind, a date kind the
// user added and a kind changed to `text`, the two paths accept and reject the same values.
// All data is synthetic.
import { routes } from "@pki/contracts";
import { createBroker, createUserActionLedger, EXTRACT_FACT_KINDS } from "@pki/providers";
import {
  closeJob,
  factValueFit,
  insertItem,
  isFenceCurrent,
  leaseNextJob,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  userDecisions,
  type ElementRule,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { createExtractHandler, knowledgeCandidates } from "@pki/knowledge-engine";
import { FakeProvider, send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "s".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const T0 = new Date("2026-11-21T00:00:00.000Z");
const VALUES = ["2026-12-05", "2026-02-30", "soon", "12월 5일", "   "];

let dir: string;
let db: SqlDriver;
let server: RunningServer;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-value-parity-"));
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "fixtures", "test-fixtures");
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    decisions: userDecisions,
  });
});
afterEach(async () => {
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const DATE_KIND = (
  itemTypes = ["Project"],
): Extract<ElementRule, { elementKind: "fact-kind" }> => ({
  elementKind: "fact-kind",
  itemTypes,
  valueType: "date",
  cardinality: "many",
});

/** The values the API's direct add keeps (200 applied) for a fact kind, one fresh item per value. */
async function viaApi(kind: string): Promise<string[]> {
  const kept: string[] = [];
  for (const [i, value] of VALUES.entries()) {
    const itemId = insertItem(db, {
      type: "Project",
      name: `API ${i}`,
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
    });
    const res = await send(
      server.port,
      routes.semanticCorrect.path,
      { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` },
      "POST",
      { correction: { action: "add", entry: { kind: "fact", itemId, factKind: kind, value } } },
    );
    if (res.status === 200 && (res.body as { status: string }).status === "applied")
      kept.push(value);
    else expect([value, res.status]).toEqual([value, 400]);
  }
  return kept;
}

/** The values an extraction keeps for the fact kind: one source and one answer per value. */
async function viaExtraction(kind: string): Promise<string[]> {
  const kept: string[] = [];
  if (!(EXTRACT_FACT_KINDS as readonly string[]).includes(kind)) {
    // the prompt's schema (`z.enum`, providers/src/tasks.ts) cannot name a kind the user added until
    // S01-T08/S02 build the list from the registry: the answer would be an invalid output. What
    // extraction does with such a kind is the same function, read here by name.
    return VALUES.filter((v) => factValueFit(db, kind, v.trim()) === "fits");
  }
  for (const [i, value] of VALUES.entries()) {
    const quote = `미리내 ${i} 프로젝트의 날짜 항목입니다`;
    const provider = new FakeProvider({
      answer: () => ({
        items: [{ ref: "p", type: "Project", name: `추출 ${i}`, existingItemId: null }],
        facts: [{ item: "p", kind, value, epistemic: "explicit", quote }],
        definitions: [],
        terms: [],
        relations: [],
      }),
    });
    const broker = createBroker({
      db,
      provider: () => provider,
      userActions: createUserActionLedger().redeemer,
      candidates: knowledgeCandidates(db),
      egress: { decide: () => ({ allowed: true, destination: "fake", policyVersion: "pv" }) },
      execution: { decide: () => ({ run: true }) },
      recorder: {
        record: () => undefined,
        begin: () => () => undefined,
        attemptTimes: () => [],
        interruptStarted: () => 0,
      },
      clock: { now: () => 0, sleep: async () => undefined },
    });
    const handler = createExtractHandler({ db, now: () => T0 });
    const job: StoredJob = db.transaction(() => {
      const saved = saveSourceRecord(db, "fixtures", {
        externalId: `doc-${kind}-${i}`,
        title: "t",
        body: quote,
      });
      if (saved.status !== "created") throw new Error(saved.status);
      const r = registerJob(db, {
        kind: "extract",
        sourceId: saved.sourceId,
        fenceVersion: saved.version,
        at: T0,
      });
      if (!r.registered) throw new Error("job");
      return r.job;
    });
    const leased = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
    if (!leased || leased.id !== job.id) throw new Error("expected the job");
    const fence = {
      sourceId: leased.sourceId as number,
      fenceVersion: leased.fenceVersion as number,
    };
    if (!isFenceCurrent(db, fence)) throw new Error("fence");
    const result = await handler(leased, { broker });
    if (result.status !== "succeeded") throw new Error(result.status);
    closeJob(db, leased, result);
    const stored = db.all(
      "SELECT 1 FROM facts f JOIN items i ON i.id = f.item_id WHERE f.kind = ? AND i.name = ?",
      [kind, `추출 ${i}`],
    );
    if (stored.length > 0) kept.push(value);
  }
  return kept;
}

const change = (c: Parameters<typeof userDecisions.ontology.change>[1]) => {
  const out = userDecisions.ontology.change(db, c);
  if (out.status !== "applied") throw new Error(JSON.stringify(out));
};

describe("one value check for the user's add and for extraction (S01-R21, review F2)", () => {
  it.each([
    ["a seed date kind", "target_date", () => undefined, ["2026-12-05"]],
    [
      "a date kind the user added",
      "due_date",
      () => change({ op: "add", name: "due_date", rule: DATE_KIND() }),
      ["2026-12-05"],
    ],
    [
      "a kind changed to text",
      "target_date",
      () =>
        change({
          op: "change-rule",
          elementKind: "fact-kind",
          name: "target_date",
          rule: { ...DATE_KIND(["Project", "System"]), valueType: "text" },
        }),
      ["2026-12-05", "2026-02-30", "soon", "12월 5일"],
    ],
  ])("accepts and rejects the same values under %s", async (_n, kind, setup, expected) => {
    setup();
    const api = await viaApi(kind);
    const extracted = await viaExtraction(kind);
    expect(api).toEqual(expected);
    expect(extracted).toEqual(expected);
  });
});
