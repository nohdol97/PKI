// fence.fresh (I04-C2, R11) through the product's pieces on a real SQLite file: an
// extraction result is written only behind commitDerived's checks. A source
// deleted or revoked, a newer version, or a source the result drew on (a candidate
// item's evidence) gone while the Provider answered discards the whole result and
// the job closes superseded; a dead job retried after the deletion writes nothing;
// a version arriving after a lift is not caught by the fence.
import type { StructuredRequest } from "@pki/contracts";
import { applyTombstone } from "@pki/knowledge-engine";
import { DEFAULT_PROVIDER_SETTING, type EgressControls } from "@pki/providers";
import {
  canonicalTransaction,
  closeJob,
  findSourceId,
  leaseNextJob,
  recordTombstoneLift,
  registerJob,
  saveSourceRecord,
  writeSetting,
  type SqlDriver,
  type TombstoneReason,
} from "@pki/storage";
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
import { EXTRACT_JOB_KIND } from "./connectors.ts";
import { createJobActions } from "./job-actions.ts";
import type { JobRunner } from "./job-runner.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8").trim();
const MAIL = JSON.parse(read("v02-mail.jsonl")) as Record<string, string>;

// A second source that names the mail's item (X) as a candidate and adds a fact of
// its own about a new item Y: its result draws on the mail through X.
const Y_NAME = "fvzcanary 시스템";
const DEPENDS = `미리내 프로젝트는 ${Y_NAME}에 의존한다`;
const K = { connector_instance_id: "conn-k", external_id: "k", id: "k-0001" };
const kLine = (revision: number, content: string) =>
  JSON.stringify({
    ...MAIL,
    ...K,
    version: revision,
    title: "k 일정",
    content,
    content_hash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
  });
const K_BODY = `합성 자료. 5월 기준 ${Y_NAME} 완료는 2026-12-10입니다. ${DEPENDS}.`;

function answer(hooks: { during?: ((request: StructuredRequest) => void) | undefined }) {
  const fixture = fixtureExtraction();
  return (request: StructuredRequest): unknown => {
    hooks.during?.(request);
    const body = request.input.untrustedDocuments[0]?.body ?? "";
    if (!body.includes(DEPENDS)) return fixture(request);
    const pick = (name: string) => request.input.candidates.find((c) => c.name === name)?.id;
    return {
      items: [
        {
          ref: "X",
          type: "Project",
          name: "미리내 프로젝트",
          existingItemId: pick("미리내 프로젝트") ?? null,
        },
        { ref: "Y", type: "System", name: Y_NAME, existingItemId: null },
      ],
      facts: [
        {
          item: "Y",
          kind: "completion_date",
          value: "2026-12-10",
          epistemic: "explicit",
          quote: `${"5월"} 기준 ${Y_NAME} 완료는 2026-12-10`,
        },
      ],
      relations: [{ subject: "X", type: "DEPENDS_ON", object: "Y", quote: DEPENDS }],
    };
  };
}

let dir: string;
let db: SqlDriver;
let runner: JobRunner | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-fence-"));
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

function pipeline(hooks: { during?: ((request: StructuredRequest) => void) | undefined } = {}) {
  const provider = new FakeProvider({
    id: "local-model",
    transport: "http",
    answer: answer(hooks),
  });
  writeSetting(db, DEFAULT_PROVIDER_SETTING, provider.id);
  const egress = productEgress(db);
  const { broker } = productCalls(db, egress, { providers: [provider] });
  runner = productRunner(db, broker);
  consent(egress);
  return { provider, runner, importer: productImporter(db) };
}

const count = (table: string) => db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n as number;
const jobStatuses = () => db.all("SELECT status, reason FROM jobs ORDER BY id");
const mailId = () =>
  findSourceId(db, MAIL.connector_instance_id as string, "", MAIL.external_id as string) as number;
const written = () => [count("items"), count("facts"), count("relations"), count("evidence")];
/** The mail's tombstone through the product entry (V02's deleteSource is gone, I01-T02). */
const tombstoneMail = (reason: TombstoneReason) =>
  canonicalTransaction(db, (tx) =>
    applyTombstone(tx, {
      identity: {
        connectorInstanceId: MAIL.connector_instance_id as string,
        namespace: "",
        externalId: MAIL.external_id as string,
      },
      reason,
      lastRevision: null,
      at: new Date().toISOString(),
    }),
  );

