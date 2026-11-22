// I01-R30 `docs.connector-sdk` (the tables and the sample): what docs/connector-sdk.md writes as a
// table or a number equals the code constant it describes, and its JSONL sample is a real
// import. A table row changed on one side only fails here. This file lives in the backend
// package because it must import @pki/testkit, @pki/contracts and @pki/connector-sdk by
// name (tooling/ is no package); the text-level checks are tooling/docs/connector-sdk.test.ts.
import {
  INSTANCE_BUSY_RETRY_MS,
  JSONL_CAPABILITIES,
  MAX_JSONL_BYTES,
  MAX_JSONL_DEPTH,
  MAX_JSONL_LINE_CHARS,
  parseJsonl,
  SYNC_OUTCOMES,
  type SyncOutcomeRow,
} from "@pki/connector-sdk";
import {
  blocksValid,
  ChangeSchema,
  CONNECTOR_SDK_VERSION,
  ConnectorRateLimitError,
  REJECT_CODES,
  rejectedPositionValid,
  SourceRecordSchema,
  SYNC_STOP_CODES,
  type Connector,
} from "@pki/contracts";
import { CONNECTOR_VIOLATION_CODES } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectorKinds, openCanonicalDb } from "./composition.ts";
import { SYNC_PERIOD } from "./connector-sync-job.ts";
import { REJECTED_LIST_LIMIT, SYNC_BACKOFF, siteCheck } from "./connectors.ts";
import { importContent } from "./imports.ts";
import type { SqlDriver } from "@pki/storage";

const repo = resolve(import.meta.dirname, "../..");
const DOC = readFileSync(resolve(repo, "docs/connector-sdk.md"), "utf8");
const lines = DOC.split("\n");

