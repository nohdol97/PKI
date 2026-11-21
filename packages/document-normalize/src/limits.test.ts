// I02A-C11 / R19: limits are configuration; bad values are caller bugs (TypeError).
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, resolveLimits } from "./limits.ts";

describe("DEFAULT_LIMITS", () => {
  it("has the spec's local defaults", () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxFileBytes: 52_428_800,
      zip: {
        maxEntries: 5_000,
        maxEntryBytes: 33_554_432,
        maxTotalBytes: 134_217_728,
        maxRatio: 200,
        ratioMinBytes: 1_048_576,
      },
      pdf: { maxPages: 2_000 },
      encoding: { fallbackMaxForeignRatio: 0.1 },
    });
  });

  it("cannot be mutated by a caller", () => {
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LIMITS.zip)).toBe(true);
  });
});

describe("resolveLimits", () => {
  it("returns the defaults without an override", () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits({})).toEqual(DEFAULT_LIMITS);
  });

  it("overrides only the given values, nested ones included", () => {
    const limits = resolveLimits({ maxFileBytes: 10, zip: { maxEntries: 3 } });
    expect(limits.maxFileBytes).toBe(10);
    expect(limits.zip).toEqual({ ...DEFAULT_LIMITS.zip, maxEntries: 3 });
    expect(limits.pdf).toEqual(DEFAULT_LIMITS.pdf);
    expect(DEFAULT_LIMITS.maxFileBytes).toBe(52_428_800);
  });

  it("allows fractional ratios", () => {
    const limits = resolveLimits({
      zip: { maxRatio: 12.5 },
      encoding: { fallbackMaxForeignRatio: 0.25 },
    });
    expect(limits.zip.maxRatio).toBe(12.5);
    expect(limits.encoding.fallbackMaxForeignRatio).toBe(0.25);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["fractional bytes", 10.5],
    ["infinite", Number.POSITIVE_INFINITY],
    ["a string", "10" as unknown as number],
  ])("rejects %s for a whole-number limit with TypeError", (_name, value) => {
    expect(() => resolveLimits({ maxFileBytes: value })).toThrow(TypeError);
    expect(() => resolveLimits({ zip: { maxEntries: value } })).toThrow(TypeError);
    expect(() => resolveLimits({ pdf: { maxPages: value } })).toThrow(TypeError);
  });

  it("rejects a bad ratio, and a foreign-character ratio above 1", () => {
    expect(() => resolveLimits({ zip: { maxRatio: 0 } })).toThrow(TypeError);
    expect(() => resolveLimits({ zip: { maxRatio: Number.NaN } })).toThrow(TypeError);
    expect(() => resolveLimits({ encoding: { fallbackMaxForeignRatio: -0.1 } })).toThrow(TypeError);
    expect(() => resolveLimits({ encoding: { fallbackMaxForeignRatio: 1.5 } })).toThrow(TypeError);
  });

  it("rejects unknown keys and a non-object group", () => {
    expect(() => resolveLimits({ maxFileByte: 5 } as never)).toThrow(TypeError);
    expect(() => resolveLimits({ zip: 5 } as never)).toThrow(TypeError);
    expect(() => resolveLimits({ zip: { maxEntry: 5 } } as never)).toThrow(TypeError);
  });
});
