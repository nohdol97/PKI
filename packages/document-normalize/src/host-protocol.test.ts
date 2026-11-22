// The host is the untrusted side (I02B-R23): its result is rebuilt against the NormalizeResult shape with
// caps, and a misfit is `invalid`. The cases are the reviewer's: an object with an injected field and a
// 16 MiB string, plus every kind of wrong shape.
import { describe, expect, it } from "vitest";
import { parseFromHost, parseNormalizeResult } from "./host-protocol.ts";
import { normalizeDocument } from "./normalize.ts";
import { generateFixtures } from "./testing/generate-fixtures.ts";

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
      expect(parseNormalizeResult(result), name).toEqual(result);
      seen++;
    }
    expect(seen).toBeGreaterThan(20);
  });

  it("carries no field the shape does not have: an injected field is a misfit, not a pass-through", () => {
    expect(
      parseNormalizeResult({ ...ok(doc()), injected: { path: "/etc/passwd" } }),
    ).toBeUndefined();
    expect(parseNormalizeResult(ok(doc({ injected: 1 })))).toBeUndefined();
    expect(parseNormalizeResult(ok(doc({ metadata: { extra: "x" } })))).toBeUndefined();
    expect(
      parseNormalizeResult(
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
      parseNormalizeResult({ ok: false, error: { code: "corrupt", message: "m", path: "/etc" } }),
    ).toBeUndefined();
  });

  it("rebuilds the result: what comes back is a new object", () => {
    const raw = ok(doc());
    const parsed = parseNormalizeResult(raw);
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
    expect(parseNormalizeResult(raw)).toBeUndefined();
  });

  it("bounds sizes: a 16 MiB string where a short one belongs, a text over the input limit, too many blocks", () => {
    const sixteen = "x".repeat(16 * 1024 ** 2);
    expect(parseNormalizeResult(ok(doc({ metadata: { title: sixteen } })))).toBeUndefined();
    expect(
      parseNormalizeResult({ ok: false, error: { code: "corrupt", message: sixteen } }),
    ).toBeUndefined();
    expect(
      parseNormalizeResult(
        ok(doc({ blocks: [{ start: 0, end: 1, locator: { format: "xlsx", sheet: sixteen } }] })),
      ),
    ).toBeUndefined();
    expect(parseNormalizeResult(ok(doc({ text: "x".repeat(52_428_801) })))).toBeUndefined();
    // a text up to the normalizer's own input limit is a legitimate output
    expect(parseNormalizeResult(ok(doc({ text: sixteen })))).toBeDefined();
  });
});

describe("parseFromHost", () => {
  it("a result message with a misfit result is `invalid`, not a result and not dropped silently", () => {
    expect(
      parseFromHost({ type: "result", id: 1, result: { ok: true, document: { blocks: "x" } } }),
    ).toEqual({
      type: "invalid",
    });
    expect(parseFromHost({ type: "result", id: "1", result: ok(doc()) })).toEqual({
      type: "invalid",
    });
  });

  it("a result message that fits carries only the rebuilt result", () => {
    expect(parseFromHost({ type: "result", id: 3, result: ok(doc()), extra: 1 })).toEqual({
      type: "result",
      id: 3,
      result: ok(doc()),
    });
  });
});
