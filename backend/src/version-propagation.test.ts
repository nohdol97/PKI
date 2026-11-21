// update.recompute (V02-C3, R11) through the product's pieces: the JSONL import
// stores an edited version of the chat source, the store supersedes what only the
// previous version supported (its evidence stays on that version) and recomputes
// the Insight; the new version's own extraction job revives a same row it gives
// current evidence again, and the Insight comes back in its old row. A version
// replaced before its extraction ran is never extracted (fence, V02-R5).
import type { StructuredRequest } from "@pki/contracts";
import { type EgressControls } from "@pki/providers";
import { readChangeSeq, readKnowledgeRevision, type SqlDriver } from "@pki/storage";
import { FakeProvider, fixtureExtraction } from "@pki/testkit";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openCanonicalDb,
  productCalls,
  productEgress,
  productImporter,
  productRunner,
} from "./composition.ts";
import type { JobRunner } from "./job-runner.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8").trim();
const CHAT = JSON.parse(read("v02-messenger.jsonl")) as { content: string; version: number };
const COMPLETION = /물결 API 개발 완료가 (\d{4}-\d{2}-\d{2})으로 연기되었습니다/;

/** The chat line edited to say B completes on `date`, as the record's `revision`-th version. */
function chatEdit(date: string, revision: number): string {
  const content = CHAT.content.replace(/2026-12-10/, date);
  return JSON.stringify({
    ...CHAT,
    content,
    content_hash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    version: revision,
  });
}

/**
 * The per-fixture double, and for an edited chat body B's completion date with
 * its quote, B picked from the candidates the request carried (the same answer
 * the fixture gets, at another date).
 */
function answer(): (request: StructuredRequest) => unknown {
  const fixture = fixtureExtraction();
  return (request) => {
    const body = request.input.untrustedDocuments[0]?.body ?? "";
    const match = COMPLETION.exec(body);
    if (body === CHAT.content || !match) return fixture(request);
    const b = request.input.candidates.find((c) => c.name === "물결 API");
    return {
      items: [{ ref: "B", type: "System", name: "물결 API", existingItemId: b?.id ?? null }],
      facts: [
        {
          item: "B",
          kind: "completion_date",
          value: match[1],
          epistemic: "explicit",
          quote: match[0],
        },
      ],
      relations: [],
    };
  };
}

