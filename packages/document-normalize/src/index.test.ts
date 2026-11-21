// The public surface named in the I02A spec's interface section.
import { describe, expect, it } from "vitest";
import * as api from "./index.ts";

describe("public entry", () => {
  it("exports the function, helper and constants", () => {
    expect(typeof api.normalizeDocument).toBe("function");
    expect(typeof api.codePointSlice).toBe("function");
    expect(api.DEFAULT_LIMITS.maxFileBytes).toBe(52_428_800);
    expect(api.LIMITATION_CODES).toContain("text.encoding-fallback");
    expect(api.NORMALIZE_ERROR_CODES).toContain("zip-limit");
    expect(api.DOCUMENT_FORMATS).toHaveLength(8);
  });
});
