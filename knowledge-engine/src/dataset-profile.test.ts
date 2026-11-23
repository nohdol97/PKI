// S03-T04 `profile.dataset` (S03-R6, C1): the `dataset-profile` handler on a real SQLite database. A table
// source's version becomes one `Dataset` item per table, a `dataset.column` fact per header cell whose evidence
// is that cell, and one `dataset_tables` row; it calls no Provider (the handler takes no Broker); a new version
// writes into the same Dataset; a result of an older version is not written (fence). All data is synthetic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeDocument } from "@pki/document-normalize";
import {
  ANALYTICAL_CHECK_JOB_KIND,
  closeJob,
  DATASET_PROFILE_KIND,
  findDatasetTable,
  leaseNextJob,
  listEvidence,
  listOntologyElements,
  migrate,
  readEvidenceSource,
  readItem,
  registerConnectorInstance,
  registerJob,
  registerDatasetProfileJob,
  saveSourceRecord,
  setAnalyticalProfile,
  writeSetting,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { csvVersion, setOntologyStatusForTest, type StoredTableVersion } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatasetProfileHandler } from "./dataset-profile.ts";
import { propagateNewVersion } from "./propagation.ts";

const FIXTURES = fileURLToPath(new URL("../../fixtures/documents/", import.meta.url));
const T0 = new Date("2026-11-23T00:00:00.000Z");

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  setAnalyticalProfile(db, true, T0);
});
afterEach(() => db.close());

async function normalized(name: string): Promise<StoredTableVersion> {
  const result = await normalizeDocument({
    kind: "bytes",
    bytes: readFileSync(FIXTURES + name),
    name,
  });
  if (!result.ok) throw new Error(`${name}: ${result.error.code}`);
  const { text, blocks, limitations } = result.document;
  return { body: text, blocks, limitations: limitations.map((l) => l.code) };
}

/** An XLSX version built by hand: one sheet, `A1`-style addresses, a block per non-empty cell. */
function xlsxVersion(sheet: string, rows: readonly (readonly string[])[]): StoredTableVersion {
  let body = "";
  let length = 0;
  const blocks: unknown[] = [];
  rows.forEach((record, r) =>
    record.forEach((field, c) => {
      if (field === "") return;
      if (blocks.length > 0) {
        body += c === 0 ? "\n" : "\t";
        length += 1;
      }
      const start = length;
      body += field;
      length += Array.from(field).length;
      blocks.push({
        start,
        end: length,
        locator: {
          format: "xlsx",
          sheet,
          cell: `${String.fromCharCode(65 + c)}${r + 1}`,
          row: r + 1,
          column: c + 1,
        },
      });
    }),
  );
  return { body, blocks, limitations: [] };
}

/** Stores `version` as the next version of source `id`, as the page store does: propagation, then the job. */
function arrive(id: string, title: string, version: StoredTableVersion) {
  const saved = saveSourceRecord(db, "c1", {
    namespace: "",
    externalId: id,
    title,
    body: version.body,
    ...(version.blocks ? { blocks: version.blocks } : {}),
    provenance: { metadata: { limitations: [...version.limitations] } },
  } as Parameters<typeof saveSourceRecord>[2]);
  if (saved.status !== "created") throw new Error(`not stored: ${saved.status}`);
  propagateNewVersion(db, saved.sourceId);
  registerDatasetProfileJob(db, { sourceId: saved.sourceId, version: saved.version, at: T0 });
  return { sourceId: saved.sourceId, version: saved.version };
}

const handler = (job: StoredJob) => createDatasetProfileHandler({ db, now: () => T0 })(job);
async function runNext(): Promise<{ job: StoredJob; status: string }> {
  const job = leaseNextJob(db, { kinds: [DATASET_PROFILE_KIND], now: T0, leaseMs: 60_000 });
  if (!job) throw new Error("no job queued");
  const result = await handler(job);
  if (result.status !== "succeeded") return { job, status: result.status };
  return { job, status: closeJob(db, job, result) };
}

const items = () => db.all("SELECT id, type, name, status, epistemic FROM items ORDER BY id");
const columns = (itemId?: number) =>
  db
    .all(
      `SELECT id, item_id, value, status, epistemic FROM facts WHERE kind = 'dataset.column'
         ${itemId === undefined ? "" : `AND item_id = ${itemId}`} ORDER BY id`,
    )
    .map(
      (r) =>
        r as unknown as {
          id: number;
          item_id: number;
          value: string;
          status: string;
          epistemic: string;
        },
    );