/** The rows (cells, trimmed) of the first table after the line that starts with `anchor`. */
function tableAfter(anchor: string, source: string[] = lines): string[][] {
  const at = source.findIndex((l) => l.startsWith(anchor));
  expect(at, `anchor ${anchor}`).toBeGreaterThanOrEqual(0);
  const start = source.findIndex((l, i) => i > at && l.startsWith("|"));
  const rows: string[][] = [];
  for (const row of source.slice(start + 2)) {
    if (!row.startsWith("|")) break;
    rows.push(
      row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  }
  return rows;
}

/** The identifiers in backticks of the first line that starts with `prefix`, up to its end. */
function codesOfLine(prefix: string): string[] {
  const row = lines.find((l) => l.startsWith(prefix));
  expect(row, `line ${prefix}`).toBeDefined();
  return [...(row as string).slice(prefix.length).matchAll(/`([a-z-]+)`/g)].map(
    (m) => m[1] as string,
  );
}

describe("docs.connector-sdk: the tables equal the code", () => {
  it("the violation-code table lists CONNECTOR_VIOLATION_CODES, in order", () => {
    const rows = tableAfter("### 위반 코드 표");
    expect(rows).toHaveLength(21);
    expect(rows.map((r) => (r[0] as string).replaceAll("`", ""))).toEqual([
      ...CONNECTOR_VIOLATION_CODES,
    ]);
  });

  it("the reject codes and the stop codes are the closed lists of the contracts, in order", () => {
    expect(codesOfLine("- 거부 코드(`REJECT_CODES`):")).toEqual([...REJECT_CODES]);
    expect(codesOfLine("- 멈춤 코드(`SYNC_STOP_CODES`):")).toEqual([...SYNC_STOP_CODES]);
  });

  it("the capability table has the five capabilities the JSONL Connector declares, in order", () => {
    const rows = tableAfter("### manifest와 능력 선언");
    expect(rows.map((r) => (r[0] as string).replaceAll("`", ""))).toEqual(
      Object.keys(JSONL_CAPABILITIES),
    );
  });

  const NEXT_RUN: Record<string, SyncOutcomeRow["nextRun"]> = {
    "다음 주기": "next-period",
    "작업 대기열의 대기 시간과 결과의 `retryAfterMs` 가운데 늦은 쪽": "backoff-or-retry-after",
    "작업 대기열의 대기 시간": "backoff",
    "1분 뒤": "one-minute",
    없음: "none",
    "인스턴스의 설정이 바뀌거나 앱이 갱신될 때, 그리고 한 시간마다의 재점검":
      "settings-change-or-hourly-recheck",
  };
  const ATTEMPT: Record<string, SyncOutcomeRow["attempt"]> = {
    씀: "spent",
    "쓰지 않음": "unspent",
    "—": "n/a",
  };
  function outcomeRows(source: string[]): SyncOutcomeRow[] {
    const header = source.findIndex((l) => l.startsWith("| 동기화의 끝 | 작업 결과 |"));
    expect(header).toBeGreaterThan(0);
    const out: SyncOutcomeRow[] = [];
    for (const row of source.slice(header + 2)) {
      if (!row.startsWith("|")) break;
      const [end, result, attempt, next] = row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()) as [string, string, string, string];
      const nextRun = NEXT_RUN[next];
      const spent = ATTEMPT[attempt];
      if (nextRun === undefined || spent === undefined)
        throw new Error(`a cell this test cannot read: ${row}`);
      const exhausted = /시도가 다하면 `([a-z_]+)`/.exec(result)?.[1];
      out.push({
        end: (end.startsWith("멈추지 않고 끝남")
          ? "completed"
          : end.startsWith("인스턴스가")
            ? /`([a-z-]+)`/.exec(end)?.[1]
            : end.replaceAll("`", "")) as SyncOutcomeRow["end"],
        result: /^`([a-z_]+)`/.exec(result)?.[1] as SyncOutcomeRow["result"],
        attempt: spent,
        ...(exhausted ? { exhaustedResult: exhausted as "dead_letter" } : {}),
        nextRun,
      });
    }
    return out;
  }

  it("the sync-outcome table equals SYNC_OUTCOMES, row by row (twelve rows)", () => {
    const rows = outcomeRows(lines);
    expect(rows).toHaveLength(12);
    expect(rows).toEqual(SYNC_OUTCOMES);
  });

  it("fails when one cell of the outcome table is changed", () => {
    const changed = DOC.replace(
      "| `instance-busy` | `retry` | 쓰지 않음 | 1분 뒤 |",
      "| `instance-busy` | `retry` | 씀 | 1분 뒤 |",
    ).split("\n");
    expect(outcomeRows(changed)).not.toEqual(SYNC_OUTCOMES);
  });

  it("fails when a row of the outcome table is dropped", () => {
    const dropped = lines.filter((l) => !l.startsWith("| `no-progress` | `dead_letter`"));
    expect(outcomeRows(dropped)).not.toEqual(SYNC_OUTCOMES);
  });

  it("fails when a code is missing from the violation table", () => {
    const dropped = lines.filter((l) => !l.startsWith("| `abort-ignored` |"));
    const rows = tableAfter("### 위반 코드 표", dropped);
    expect(rows.map((r) => (r[0] as string).replaceAll("`", ""))).not.toEqual([
      ...CONNECTOR_VIOLATION_CODES,
    ]);
  });

  it("the one-minute wait of an instance that is busy is the constant", () => {
    expect(INSTANCE_BUSY_RETRY_MS).toBe(60_000);
    expect(DOC).toContain("| `instance-busy` | `retry` | 쓰지 않음 | 1분 뒤 |");
  });
});

