// V01-R15: the product's default VectorIndex reports "unavailable" for every call,
// with one reason, and never pretends to have stored or found anything.
import { AdapterUnavailableError, type VectorIndex } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { EmptyVectorIndex } from "./empty-vector-index.ts";

describe("EmptyVectorIndex", () => {
  const index: VectorIndex = new EmptyVectorIndex();
  const space = { modelId: "m", revision: "r", dimension: 1 };
  const vector = Float32Array.from([1]);

  it("reports unavailable with a reason", async () => {
    const status = await index.status();
    expect(status).toEqual({ unavailable: expect.stringMatching(/\S/) });
  });

  it.each([
    ["embeddingSpace", () => index.embeddingSpace()],
    ["appliedChangeSeq", () => index.appliedChangeSeq()],
    ["beginRebuild", () => index.beginRebuild(space)],
    ["upsert", () => index.upsert([{ ref: "a", vector }], 1)],
    ["remove", () => index.remove(["a"], 1)],
    ["search", () => index.search(vector, 1)],
  ])("rejects %s as unavailable, for the same reason", async (_name, call) => {
    const status = await index.status();
    const error = await call().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AdapterUnavailableError);
    expect((error as AdapterUnavailableError).reason).toBe(
      typeof status === "object" ? status.unavailable : undefined,
    );
  });
});
