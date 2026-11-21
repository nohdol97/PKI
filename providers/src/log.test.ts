// V01-R13 log filtering: a log line carries codes, numbers and booleans only. Free
// text (which may be a CLI's or server's echo of the input) is replaced, and an
// error is named by a known class, never by its message or a crafted name.
import { AdapterUnavailableError, ProviderError } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { ModelFileError } from "./adapters/model-files.ts";
import { createLogger, errorClass } from "./log.ts";

const CANARY = "Document body CANARY-7f3 and the prompt";

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger((line) => lines.push(line)) };
}

describe("createLogger", () => {
  it("writes one JSON line of the event and its code-like fields", () => {
    const { lines, log } = capture();
    log("route-failed", { route: "status", error: "TypeError", status: 500, retry: false });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: "route-failed", route: "status", error: "TypeError", status: 500, retry: false },
    ]);
  });

  it("replaces free text in values, keys and the event name", () => {
    const { lines, log } = capture();
    log(CANARY, { [CANARY]: 1, detail: CANARY, path: "/tmp/x y", long: "a".repeat(65) });
    expect(lines.join("\n")).not.toContain("CANARY");
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      event: "[redacted]",
      detail: "[redacted]",
      path: "[redacted]",
      long: "[redacted]",
    });
  });
});

describe("errorClass", () => {
  it("names known classes and nothing from the message", () => {
    expect(errorClass(new TypeError(CANARY))).toBe("TypeError");
    expect(errorClass(new ProviderError(CANARY, { retryable: true }))).toBe("ProviderError");
  });

  it("names the embedder's preparation failures (V01-T14)", () => {
    expect(errorClass(new AdapterUnavailableError(CANARY))).toBe("AdapterUnavailableError");
    expect(errorClass(new ModelFileError("model file missing"))).toBe("ModelFileError");
  });

  it("does not repeat a crafted name or a thrown string", () => {
    const crafted = new Error("x");
    crafted.name = CANARY;
    expect(errorClass(crafted)).toBe("other");
    expect(errorClass(CANARY)).toBe("other");
    expect(errorClass(undefined)).toBe("other");
  });
});
