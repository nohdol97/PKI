// V01-C7 `vector-index.contract` (V01-R15, ARCHITECTURE 5.4): the suite every
// working VectorIndex runs from its own test file. Ordering and the generation
// protocol (beginRebuild, activate, discard; H01C3-R2) follow the doc comments in @pki/contracts.
import { StaleFenceError, type EmbeddingSpace, type VectorIndex } from "@pki/contracts";
import { beforeEach, describe, expect, it } from "vitest";

const SPACE: EmbeddingSpace = { modelId: "test-model", revision: "r1", dimension: 3 };
const v = (...xs: number[]) => Float32Array.from(xs);
const QUERIES = [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1), v(1, 1, 1)];

/** Makes `space` the active generation with `items` in it (what a finished rebuild leaves). */
async function activeIn(
  index: VectorIndex,
  space: EmbeddingSpace,
  items: { ref: string; vector: Float32Array }[] = [],
  seq: number | null = null,
) {
  const build = await index.beginRebuild(space);
  if (items.length > 0) await build.upsert(items, seq ?? 0);
  await build.activate(
    items.map((item) => item.ref),
    seq,
  );
}

async function refs(index: VectorIndex, query: Float32Array, k = 10) {
  return (await index.search(query, k)).map((hit) => hit.ref);
}

