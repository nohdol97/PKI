// V01-R14, ADR 0006: the model the product embeds with is a build resource — one
// pinned revision and, for every file the runtime reads, its size and SHA-256.
// Nothing at run time (settings, environment, data folder) supplies these values.
import { describe, expect, it } from "vitest";
import { BGE_M3_INT8 } from "./bge-m3.ts";

describe("the pinned bge-m3 model", () => {
  it("pins a full commit revision and a size and SHA-256 for each file", () => {
    expect(BGE_M3_INT8.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(BGE_M3_INT8.files.length).toBeGreaterThan(0);
    for (const file of BGE_M3_INT8.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(file.size) && file.size > 0).toBe(true);
      // Relative paths inside the model folder only.
      expect(file.path).toMatch(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/);
      expect(file.path.split("/")).not.toContain("..");
    }
    expect(new Set(BGE_M3_INT8.files.map((f) => f.path)).size).toBe(BGE_M3_INT8.files.length);
  });

  it("pins the files the runtime loads for the pinned data type", () => {
    expect(BGE_M3_INT8.files.map((f) => f.path).sort()).toEqual([
      "config.json",
      `onnx/model_${BGE_M3_INT8.dtype}.onnx`,
      "tokenizer.json",
      "tokenizer_config.json",
    ]);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(BGE_M3_INT8)).toBe(true);
    expect(Object.isFrozen(BGE_M3_INT8.files)).toBe(true);
    expect(BGE_M3_INT8.files.every(Object.isFrozen)).toBe(true);
  });
});
