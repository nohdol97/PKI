// I01-R20 `sync.outcome-map`: the constant SYNC_OUTCOMES is the I03 result table of
// the spec, row for row. The table is read from the spec, so a row changed on one
// side only fails here.
import { SYNC_STOP_CODES } from "@pki/contracts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTANCE_BUSY_RETRY_MS,
  SYNC_OUTCOMES,
  type SyncEnd,
  type SyncOutcomeRow,
} from "./index.ts";

const SPEC = readFileSync(
  resolve(import.meta.dirname, "../../../docs/specs/2026-11-21-I01-connector-sdk.md"),
  "utf8",
);
const lines = SPEC.split("\n").map((l) => l.trim());

/** The spec's words for a row's end, a cell's text and the next run, as the constant's keys. */
const NEXT_RUN: Record<string, SyncOutcomeRow["nextRun"]> = {
  "다음 주기": "next-period",
  "I03 backoff와 결과의 `retryAfterMs` 가운데 늦은 쪽": "backoff-or-retry-after",
  "I03 backoff": "backoff",
  "1분 뒤": "one-minute",
  없음: "none",
  "그 인스턴스의 설정이 바뀌거나 앱이 갱신될 때, 그리고 I03의 시간당 묶음 재점검":
    "settings-change-or-hourly-recheck",
};
const ATTEMPT: Record<string, SyncOutcomeRow["attempt"]> = {
  씀: "spent",
  "쓰지 않음": "unspent",
  "**쓰지 않음**": "unspent",
  "—": "n/a",
};

function endKey(cell: string): string {
  if (cell.startsWith("멈추지 않고 끝남")) return "completed";
  if (cell.startsWith("인스턴스가")) return /`([a-z-]+)`/.exec(cell)?.[1] as string;
  return cell.replaceAll("`", "");
}

function docRows(): SyncOutcomeRow[] {
  const header = lines.findIndex((l) => l.startsWith("| 동기화의 끝 | I03 결과 |"));
  expect(header).toBeGreaterThan(0);
  const rows: SyncOutcomeRow[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const [end, result, attempt, next] = cells as [string, string, string, string];
    const exhausted = /시도가 다하면 `([a-z_]+)`/.exec(result)?.[1];
    const nextRun = NEXT_RUN[next];
    const spent = ATTEMPT[attempt];
    if (nextRun === undefined || spent === undefined) {
      throw new Error(`the spec's table has a cell this test cannot read: ${line}`);
    }
    rows.push({
      end: endKey(end) as SyncEnd,
      result: /^`([a-z_]+)`/.exec(result)?.[1] as SyncOutcomeRow["result"],
      attempt: spent,
      ...(exhausted ? { exhaustedResult: exhausted as "dead_letter" } : {}),
      nextRun,
    });
  }
  return rows;
}

describe("sync.outcome-map", () => {
  it("① equals the I01-R20 table of the spec, row by row", () => {
    const rows = docRows();
    expect(rows).toHaveLength(12);
    expect(SYNC_OUTCOMES).toEqual(rows);
  });

  it("② has a row for every stop code of I01-R19 (read from the spec) and both instance states", () => {
    const line = lines.find((l) => l.includes("**멈춤**:")) as string;
    const list = (line.split("**멈춤**:")[1] as string).split(".")[0] as string;
    const codes = [...list.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
    expect([...SYNC_STOP_CODES]).toEqual(codes);
    const ends = SYNC_OUTCOMES.map((r) => r.end);
    for (const code of SYNC_STOP_CODES) expect(ends.filter((e) => e === code)).toHaveLength(1);
    for (const state of ["completed", "unavailable", "not-implemented"]) {
      expect(ends.filter((e) => e === state)).toHaveLength(1);
    }
    expect(ends).toHaveLength(SYNC_STOP_CODES.length + 3);
  });

  it("③ every result is retry, held, dead_letter or done", () => {
    for (const row of SYNC_OUTCOMES) {
      expect(["retry", "held", "dead_letter", "done"]).toContain(row.result);
    }
  });

  const row = (end: string) => SYNC_OUTCOMES.find((r) => r.end === end) as SyncOutcomeRow;

  it("④ instance-busy does not spend an attempt and runs again a minute later", () => {
    expect(row("instance-busy")).toMatchObject({
      result: "retry",
      attempt: "unspent",
      nextRun: "one-minute",
    });
    expect(INSTANCE_BUSY_RETRY_MS).toBe(60_000);
  });

  it("⑤ storage-failed is a retry that spends an attempt and ends as dead_letter when they run out", () => {
    expect(row("storage-failed")).toMatchObject({
      result: "retry",
      attempt: "spent",
      exhaustedResult: "dead_letter",
    });
  });

  it("⑥ an unavailable or not-implemented instance is held, spending no attempt", () => {
    for (const end of ["unavailable", "not-implemented"]) {
      expect(row(end)).toMatchObject({ result: "held", attempt: "unspent" });
    }
  });
});