describe("fence.fresh: the result of an extraction behind commitDerived", () => {
  it.each(["user-deleted", "access-revoked"] as const)(
    "① ② discards the result when its source is %s while the Provider answers: superseded, nothing written",
    async (reason) => {
      const hooks: { during?: () => void } = {};
      const { provider, runner, importer } = pipeline(hooks);
      await importer(read("v02-mail.jsonl"));
      hooks.during = () => void tombstoneMail(reason);
      await runner.wake();
      expect(provider.requests).toHaveLength(1);
      expect(jobStatuses()).toEqual([{ status: "superseded", reason: "source-closed" }]);
      expect(written()).toEqual([0, 0, 0, 0]);
    },
  );

  it("③ discards an old version's result when a new version arrives while the Provider answers", async () => {
    const hooks: { during?: () => void } = {};
    const { provider, runner, importer } = pipeline(hooks);
    await importer(read("v02-mail.jsonl"));
    hooks.during = () =>
      void saveSourceRecord(db, MAIL.connector_instance_id as string, {
        externalId: MAIL.external_id as string,
        title: MAIL.title as string,
        body: "더 새 version의 합성 본문",
      });
    await runner.wake();
    expect(provider.requests).toHaveLength(1);
    expect(jobStatuses()).toEqual([{ status: "superseded", reason: null }]);
    expect(written()).toEqual([0, 0, 0, 0]);
  });

  it("④ discards the whole result when only a source it drew on (a candidate item's evidence) is deleted, then extracts the version once more", async () => {
    const hooks: { during?: ((request: StructuredRequest) => void) | undefined } = {};
    const { provider, runner, importer } = pipeline(hooks);
    await importer(read("v02-mail.jsonl"));
    await runner.wake();
    const before = written();
    expect(before[0]).toBeGreaterThan(0);
    const [x] = db.all("SELECT id FROM items");
    // the mail's item X is a candidate for K; the mail goes while K is extracted (once)
    hooks.during = (request) => {
      hooks.during = undefined;
      expect(request.input.candidates.map((c) => c.id)).toContain(String(x?.id));
      tombstoneMail("user-deleted");
    };
    await importer(kLine(1, K_BODY));
    await runner.wake();

    // one wake drains the queue: K's discarded run, then its re-extraction
    expect(provider.requests).toHaveLength(3);
    const [, first, retry, ...rest] = db.all(
      "SELECT id, target, status, reason FROM jobs ORDER BY id",
    );
    expect(first).toMatchObject({ status: "superseded", reason: "lineage-covered" });
    // exactly one re-extraction, under a distinct target, run with X gone (no candidate)
    expect(retry).toMatchObject({ target: `lineage-retry:${first?.id}`, status: "succeeded" });
    expect(rest).toEqual([]);
    expect(db.all("SELECT kind, value FROM facts")).toEqual([
      { kind: "completion_date", value: "2026-12-10" },
    ]);
    expect(db.all("SELECT name FROM items ORDER BY id").map((r) => r.name)).toContain(Y_NAME);
  });

  it("⑤ writes nothing for a dead job retried after its source was deleted", async () => {
    const { provider, runner, importer } = pipeline();
    await importer(read("v02-mail.jsonl"));
    const job = leaseNextJob(db, { kinds: [EXTRACT_JOB_KIND], now: new Date(), leaseMs: 60_000 });
    if (!job) throw new Error("expected a job");
    expect(closeJob(db, job, { status: "dead_letter", reason: "provider-error" })).toBe(
      "dead_letter",
    );
    // a dead job is not open: the deletion leaves it
    tombstoneMail("user-deleted");
    expect(jobStatuses()).toEqual([{ status: "dead_letter", reason: "provider-error" }]);

    const actions = createJobActions({ db, runner });
    expect(actions.retry(job.id)).toBe("queued");
    await runner.wake();

    expect(provider.requests).toHaveLength(0);
    expect(jobStatuses()).toEqual([{ status: "superseded", reason: null }]);
    expect(written()).toEqual([0, 0, 0, 0]);
  });

  it("⑥ does not catch a version stored by a storage function after a lift", async () => {
    const { provider, runner, importer } = pipeline();
    await importer(read("v02-mail.jsonl"));
    await runner.wake();
    const sourceId = mailId();
    tombstoneMail("user-deleted");
    expect(written()).toEqual([0, 0, 0, 0]);
    expect(recordTombstoneLift(db, sourceId, new Date().toISOString())).toBe("lifted");

    // the backend entry (acceptChange and its job registration) is bypassed: saveSourceRecord stores the version directly
    const saved = saveSourceRecord(db, MAIL.connector_instance_id as string, {
      externalId: MAIL.external_id as string,
      title: MAIL.title as string,
      body: MAIL.content as string,
    });
    expect(saved).toMatchObject({ status: "created", sourceId, version: 2 });
    const job = registerJob(db, {
      kind: EXTRACT_JOB_KIND,
      sourceId,
      fenceVersion: 2,
      at: new Date(),
    });
    expect(job.registered).toBe(true);
    await runner.wake();

    expect(provider.requests).toHaveLength(2);
    expect(jobStatuses().at(-1)).toEqual({ status: "succeeded", reason: null });
    expect(count("facts")).toBeGreaterThan(0);
  });
});
