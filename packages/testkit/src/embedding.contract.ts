// V01-C6/C7 `embedding.contract` (V01-R14, ARCHITECTURE 5.2): the suite every
// EmbeddingProvider runs from its own test file — the fake embedder here, the
// Transformers.js implementation in V01-T14. Integrity of model files
// (`embedding.integrity`) and the real-model round trip are T14's own tests.
import {
  AdapterUnavailableError,
  type EmbeddingProvider,
  type PrepareSource,
} from "@pki/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

export interface EmbeddingContractSubject {
  /** A fresh embedder on which no model has been prepared yet. */
  create(): EmbeddingProvider | Promise<EmbeddingProvider>;
  /** A source from which `prepare` makes the model ready (a valid local pack in tests). */
  source(): PrepareSource | Promise<PrepareSource>;
}

const DOCUMENTS = [
  "합성 등대 점검 일지: 오전에 등명기를 닦았다.",
  "Synthetic harbour budget memo for the second quarter.",
  "합성 부두 공지 — 내일 정오에 하역 작업이 멈춘다.",
] as const;

function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((x, i) => {
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  });
  return dot / Math.sqrt(na * nb);
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

export function embeddingContract(name: string, subject: EmbeddingContractSubject): void {
  describe(`embedding.contract: ${name}`, () => {
    describe("before any model is prepared", () => {
      let embedder: EmbeddingProvider;

      beforeEach(async () => {
        embedder = await subject.create();
      });

      it("describes its model, including where embedding happens", () => {
        const model = embedder.describe();
        for (const field of [model.modelId, model.revision, model.license]) {
          expect(field).toMatch(/\S/);
        }
        expect(Number.isInteger(model.dimension) && model.dimension > 0).toBe(true);
        expect(Number.isInteger(model.maxTokens) && model.maxTokens > 0).toBe(true);
        expect(["local", "external"]).toContain(model.egress);
        expect(embedder.describe()).toEqual(model);
      });

      it("reports the model missing and does not prepare one by itself", async () => {
        expect(await embedder.status()).toBe("model-missing");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await embedder.status()).toBe("model-missing");
      });

      it("refuses to embed until a model is ready", async () => {
        const error = await rejection(embedder.embed([DOCUMENTS[0]], "document"));
        expect(error).toBeInstanceOf(AdapterUnavailableError);
        expect(await embedder.status()).toBe("model-missing");
      });

      it("refuses an aborted preparation and stays without a model", async () => {
        const aborted = AbortSignal.abort();
        await expect(embedder.prepare(await subject.source(), aborted)).rejects.toThrow();
        expect(await embedder.status()).toBe("model-missing");
      });
    });

    describe("after prepare", () => {
      let embedder: EmbeddingProvider;
      let dimension: number;

      beforeAll(async () => {
        embedder = await subject.create();
        await embedder.prepare(await subject.source(), new AbortController().signal);
        dimension = embedder.describe().dimension;
      });

      it("is ready", async () => {
        expect(await embedder.status()).toBe("ready");
      });

      it("returns one finite, non-zero vector of the model's dimension per text, in order", async () => {
        for (const kind of ["document", "query"] as const) {
          const vectors = await embedder.embed(DOCUMENTS, kind);
          expect(vectors).toHaveLength(DOCUMENTS.length);
          for (const vector of vectors) {
            expect(vector).toBeInstanceOf(Float32Array);
            expect(vector).toHaveLength(dimension);
            expect(vector.every(Number.isFinite)).toBe(true);
            expect(vector.some((x) => x !== 0)).toBe(true);
          }
        }
      });

      it("embeds no texts to no vectors", async () => {
        expect(await embedder.embed([], "document")).toEqual([]);
      });

      it("gives a text the same vector alone or in a batch", async () => {
        const batch = await embedder.embed(DOCUMENTS, "document");
        for (const [i, text] of DOCUMENTS.entries()) {
          const [alone] = await embedder.embed([text], "document");
          expect(cosine(alone as Float32Array, batch[i] as Float32Array)).toBeGreaterThan(0.999);
        }
      });

      it("gives different texts different vectors", async () => {
        const [a, b] = await embedder.embed([DOCUMENTS[0], DOCUMENTS[1]], "document");
        expect(Array.from(a as Float32Array)).not.toEqual(Array.from(b as Float32Array));
      });

      it("refuses an aborted call", async () => {
        await expect(
          embedder.embed([DOCUMENTS[0]], "query", AbortSignal.abort()),
        ).rejects.toThrow();
        expect(await embedder.status()).toBe("ready");
      });
    });
  });
}
