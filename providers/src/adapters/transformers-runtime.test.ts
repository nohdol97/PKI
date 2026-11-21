// The real Transformers.js runtime loads only from the folder it is given: with
// no model there it fails without trying the model hub, and it switches the
// library's own hub access, cache and fetch off (V01-R14: once prepared,
// embedding needs no network, and the runtime never downloads on its own).
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BGE_M3_INT8 } from "./bge-m3.ts";
import { extractionOptions, transformersRuntime } from "./transformers-runtime.ts";

let dir: string;
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("transformersRuntime", () => {
  it("fails on a folder without the model, and never reaches the network", async () => {
    dir = mkdtempSync(join(tmpdir(), "pki-runtime-"));
    const fetch = vi.fn(() => Promise.reject(new Error("network")));
    vi.stubGlobal("fetch", fetch);
    await expect(transformersRuntime.load(dir, BGE_M3_INT8)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    // Nor does it leave a cache behind in the folder.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("extracts the pinned pooling, L2-normalized", () => {
    expect(extractionOptions(BGE_M3_INT8)).toEqual({ pooling: "cls", normalize: true });
  });

  it("switches the library off the model hub, so even a hub model ID is not fetched", async () => {
    dir = mkdtempSync(join(tmpdir(), "pki-runtime-"));
    const fetch = vi.fn(() => Promise.reject(new Error("network")));
    vi.stubGlobal("fetch", fetch);
    await transformersRuntime.load(dir, BGE_M3_INT8).catch(() => undefined);
    const { env, LogLevel, pipeline } = await import("@huggingface/transformers");
    expect(env.allowRemoteModels).toBe(false);
    expect(env.useFSCache).toBe(false);
    // The library's console messages carry local paths (B6); they bypass log().
    expect(env.logLevel).toBe(LogLevel.NONE);
    // Its own fetch refuses too, should any code path of the library ignore the switch.
    await expect(env.fetch("https://huggingface.co/")).rejects.toThrow(/does not use the network/);
    await expect(pipeline("feature-extraction", "synthetic/not-a-model")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