const tables = () =>
  db.all("SELECT item_id, source_id, table_key, row_count FROM dataset_tables ORDER BY id");

describe("profile.dataset: a CSV file", () => {
  it("makes the Dataset, a column fact per header cell on that cell, and the table row", async () => {
    const ref = arrive(
      "sales",
      "주문표",
      csvVersion([
        ["Order ID", "Amount Due"],
        ["1", "10"],
        ["2", "20"],
      ]),
    );
    expect((await runNext()).status).toBe("succeeded");
    expect(items()).toEqual([
      { id: 1, type: "Dataset", name: "주문표", status: "candidate", epistemic: "explicit" },
    ]);
    // the value is the processed name; the quote is the original text of the header cell
    expect(columns().map((c) => [c.value, c.status, c.epistemic])).toEqual([
      ["order id", "candidate", "explicit"],
      ["amount due", "candidate", "explicit"],
    ]);
    for (const [i, quote] of ["Order ID", "Amount Due"].entries()) {
      const [evidence] = listEvidence(db, { factId: (columns()[i] as { id: number }).id });
      expect(evidence).toMatchObject({ quote, current: true });
      const view = readEvidenceSource(db, evidence?.id as number);
      expect(view?.locator).toEqual({ format: "csv", record: 1, line: 1, field: i + 1 });
    }
    expect(tables()).toEqual([
      { item_id: 1, source_id: ref.sourceId, table_key: "", row_count: 2 },
    ]);
    expect(findDatasetTable(db, ref.sourceId, "")).toEqual({ itemId: 1, rowCount: 2 });
  });

  it("writes the lifecycle line of an automated actor: extraction, no user action", async () => {
    arrive(
      "sales",
      "주문표",
      csvVersion([
        ["a", "b"],
        ["1", "2"],
      ]),
    );
    await runNext();
    expect(db.all("SELECT actor, action FROM fact_history ORDER BY fact_id, seq")).toEqual([
      { actor: "extraction", action: "created" },
      { actor: "extraction", action: "created" },
    ]);
    expect(db.all("SELECT actor, action FROM item_history")).toEqual([
      { actor: "extraction", action: "created" },
    ]);
  });

  it("drops the title row above the header and reads the header cell's own place", async () => {
    arrive("q", "보고", await normalized("table-csv-title-above.csv"));
    await runNext();
    expect(columns().map((c) => c.value)).toEqual(["이름", "수량"]);
    const [evidence] = listEvidence(db, { factId: (columns()[0] as { id: number }).id });
    expect(readEvidenceSource(db, evidence?.id as number)?.locator).toEqual({
      format: "csv",
      record: 2,
      line: 2,
      field: 1,
    });
  });
});

describe("profile.dataset: a workbook", () => {
  it("makes one Dataset per sheet named `title:sheet`, and the cell address is the evidence's place", async () => {
    const ref = arrive("book", "분기표", await normalized("table-xlsx-two-sheets.xlsx"));
    await runNext();
    expect(items().map((i) => i.name)).toEqual(["분기표:매출", "분기표:재고"]);
    expect(tables()).toEqual([
      { item_id: 1, source_id: ref.sourceId, table_key: "매출", row_count: 2 },
      { item_id: 2, source_id: ref.sourceId, table_key: "재고", row_count: 1 },
    ]);
    expect(columns(1).map((c) => c.value)).toEqual(["월", "금액", "메모"]);
    expect(columns(2).map((c) => c.value)).toEqual(["품목", "수량"]);
    const [evidence] = listEvidence(db, { factId: (columns(1)[1] as { id: number }).id });
    expect(evidence?.quote).toBe("금액");
    expect(readEvidenceSource(db, evidence?.id as number)?.locator).toMatchObject({
      format: "xlsx",
      sheet: "매출",
      cell: "B2", // the fixture has a title row above its header
    });
  });

  it("names the Dataset `title:sheet` for a workbook of one sheet too", async () => {
    arrive(
      "book",
      "단일",
      xlsxVersion("Sheet1", [
        ["a", "b"],
        ["1", "2"],
      ]),
    );
    await runNext();
    expect(items().map((i) => i.name)).toEqual(["단일:Sheet1"]);
    const [evidence] = listEvidence(db, { factId: (columns()[0] as { id: number }).id });
    expect(readEvidenceSource(db, evidence?.id as number)?.locator).toMatchObject({
      sheet: "Sheet1",
      cell: "A1",
    });
  });

  it("a hidden sheet is a table too (the limitation is the workbook's, not a sheet's)", async () => {
    arrive("book", "숨김", await normalized("table-xlsx-hidden-sheet.xlsx"));
    await runNext();
    expect(tables().map((t) => t.table_key)).toEqual(["공개", "숨김"]);
  });
});