describe("docs.connector-sdk: the numbers equal the code", () => {
  it("the retry values: three tries, a first wait of one second, a cap of thirty seconds", () => {
    expect(SYNC_BACKOFF).toEqual({ attempts: 3, maxWaitMs: 30_000, firstWaitMs: 1000 });
    expect(DOC).toContain("`min(retryAfterMs, 30초)`");
    expect(DOC).toContain("1초부터 두 배씩 기다리되 30초를 넘지 않는다");
    expect(DOC).toContain("한 페이지의 시도는 모두 3회까지다");
  });

  it("the JSONL limits: 10 MiB, 1 MiB characters, depth 64", () => {
    expect(MAX_JSONL_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_JSONL_LINE_CHARS).toBe(1024 * 1024);
    expect(MAX_JSONL_DEPTH).toBe(64);
    expect(DOC).toContain("10 MiB(`MAX_JSONL_BYTES`)");
    expect(DOC).toContain("1 MiB 글자(`MAX_JSONL_LINE_CHARS`");
    expect(DOC).toContain("64(`MAX_JSONL_DEPTH`)");
  });

  it("the page size the product asks for and the scenario's page cap", () => {
    expect(readFileSync(resolve(repo, "backend/src/connectors.ts"), "utf8")).toContain(
      "const PAGE_LIMIT = 100;",
    );
    expect(DOC).toContain("한 번에 100개까지 요청한다(`PAGE_LIMIT`)");
    expect(
      readFileSync(resolve(repo, "packages/testkit/src/connector.contract.ts"), "utf8"),
    ).toContain("const PAGE_CAP = 10_000;");
    expect(DOC).toContain("기본 10,000쪽");
  });

  it("the contract suite reads with limit 1000 and 1, as the text says, and the list shows 100 rejections", () => {
    const suite = readFileSync(resolve(repo, "packages/testkit/src/connector.contract.ts"), "utf8");
    expect(suite.match(/1000/g)).toHaveLength(3);
    expect(suite).toContain("check.read(subject, 1000, upserts)");
    expect(suite).toContain("check.read(connector, 1000, upserts)");
    expect(suite).toContain("{ limit: 1000, signal: signal() }");
    expect(suite).toContain("{ limit: 1, signal: ");
    expect(DOC).toContain("`getChanges`를 `limit` 1000과 1로");
    expect(REJECTED_LIST_LIMIT).toBe(100);
    expect(DOC).toContain("앞의 100건 `REJECTED_LIST_LIMIT`");
  });

  it("the default period of a pulling instance is hourly", () => {
    expect(SYNC_PERIOD).toEqual({ kind: "hourly" });
    expect(DOC).toContain("한 시간 주기가 기본으로 만들어진다(`SYNC_PERIOD`)");
  });

  it("the specification version the text names is the contracts' constant", () => {
    expect(CONNECTOR_SDK_VERSION).toBe(2);
    expect(DOC).toContain("`CONNECTOR_SDK_VERSION` = 2");
  });

  it("the millisecond revision of the worked example is what the text writes", () => {
    const written = /new Date\("([^"]+)"\)\.getTime\(\)`은 `(\d+)`/.exec(DOC);
    expect(written).not.toBeNull();
    expect(new Date(written?.[1] as string).getTime()).toBe(Number(written?.[2]));
    expect(Number.isSafeInteger(Number(written?.[2]))).toBe(true);
  });
});

describe("docs.connector-sdk: the sample and the commands run", () => {
  const sample = (() => {
    const at = lines.findIndex((l) => l === "<!-- jsonl-sample -->");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe("```jsonl");
    return lines
      .slice(
        at + 2,
        lines.findIndex((l, i) => i > at + 1 && l === "```"),
      )
      .join("\n");
  })();

  let dir: string;
  let db: SqlDriver;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pki-doc-sdk-"));
    db = openCanonicalDb(join(dir, "data"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the JSONL sample parses to an upsert and a delete of one source, with nothing refused", () => {
    const { lines: parsed, rejected } = parseJsonl(sample);
    expect(rejected).toEqual([]);
    expect(parsed.map((p) => p.change.kind)).toEqual(["upsert", "delete"]);
    expect(parsed.map((p) => p.record.external_id)).toEqual(["page-1", "page-1"]);
    expect(parsed[1]?.record.content).toBe("");
    expect(
      parsed.map((p) =>
        p.change.kind === "upsert" ? p.change.record.namespace : p.change.namespace,
      ),
    ).toEqual(["example-import", "example-import"]);
  });

  it("the sample imports through the local import API: one version created, then the source deleted", async () => {
    const outcome = await importContent(db, "example-import", sample);
    expect(outcome).toMatchObject({ received: 2, created: 1, tombstoned: 1, rejectedCount: 0 });
    expect("stopped" in outcome).toBe(false);
  });

  it("a sample line with a wrong content hash is refused as the text says", async () => {
    const broken = sample.replace("c0860c4c7bb6", "000000000000");
    const outcome = await importContent(db, "example-import", broken);
    expect(outcome).toMatchObject({
      received: 1,
      rejectedCount: 1,
      rejected: [{ at: "line:1", code: "content-hash-mismatch" }],
    });
  });

  it("the site-check line the text shows for a placeholder is what the command prints", async () => {
    const result = await siteCheck("site-mail", connectorKinds["site-mail"]);
    expect(result).toEqual({ ok: false, line: "site-mail: 미구현, 배포처 후속" });
    expect(DOC).toContain("site-mail: 미구현, 배포처 후속");
  });

  it("an ok kind prints `<kind>: ok` and a kind of another version prints `<kind>: unsupported-sdk-version`", async () => {
    const ok = (): Connector => ({ ...connectorKinds["site-mail"](), initialize: async () => {} });
    expect(await siteCheck("k", ok)).toEqual({ ok: true, line: "k: ok" });
    const v1 = (): Connector => {
      const c = connectorKinds["site-mail"]();
      return { ...c, manifest: { ...c.manifest, schemaVersion: 1 } };
    };
    expect(await siteCheck("k", v1)).toEqual({ ok: false, line: "k: unsupported-sdk-version" });
    expect(DOC).toContain("`<종류>: ok`");
    expect(DOC).toContain("`<종류>: unsupported-sdk-version`");
  });
});

