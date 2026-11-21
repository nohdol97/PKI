// V01-C7 `vector-index.contract` (V01-R15, ARCHITECTURE 5.4): the suite every
// working VectorIndex runs from its own test file. Ordering follows the
// VectorIndex doc comment in @pki/contracts.
import { StaleFenceError, type EmbeddingSpace, type VectorIndex } from "@pki/contracts";
import { beforeEach, describe, expect, it } from "vitest";

const SPACE: EmbeddingSpace = { modelId: "test-model", revision: "r1", dimension: 3 };
const v = (...xs: number[]) => Float32Array.from(xs);
const QUERIES = [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1), v(1, 1, 1)];

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

    it("starts with no space and no applied change, and refuses writes before reset", async () => {
      expect(await index.embeddingSpace()).toBeNull();
      expect(await index.appliedChangeSeq()).toBeNull();
      await expect(index.upsert([{ ref: "a", vector: v(1, 0, 0) }], 1)).rejects.toThrow();
    });

    describe("after reset", () => {
      beforeEach(async () => {
        await index.reset(SPACE);
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
        await rebuilt.reset(SPACE);
        await rebuilt.upsert(
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

      it("reset drops vectors and ordering marks", async () => {
        await index.upsert([{ ref: "a", vector: v(1, 0, 0) }], 5);
        await index.reset(SPACE);
        expect(await refs(index, v(1, 0, 0))).toEqual([]);
        expect(await index.appliedChangeSeq()).toBeNull();
        await index.upsert([{ ref: "a", vector: v(1, 0, 0) }], 1);
        expect(await refs(index, v(1, 0, 0))).toEqual(["a"]);
      });
    });
  });
}
