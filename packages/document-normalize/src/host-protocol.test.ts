// The host is the untrusted side (I02B-R23): its result is rebuilt against the NormalizeResult shape with
// caps, and a misfit is `invalid`. The cases are the reviewer's: an object with an injected field and a
// 16 MiB string, plus every kind of wrong shape.
import { describe, expect, it } from "vitest";
import {
  parseFromHost,
  parseNormalizeResult,
  resultCaps,
  type ResultCaps,
} from "./host-protocol.ts";
import { DEFAULT_LIMITS, resolveLimits } from "./limits.ts";
import { normalizeDocument } from "./normalize.ts";
import { generateFixtures } from "./testing/generate-fixtures.ts";

const CAPS = resultCaps(DEFAULT_LIMITS);
const parse = (raw: unknown, caps: ResultCaps = CAPS) => parseNormalizeResult(raw, caps);
const parseHost = (raw: unknown, caps: ResultCaps = CAPS) => parseFromHost(raw, caps);

const doc = (over: Record<string, unknown> = {}) => ({
  format: "markdown",
  text: "x",
  blocks: [{ start: 0, end: 1, locator: { format: "markdown", line: 1, node: "paragraph" } }],
  metadata: {},
  limitations: [],
  ...over,
});
const ok = (document: unknown) => ({ ok: true, document });