export function vectorIndexContract(
  name: string,
  create: () => VectorIndex | Promise<VectorIndex>,
): void {
  describe(`vector-index.contract: ${name}`, () => {
    let index: VectorIndex;

    beforeEach(async () => {
      index = await create();
    });

    it("starts with no space and no applied change, and refuses writes before a generation is active", async () => {
      expect(await index.embeddingSpace()).toBeNull();
      expect(await index.appliedChangeSeq()).toBeNull();
      expect(await index.status()).toEqual({ unavailable: expect.stringMatching(/\S/) });
      await expect(index.remove(["a"], 1)).resolves.toBeUndefined();
      await expect(index.upsert([{ ref: "a", vector: v(1, 0, 0) }], 1)).rejects.toThrow();
    });

    describe("with an active generation", () => {
      beforeEach(async () => {
        await activeIn(index, SPACE);
      });

      it("is ready in the given space", async () => {
        expect(await index.status()).toBe("ready");
        expect(await index.embeddingSpace()).toEqual(SPACE);
      });

      it("returns at most k hits, nearest first", async () => {
        await index.upsert(
          [
            { ref: "x", vector: v(1, 0, 0) },
            { ref: "xy", vector: v(1, 1, 0) },
            { ref: "y", vector: v(0, 1, 0) },
          ],
          1,
        );
        const [first, second, ...rest] = await index.search(v(1, 0.1, 0), 2);
        expect([first?.ref, second?.ref, rest.length]).toEqual(["x", "xy", 0]);
        expect(first?.score).toBeGreaterThan(second?.score ?? Infinity);
      });

      it("rejects vectors outside the space's dimension and keeps the rest unchanged", async () => {
        await expect(
          index.upsert(
            [
              { ref: "ok", vector: v(1, 0, 0) },
              { ref: "bad", vector: v(1, 0) },
            ],
            1,
          ),
        ).rejects.toThrow();
        expect(await refs(index, v(1, 0, 0))).toEqual([]);
        await expect(index.search(v(1, 0), 1)).rejects.toThrow();
      });

      it("replaces a ref's vector on upsert and forgets it on remove", async () => {
        await index.upsert([{ ref: "a", vector: v(1, 0, 0) }], 1);
        await index.upsert([{ ref: "a", vector: v(0, 1, 0) }], 2);
        expect(await refs(index, v(0, 1, 0), 1)).toEqual(["a"]);
        expect((await index.search(v(0, 1, 0), 1))[0]?.score).toBeCloseTo(1);
        await index.remove(["a"], 3);
        expect(await refs(index, v(0, 1, 0))).toEqual([]);
        expect(await index.appliedChangeSeq()).toBe(3);
      });

      it("rejects an older change for a ref, whole batch, without changing anything", async () => {
        await index.upsert([{ ref: "a", vector: v(1, 0, 0) }], 5);
        const late = index.upsert(
          [
            { ref: "b", vector: v(0, 1, 0) },
            { ref: "a", vector: v(0, 0, 1) },
          ],
          4,
        );
        await expect(late).rejects.toBeInstanceOf(StaleFenceError);
        expect(await refs(index, v(1, 0, 0), 1)).toEqual(["a"]);
        expect((await index.search(v(1, 0, 0), 1))[0]?.score).toBeCloseTo(1);
        expect(await refs(index, v(0, 1, 0))).not.toContain("b");
        await expect(index.remove(["a"], 4)).rejects.toBeInstanceOf(StaleFenceError);
        expect(await refs(index, v(1, 0, 0))).toContain("a");
        expect(await index.appliedChangeSeq()).toBe(5);
      });

      it("does not let a late upsert resurrect a removed ref", async () => {
        await index.upsert([{ ref: "a", vector: v(1, 0, 0) }], 1);
        await index.remove(["a"], 3);
        await expect(index.upsert([{ ref: "a", vector: v(1, 0, 0) }], 2)).rejects.toBeInstanceOf(
          StaleFenceError,
        );
        expect(await refs(index, v(1, 0, 0))).toEqual([]);
      });

      it("accepts a redelivered change with the same sequence", async () => {
        await index.upsert([{ ref: "a", vector: v(1, 0, 0) }], 2);
        await index.upsert([{ ref: "a", vector: v(1, 0, 0) }], 2);
        expect(await refs(index, v(1, 0, 0))).toEqual(["a"]);
      });

      it("rebuilt from the final state answers exactly like the incrementally built index", async () => {
        await index.upsert(
          [
            { ref: "a", vector: v(1, 0, 0) },
            { ref: "b", vector: v(0, 1, 0) },
            { ref: "c", vector: v(0, 0, 1) },
          ],
          1,
        );
        await index.upsert([{ ref: "b", vector: v(1, 1, 0) }], 2);
        await index.remove(["c"], 3);

        const rebuilt = await create();
        await activeIn(
          rebuilt,
          SPACE,
          [
            { ref: "b", vector: v(1, 1, 0) },
            { ref: "a", vector: v(1, 0, 0) },
          ],
          3,
        );
        for (const query of QUERIES) {
          expect(await rebuilt.search(query, 10)).toEqual(await index.search(query, 10));
        }
        expect(await rebuilt.appliedChangeSeq()).toBe(await index.appliedChangeSeq());
        expect(await rebuilt.embeddingSpace()).toEqual(await index.embeddingSpace());
      });

      it("answers from the active generation while another is built, and again after discard (H01C3-C1)", async () => {
        await index.upsert([{ ref: "old", vector: v(1, 0, 0) }], 5);
        const before = await index.search(v(1, 0, 0), 10);
        const other = { modelId: "other-model", revision: "r2", dimension: 2 };

        const build = await index.beginRebuild(other);
        await build.upsert([{ ref: "new", vector: v(0, 1) }], 7);
        expect(await index.status()).toBe("ready");
        expect(await index.embeddingSpace()).toEqual(SPACE);
        expect(await index.appliedChangeSeq()).toBe(5);
        expect(await index.search(v(1, 0, 0), 10)).toEqual(before);

        await build.discard();
        expect(await index.embeddingSpace()).toEqual(SPACE);
        expect(await index.appliedChangeSeq()).toBe(5);
        expect(await index.search(v(1, 0, 0), 10)).toEqual(before);
        await expect(build.upsert([{ ref: "late", vector: v(1, 0) }], 8)).rejects.toThrow();
      });

      it("switches to the new generation on activate and drops the previous one (H01C3-C1)", async () => {
        await index.upsert([{ ref: "old", vector: v(1, 0, 0) }], 5);
        const other = { modelId: "other-model", revision: "r2", dimension: 2 };
        const build = await index.beginRebuild(other);
        await build.upsert([{ ref: "new", vector: v(0, 1) }], 7);
        await build.activate(["new"], 7);

        expect(await index.embeddingSpace()).toEqual(other);
        expect(await index.appliedChangeSeq()).toBe(7);
        expect((await index.search(v(0, 1), 10)).map((hit) => hit.ref)).toEqual(["new"]);
        // nothing of the old generation can come back, not even by a new build of its space
        const again = await index.beginRebuild(SPACE);
        expect(await again.refs()).toEqual([]);
      });

      it("refuses to activate a generation whose refs differ from the expected ones and changes nothing (H01C3-C1)", async () => {
        await index.upsert([{ ref: "old", vector: v(1, 0, 0) }], 5);
        const build = await index.beginRebuild(SPACE);
        await build.upsert([{ ref: "a", vector: v(0, 1, 0) }], 6);
        await expect(build.activate(["a", "b"], 6)).rejects.toThrow();
        await expect(build.activate([], 6)).rejects.toThrow();
        expect(await refs(index, v(1, 0, 0))).toEqual(["old"]);
        expect(await index.appliedChangeSeq()).toBe(5);
        expect(await build.refs()).toEqual(["a"]);
      });

      it("removes a ref from every generation, the one being built included (H01C3-C3)", async () => {
        await index.upsert(
          [
            { ref: "keep", vector: v(1, 0, 0) },
            { ref: "gone", vector: v(0, 1, 0) },
          ],
          1,
        );
        const build = await index.beginRebuild(SPACE);
        await build.upsert(
          [
            { ref: "keep", vector: v(1, 0, 0) },
            { ref: "gone", vector: v(0, 1, 0) },
          ],
          1,
        );
        await index.remove(["gone"], 2);
        expect(await build.refs()).toEqual(["keep"]);
        expect(await refs(index, v(0, 1, 0))).toEqual(["keep"]);
        // a removal does not let a late write of the building generation bring the ref back
        await expect(build.upsert([{ ref: "gone", vector: v(0, 1, 0) }], 1)).rejects.toBeInstanceOf(
          StaleFenceError,
        );
      });

      it("reports rebuilding while no generation is active but one is being built", async () => {
        const empty = await create();
        await empty.beginRebuild(SPACE);
        expect(await empty.status()).toBe("rebuilding");
        expect(await empty.embeddingSpace()).toBeNull();
        await expect(empty.upsert([{ ref: "a", vector: v(1, 0, 0) }], 1)).rejects.toThrow();
      });

      it("starts a new build over a leftover one and leaves the active generation alone", async () => {
        await index.upsert([{ ref: "old", vector: v(1, 0, 0) }], 5);
        const first = await index.beginRebuild(SPACE);
        await first.upsert([{ ref: "x", vector: v(0, 1, 0) }], 6);
        const second = await index.beginRebuild(SPACE);
        expect(await second.refs()).toEqual([]);
        await expect(first.refs()).rejects.toThrow();
        expect(await refs(index, v(1, 0, 0))).toEqual(["old"]);
      });
    });
  });
}