describe("profile.dataset: what is not a table", () => {
  it("writes nothing for a sheet with no header and for one with no rows", async () => {
    arrive("nohead", "머리 없음", await normalized("table-csv-number-first-row.csv"));
    arrive("norows", "자료 없음", await normalized("table-csv-no-rows.csv"));
    expect((await runNext()).status).toBe("succeeded");
    expect((await runNext()).status).toBe("succeeded");
    expect(items()).toEqual([]);
    expect(columns()).toEqual([]);
    expect(tables()).toEqual([]);
  });

  it("writes nothing for a job fenced to a version that is prose (the version stopped being a table)", async () => {
    const prose = saveSourceRecord(db, "c1", {
      namespace: "",
      externalId: "prose",
      title: "글",
      body: "일반 문장",
      blocks: [{ start: 0, end: 5, locator: { format: "txt", line: 1 } }],
    } as Parameters<typeof saveSourceRecord>[2]);
    if (prose.status !== "created") throw new Error("not stored");
    registerJob(db, {
      kind: DATASET_PROFILE_KIND,
      sourceId: prose.sourceId,
      fenceVersion: prose.version,
      at: T0,
    });
    expect((await runNext()).status).toBe("succeeded");
    expect(items()).toEqual([]);
    expect(tables()).toEqual([]);
  });

  it("fails a job whose version is not stored, with a code and nothing written", async () => {
    const ref = arrive(
      "sales",
      "주문표",
      csvVersion([
        ["a", "b"],
        ["1", "2"],
      ]),
    );
    const job = leaseNextJob(db, {
      kinds: [DATASET_PROFILE_KIND],
      now: T0,
      leaseMs: 60_000,
    }) as StoredJob;
    expect(await handler({ ...job, fenceVersion: ref.version + 5 })).toEqual({
      status: "fail",
      code: "missing-version",
      retryable: false,
    });
    expect(items()).toEqual([]);
  });
});

describe("profile.dataset: the switch is read when the job runs", () => {
  it("writes nothing for a job queued while ON and run after the switch went OFF", async () => {
    arrive(
      "sales",
      "주문표",
      csvVersion([
        ["a", "b"],
        ["1", "2"],
      ]),
    );
    setAnalyticalProfile(db, false, T0);
    expect((await runNext()).status).toBe("succeeded");
    expect(items()).toEqual([]);
    expect(columns()).toEqual([]);
    expect(tables()).toEqual([]);
    // switched ON again, the same version profiles when it is queued again
    setAnalyticalProfile(db, true, T0);
    db.run("DELETE FROM jobs");
    expect(registerDatasetProfileJob(db, { sourceId: 1, version: 1, at: T0 })).toBe(true);
    await runNext();
    expect(tables()).toHaveLength(1);
  });
});

describe("check.job: the profile hands over to the check job", () => {
  const checkJobs = () =>
    db.all("SELECT source_id, fence_version, status FROM jobs WHERE kind = ?", [
      ANALYTICAL_CHECK_JOB_KIND,
    ]);

  it("check.job: the profile's closing transaction queues the check job of its source", async () => {
    const ref = arrive(
      "sales",
      "주문표",
      csvVersion([
        ["a", "b"],
        ["1", "2"],
      ]),
    );
    expect(checkJobs()).toEqual([]);
    await runNext();
    expect(checkJobs()).toEqual([
      { source_id: ref.sourceId, fence_version: ref.version, status: "queued" },
    ]);
  });

  it("check.job: a profile that writes nothing because the switch is OFF queues none", async () => {
    arrive(
      "sales",
      "주문표",
      csvVersion([
        ["a", "b"],
        ["1", "2"],
      ]),
    );
    setAnalyticalProfile(db, false, T0);
    await runNext();
    expect(checkJobs()).toEqual([]);
  });
});