describe("parseNormalizeResult", () => {
  it("passes every real result of the fixtures through unchanged", async () => {
    let seen = 0;
    for (const [name, bytes] of generateFixtures()) {
      const result = await normalizeDocument({ kind: "bytes", bytes, name });
      expect(parse(result), name).toEqual(result);
      seen++;
    }
    expect(seen).toBeGreaterThan(20);
  });

  it("carries no field the shape does not have: an injected field is a misfit, not a pass-through", () => {
    expect(parse({ ...ok(doc()), injected: { path: "/etc/passwd" } })).toBeUndefined();
    expect(parse(ok(doc({ injected: 1 })))).toBeUndefined();
    expect(parse(ok(doc({ metadata: { extra: "x" } })))).toBeUndefined();
    expect(
      parse(
        ok(
          doc({
            blocks: [
              { start: 0, end: 1, locator: { format: "markdown", line: 1, node: "p", x: 1 } },
            ],
          }),
        ),
      ),
    ).toBeUndefined();
    expect(
      parse({ ok: false, error: { code: "corrupt", message: "m", path: "/etc" } }),
    ).toBeUndefined();
  });

  it("rebuilds the result: what comes back is a new object", () => {
    const raw = ok(doc());
    const parsed = parse(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
  });

  it.each([
    ["blocks that are not an array", ok(doc({ blocks: "not-an-array" }))],
    ["a format that is not a format", ok(doc({ format: "exe" }))],
    ["a text that is not a string", ok(doc({ text: 5 }))],
    [
      "a block with a negative start",
      ok(doc({ blocks: [{ start: -1, end: 1, locator: { format: "txt", line: 1 } }] })),
    ],
    [
      "a locator of an unknown format",
      ok(doc({ blocks: [{ start: 0, end: 1, locator: { format: "zip", line: 1 } }] })),
    ],
    ["a limitation code that is not in the table", ok(doc({ limitations: [{ code: "evil" }] }))],
    ["an error code that is not one", { ok: false, error: { code: "timed-out", message: "m" } }],
    ["ok that is not a boolean", { ok: "yes", document: doc() }],
    ["null", null],
    ["a string", "ok"],
  ])("rejects %s", (_name, raw) => {
    expect(parse(raw)).toBeUndefined();
  });

  it("bounds sizes: a 16 MiB string where a short one belongs", () => {
    const sixteen = "x".repeat(16 * 1024 ** 2);
    expect(parse(ok(doc({ metadata: { title: sixteen } })))).toBeUndefined();
    expect(parse({ ok: false, error: { code: "corrupt", message: sixteen } })).toBeUndefined();
    expect(
      parse(
        ok(doc({ blocks: [{ start: 0, end: 1, locator: { format: "xlsx", sheet: sixteen } }] })),
      ),
    ).toBeUndefined();
    // a text up to the normalizer's own input limit is a legitimate output
    expect(parse(ok(doc({ text: sixteen })))).toBeDefined();
  });
});

describe("parseFromHost", () => {
  it("a result message with a misfit result is `invalid`, not a result and not dropped silently", () => {
    expect(
      parseHost({ type: "result", id: 1, result: { ok: true, document: { blocks: "x" } } }),
    ).toEqual({
      type: "invalid",
    });
    expect(parseHost({ type: "result", id: "1", result: ok(doc()) })).toEqual({
      type: "invalid",
    });
  });

  it("a result message that fits carries only the rebuilt result", () => {
    expect(parseHost({ type: "result", id: 3, result: ok(doc()), extra: 1 })).toEqual({
      type: "result",
      id: 3,
      result: ok(doc()),
    });
  });
});

const block = (start: number, end: number) => ({
  start,
  end,
  locator: { format: "txt", line: 1 },
});

describe("the caps follow the job's limits (I02B-R23)", () => {
  it("the text cap is what the job may read in or inflate: the larger of maxFileBytes and zip.maxTotalBytes", () => {
    const small = resultCaps(resolveLimits({ maxFileBytes: 1_000, zip: { maxTotalBytes: 2_000 } }));
    expect(small.maxText).toBe(2_000);
    expect(
      resultCaps(resolveLimits({ maxFileBytes: 3_000, zip: { maxTotalBytes: 2_000 } })).maxText,
    ).toBe(3_000);
    const text = (n: number) => ok(doc({ format: "txt", text: "x".repeat(n), blocks: [] }));
    expect(parse(text(2_000), small)).toBeDefined();
    expect(parse(text(2_001), small)).toBeUndefined();
  });

  it("a legitimate maximum for raised limits passes: a 51 MiB single line with maxFileBytes 60 MiB; the default cap refuses it only for the default job", () => {
    const line = "x".repeat(51 * 1024 ** 2);
    const result = ok(doc({ format: "txt", text: line, blocks: [block(0, line.length)] }));
    expect(
      parse(result, resultCaps(resolveLimits({ maxFileBytes: 60 * 1024 ** 2 }))),
    ).toBeDefined();
  });

  it("a text longer than anything the limits let in is refused: just over the cap fails", () => {
    const caps = resultCaps(resolveLimits({ maxFileBytes: 10, zip: { maxTotalBytes: 10 } }));
    expect(parse(ok(doc({ format: "txt", text: "x".repeat(10), blocks: [] })), caps)).toBeDefined();
    expect(
      parse(ok(doc({ format: "txt", text: "x".repeat(11), blocks: [] })), caps),
    ).toBeUndefined();
  });

  it("the number of blocks follows the text, not a constant: one block per code unit passes, one more fails", () => {
    const n = 5_000;
    const text = "x".repeat(n);
    const blocks = Array.from({ length: n }, (_, i) => block(i, i + 1));
    expect(parse(ok(doc({ format: "txt", text, blocks })))).toBeDefined();
    // one block more than the text has code units, plus one for an empty document's single empty block
    const tooMany = [...blocks, block(0, 0), block(0, 0)];
    expect(parse(ok(doc({ format: "txt", text, blocks: tooMany })))).toBeUndefined();
  });
});

describe("blocks and arrays are checked for sense (I02B-R23)", () => {
  it("a block needs start <= end <= the text's length (code points are never more than code units)", () => {
    const withBlock = (b: unknown) => ok(doc({ format: "txt", text: "abc", blocks: [b] }));
    expect(parse(withBlock(block(0, 3)))).toBeDefined();
    expect(parse(withBlock(block(2, 1)))).toBeUndefined();
    expect(parse(withBlock(block(0, 4)))).toBeUndefined();
    expect(parse(withBlock(block(9e15, 5)))).toBeUndefined();
  });

  it("a sparse array is refused: holes in sheetNames and in the pages of a limitation", () => {
    const holes = ["a", "b", "c"];
    delete holes[1];
    const pages = [1, 2, 3];
    delete pages[1];
    expect(parse(ok(doc({ metadata: { sheetNames: holes } })))).toBeUndefined();
    expect(
      parse(ok(doc({ limitations: [{ code: "pdf.page-without-text", pages }] }))),
    ).toBeUndefined();
    expect(parse(ok(doc({ metadata: { sheetNames: ["a", "b"] } })))).toBeDefined();
  });
});

describe("the cost of the check (I02B-R22: the backend's event loop is not held)", () => {
  // PROVISIONAL threshold: the check of a large but legitimate result (a spreadsheet of 250,000 cells) is
  // synchronous in the backend's main thread; it must not hold it for long. Measured cost in the PR.
  const BLOCKS = 250_000;
  // the best of three, so a busy machine does not decide it; the earlier per-block check took 1,441 ms here
  const THRESHOLD_MS = 1_000;

  it("validating a result of 250,000 blocks holds the event loop for less than the threshold", () => {
    const text = "x".repeat(BLOCKS);
    const blocks = Array.from({ length: BLOCKS }, (_, i) => ({
      start: i,
      end: i + 1,
      locator: { format: "xlsx", sheet: "S1", cell: `A${i}`, row: i, column: 1 },
    }));
    const result = ok(doc({ format: "xlsx", text, blocks }));
    let ms = Infinity;
    let parsed;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      parsed = parse(result);
      ms = Math.min(ms, performance.now() - started);
    }
    expect(parsed).toBeDefined();
    expect(ms).toBeLessThan(THRESHOLD_MS);
  });
});