let dir: string;
let db: SqlDriver;
let runner: JobRunner | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-propagation-"));
  db = openCanonicalDb(dir);
});
afterEach(async () => {
  await runner?.stop();
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

function pipeline() {
  const provider = new FakeProvider({ id: "local-model", transport: "http", answer: answer() });
  const egress = productEgress(db);
  const { broker } = productCalls(db, egress, { providers: [provider] });
  runner = productRunner(db, broker);
  consent(egress);
  return { provider, runner, importer: productImporter(db, { runner }) };
}

const completionFacts = () =>
  db.all("SELECT id, value, status FROM facts WHERE kind = 'completion_date' ORDER BY id");
const insight = () => db.all("SELECT id, state, summary FROM insights");
/** Each evidence of a fact with the chat source's version number it points at. */
const evidenceOf = (factId: number) =>
  db.all(
    `SELECT e.id, v.version FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
     WHERE e.fact_id = ? ORDER BY e.id`,
    [factId],
  );
const plain = () =>
  ["v02-mail.jsonl", "v02-wiki.jsonl", "v02-messenger.jsonl"].map(read).join("\n");

describe("update.recompute", () => {
  it("resolves the Insight after B's date moves earlier and brings back the same row when it moves later again", async () => {
    const { runner, importer } = pipeline();
    await importer(plain());
    await runner.wake();
    const [first] = insight();
    expect(first).toMatchObject({ state: "active" });
    const [late] = completionFacts() as { id: number }[];
    const [lateEvidence] = evidenceOf(late?.id as number);

    expect(await importer(chatEdit("2026-12-03", 2))).toMatchObject({ created: 1, errorCount: 0 });
    // stored with the version, before its extraction: 12-10 lost its only current evidence
    expect(completionFacts()).toEqual([
      { id: late?.id, value: "2026-12-10", status: "superseded" },
    ]);
    expect(insight()).toEqual([{ id: first?.id, state: "resolved", summary: null }]);
    await runner.wake();
    expect(completionFacts()).toEqual([
      { id: late?.id, value: "2026-12-10", status: "superseded" },
      expect.objectContaining({ value: "2026-12-03", status: "candidate" }),
    ]);
    expect(insight()).toEqual([{ id: first?.id, state: "resolved", summary: null }]);
    // the old evidence was not taken off: it still points at version 1
    expect(evidenceOf(late?.id as number)).toEqual([{ id: lateEvidence?.id, version: 1 }]);

    expect(await importer(chatEdit("2026-12-12", 3))).toMatchObject({ created: 1, errorCount: 0 });
    await runner.wake();
    expect(completionFacts().map((f) => [f.value, f.status])).toEqual([
      ["2026-12-10", "superseded"],
      ["2026-12-03", "superseded"],
      ["2026-12-12", "candidate"],
    ]);
    const [again] = insight();
    expect(again).toMatchObject({ id: first?.id, state: "active" });
    expect(again?.summary).toContain("2026-12-12");
    expect(db.all("SELECT count(*) AS n FROM insights")).toEqual([{ n: 1 }]);
    const evidence = db.all(
      `SELECT v.version, e.quote FROM insight_evidence ie JOIN evidence e ON e.id = ie.evidence_id
       JOIN source_versions v ON v.id = e.source_version_id JOIN sources s ON s.id = v.source_id
       WHERE s.external_id = 'ch-mulgyeol/v02-delay'`,
    );
    expect(evidence).toEqual([
      { version: 3, quote: "물결 API 개발 완료가 2026-12-12으로 연기되었습니다" },
    ]);
  });

  it("revives the superseded row itself when an edit brings its value back, its old evidence still on version 1", async () => {
    const { runner, importer } = pipeline();
    await importer(plain());
    await runner.wake();
    const [first] = insight();
    const [late] = completionFacts() as { id: number }[];
    const [v1Evidence] = evidenceOf(late?.id as number);
    await importer(chatEdit("2026-12-03", 2));
    await runner.wake();
    expect(insight()).toMatchObject([{ id: first?.id, state: "resolved" }]);

    // editing back: the same text as version 1, stored as version 3
    await importer(chatEdit("2026-12-10", 3));
    await runner.wake();
    expect(completionFacts().map((f) => [f.id, f.value, f.status])).toEqual([
      [late?.id, "2026-12-10", "candidate"],
      [expect.any(Number), "2026-12-03", "superseded"],
    ]);
    expect(evidenceOf(late?.id as number)).toEqual([
      { id: v1Evidence?.id, version: 1 },
      { id: expect.any(Number), version: 3 },
    ]);
    expect(insight()).toMatchObject([{ id: first?.id, state: "active" }]);
    expect(db.all("SELECT count(*) AS n FROM facts WHERE kind = 'completion_date'")).toEqual([
      { n: 2 },
    ]);
  });

  it("supersedes the job of a version replaced before it ran, extracting only the latest", async () => {
    const { provider, runner, importer } = pipeline();
    await importer(plain());
    await runner.wake();
    const calls = provider.requests.length;
    const seq = readChangeSeq(db);
    const revision = readKnowledgeRevision(db);
    // two edits in one file, imported without waking the runner (so it cannot pick
    // version 2 between the file's rounds): versions 2 and 3, one job each
    expect(
      await productImporter(db)([chatEdit("2026-12-03", 2), chatEdit("2026-12-12", 3)].join("\n")),
    ).toMatchObject({ created: 2, errorCount: 0 });
    // the trigger raised the change sequence once per stored version
    expect(readChangeSeq(db)).toBe(seq + 2);
    // only 12-10 lost its current evidence (one status change); 12-03 was never extracted
    expect(readKnowledgeRevision(db)).toBe(revision + 1);
    await runner.wake();
    expect(provider.requests.length).toBe(calls + 1);
    expect(db.all("SELECT fence_version, status FROM jobs WHERE fence_version > 1")).toEqual([
      { fence_version: 2, status: "superseded" },
      { fence_version: 3, status: "done" },
    ]);
    expect(completionFacts().map((f) => [f.value, f.status])).toEqual([
      ["2026-12-10", "superseded"],
      ["2026-12-12", "candidate"],
    ]);
    expect(insight()).toMatchObject([{ state: "active" }]);
  });
});