describe("profile.dataset: size", () => {
  it("runs on a table far over the extraction's 20,000 code points", async () => {
    const rows: string[][] = [["id", "value"]];
    for (let i = 0; i < 6000; i++) rows.push([`row-${i}`, `v${i}`]);
    const version = csvVersion(rows);
    expect(Array.from(version.body).length).toBeGreaterThan(20_000);
    const ref = arrive("big", "큰 표", version);
    expect((await runNext()).status).toBe("succeeded");
    expect(findDatasetTable(db, ref.sourceId, "")?.rowCount).toBe(6000);
  });

  it("makes no Dataset for a table over analytical.maxCells, and one once the limit allows it", async () => {
    writeSetting(db, "analytical.maxCells", "5");
    const ref = arrive(
      "sales",
      "주문표",
      csvVersion([
        ["a", "b"],
        ["1", "2"],
        ["3", "4"],
      ]),
    );
    await runNext();
    expect(items()).toEqual([]);
    writeSetting(db, "analytical.maxCells", "6");
    // the same version again, as a switch from OFF to ON would queue it
    db.run("DELETE FROM jobs");
    expect(registerDatasetProfileJob(db, { ...ref, at: T0 })).toBe(true);
    await runNext();
    expect(tables().map((t) => t.row_count)).toEqual([2]);
  });
});

describe("profile.dataset: a new version", () => {
  it("writes into the same Dataset: no new item, the name stays, a kept column returns to candidate", async () => {
    const ref = arrive(
      "sales",
      "주문표",
      csvVersion([
        ["a", "b"],
        ["1", "2"],
      ]),
    );
    await runNext();
    const before = columns();
    // the file is renamed and one column is dropped: the title may change, the item's name must not
    const next = arrive(
      "sales",
      "주문표 개정",
      csvVersion([
        ["a", "c"],
        ["1", "2"],
        ["3", "4"],
      ]),
    );
    expect(next.version).toBe(ref.version + 1);
    // the propagation already ran: the dropped column (and the kept one) lost current evidence
    expect(columns().map((c) => [c.value, c.status])).toEqual([
      ["a", "superseded"],
      ["b", "superseded"],
    ]);
    await runNext();
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ name: "주문표" });
    expect(tables()).toEqual([
      { item_id: 1, source_id: ref.sourceId, table_key: "", row_count: 2 },
    ]);
    const after = columns();
    expect(after.map((c) => [c.value, c.status])).toEqual([
      ["a", "candidate"], // the same fact, its evidence now on the new version
      ["b", "superseded"], // the column that vanished stays superseded
      ["c", "candidate"],
    ]);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(readItem(db, 1)?.name).toBe("주문표");
  });

  it("writes nothing of a version a newer one replaced before the job closed (the fence)", async () => {
    arrive(
      "sales",
      "주문표",
      csvVersion([
        ["a", "b"],
        ["1", "2"],
      ]),
    );
    const job = leaseNextJob(db, {
      kinds: [DATASET_PROFILE_KIND],
      now: T0,
      leaseMs: 60_000,
    }) as StoredJob;
    const result = await handler(job);
    expect(result.status).toBe("succeeded");
    // a new version arrives while the first was being read
    arrive(
      "sales",
      "주문표",
      csvVersion([
        ["a", "b", "c"],
        ["1", "2", "3"],
      ]),
    );
    if (result.status !== "succeeded") throw new Error("unreachable");
    expect(closeJob(db, job, result)).toBe("superseded");
    expect(items()).toEqual([]);
    expect(columns()).toEqual([]);
    expect(tables()).toEqual([]);
  });
});

describe("profile.dataset: the type definitions (S01-R21)", () => {
  const idOf = (name: string) =>
    listOntologyElements(db).find((e) => e.name === name)?.id as number;

  it.each([["Dataset"], ["dataset.column"]])(
    "writes nothing while %s is not a verified definition",
    async (name) => {
      setOntologyStatusForTest(db, idOf(name), "rejected");
      arrive(
        "sales",
        "주문표",
        csvVersion([
          ["a", "b"],
          ["1", "2"],
        ]),
      );
      expect((await runNext()).status).toBe("succeeded");
      expect(items()).toEqual([]);
      expect(columns()).toEqual([]);
      expect(tables()).toEqual([]);
    },
  );

  it("drops a header cell whose processed name is over 200 code points, and writes the others", async () => {
    arrive(
      "sales",
      "주문표",
      csvVersion([
        ["a".repeat(201), "b"],
        ["1", "2"],
      ]),
    );
    await runNext();
    expect(columns().map((c) => c.value)).toEqual(["b"]);
  });
});