describe("docs.connector-sdk: what the prose says of the contracts holds", () => {
  const record = {
    namespace: "",
    externalId: "a",
    revision: 1,
    schemaVersion: 2,
    title: "t",
    body: "b",
  };
  const ref = { namespace: "", externalId: "a", revision: 1, at: "2026-01-05T09:00:00Z" };

  it("a record is strict: no instance id, no data class, no synthetic or malicious mark", () => {
    expect(SourceRecordSchema.safeParse(record).success).toBe(true);
    for (const extra of ["connectorInstanceId", "classification", "synthetic", "malicious"]) {
      expect(SourceRecordSchema.safeParse({ ...record, [extra]: "x" }).success, extra).toBe(false);
    }
  });

  it("revision is an integer of 1 or more, schemaVersion is 2, accessScope is non-empty", () => {
    expect(SourceRecordSchema.safeParse({ ...record, revision: 0 }).success).toBe(false);
    expect(SourceRecordSchema.safeParse({ ...record, revision: 1.5 }).success).toBe(false);
    expect(SourceRecordSchema.safeParse({ ...record, schemaVersion: 1 }).success).toBe(false);
    expect(SourceRecordSchema.safeParse({ ...record, accessScope: [] }).success).toBe(false);
    expect(SourceRecordSchema.safeParse({ ...record, accessScope: [""] }).success).toBe(false);
    expect(SourceRecordSchema.safeParse({ ...record, accessScope: ["g"] }).success).toBe(true);
  });

  it("timestamps take an offset: the two forms the text shows pass, one without an offset fails", () => {
    for (const createdAt of ["2026-01-05T09:00:00Z", "2026-01-05T09:00:00+09:00"]) {
      expect(SourceRecordSchema.safeParse({ ...record, createdAt }).success, createdAt).toBe(true);
    }
    expect(
      SourceRecordSchema.safeParse({ ...record, createdAt: "2026-01-05T09:00:00" }).success,
    ).toBe(false);
  });

  it("a change is one of four kinds; the three without a record carry no content", () => {
    expect(ChangeSchema.safeParse({ kind: "upsert", record }).success).toBe(true);
    expect(
      ChangeSchema.safeParse({ kind: "scope-change", ...ref, accessScope: ["g"] }).success,
    ).toBe(true);
    expect(ChangeSchema.safeParse({ kind: "delete", ...ref }).success).toBe(true);
    expect(ChangeSchema.safeParse({ kind: "access-revoked", ...ref }).success).toBe(true);
    expect(ChangeSchema.safeParse({ kind: "delete", ...ref, body: "x" }).success).toBe(false);
    expect(ChangeSchema.safeParse({ kind: "scope-change", ...ref, accessScope: [] }).success).toBe(
      false,
    );
  });

  it("block ranges: sorted, no overlap, inside the body in code points, gaps allowed", () => {
    expect(
      blocksValid("abcdef", [
        { start: 0, end: 2 },
        { start: 4, end: 6 },
      ]),
    ).toBe(true);
    expect(
      blocksValid("abcdef", [
        { start: 0, end: 3 },
        { start: 2, end: 4 },
      ]),
    ).toBe(false);
    expect(
      blocksValid("abcdef", [
        { start: 4, end: 6 },
        { start: 0, end: 2 },
      ]),
    ).toBe(false);
    expect(blocksValid("abc", [{ start: 0, end: 4 }])).toBe(false);
    expect(blocksValid("\u{1F600}\u{1F600}", [{ start: 0, end: 2 }])).toBe(true);
  });

  it("a rejected position is a short kind and a number: `line:12` passes, a text does not", () => {
    expect(rejectedPositionValid("line:12")).toBe(true);
    expect(rejectedPositionValid("line:twelve")).toBe(false);
    expect(rejectedPositionValid("secret body text:1")).toBe(false);
  });

  it("a rate-limit error refuses a negative, infinite or NaN wait as a RangeError", () => {
    for (const retryAfterMs of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => new ConnectorRateLimitError("x", { retryAfterMs })).toThrow(RangeError);
    }
    expect(new ConnectorRateLimitError("x", { retryAfterMs: 0 }).retryAfterMs).toBe(0);
  });
});
