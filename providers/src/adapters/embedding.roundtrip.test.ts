// V01-C6 `embedding.roundtrip` (real model, only when explicitly enabled): the
// product's embedder with the real Transformers.js runtime and the pinned bge-m3
// files embeds synthetic Korean and English sentences, the memory VectorIndex
// stores them, and a search finds each one — with the network cut after
// preparation. The same embedder also runs `embedding.contract`.
//
// Enable with PKI_REAL_EMBEDDING_MODELS_DIR=<absolute folder for installed models>.
// The model is prepared from PKI_REAL_EMBEDDING_PACK (an absolute local pack) when
// set, otherwise by the approved download (about 590 MB, once; a folder that already
// holds the matching files is reused). The default `pnpm test` skips all of this and
// stays offline.
import type { PrepareSource } from "@pki/contracts";
import { embeddingContract, MemoryVectorIndex } from "@pki/testkit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BGE_M3_INT8 } from "./bge-m3.ts";
import { TransformersEmbedder } from "./transformers-embedder.ts";
import { transformersRuntime } from "./transformers-runtime.ts";

const modelsDir = process.env.PKI_REAL_EMBEDDING_MODELS_DIR;
const packDir = process.env.PKI_REAL_EMBEDDING_PACK;
const enabled = modelsDir !== undefined && modelsDir !== "";
const source: PrepareSource = packDir
  ? { kind: "local-pack", path: packDir }
  : { kind: "download" };

const realEmbedder = () =>
  new TransformersEmbedder({
    model: BGE_M3_INT8,
    modelsDir: modelsDir as string,
    runtime: transformersRuntime,
    fetch: (url, init) => globalThis.fetch(url, init),
  });

const DOCUMENTS = {
  "doc-ko-lighthouse": "합성 등대 점검 일지: 오전에 등명기의 렌즈를 닦고 회전 장치에 기름을 쳤다.",
  "doc-ko-harbour": "합성 부두 공지 — 내일 정오부터 두 시간 동안 하역 작업이 멈춘다.",
  "doc-en-budget":
    "Synthetic memo: the harbour office's second-quarter budget rises by four percent.",
  "doc-en-ferry": "Synthetic notice: the morning ferry to the island is cancelled because of fog.",
};

const QUERIES = [
  ["등대 렌즈를 청소한 기록", "doc-ko-lighthouse"],
  ["하역 작업이 언제 중단되나요", "doc-ko-harbour"],
  ["How much did the quarterly budget increase?", "doc-en-budget"],
  ["Is the ferry running this morning?", "doc-en-ferry"],
] as const;

describe.runIf(enabled)("embedding.roundtrip (real bge-m3)", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 1_800_000 });
  const embedder = realEmbedder();
  const index = new MemoryVectorIndex();
  let fetchCalls = 0;

  beforeAll(async () => {
    const started = Date.now();
    await embedder.prepare(source, new AbortController().signal);
    console.info(`embedding.roundtrip: ${source.kind} prepared in ${Date.now() - started} ms`);
    // Cut the network for everything after preparation.
    vi.stubGlobal("fetch", () => {
      fetchCalls++;
      return Promise.reject(new TypeError("network cut by the round-trip test"));
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  it("is ready and local", async () => {
    expect(await embedder.status()).toBe("ready");
    expect(embedder.describe().egress).toBe("local");
  });

  it("finds each synthetic sentence by a query about it, offline", async () => {
    const { modelId, revision, dimension } = embedder.describe();
    await index.reset({ modelId, revision, dimension });
    const refs = Object.keys(DOCUMENTS);
    const vectors = await embedder.embed(Object.values(DOCUMENTS), "document");
    await index.upsert(
      refs.map((ref, i) => ({ ref, vector: vectors[i] as Float32Array })),
      1,
    );
    for (const [query, expected] of QUERIES) {
      const [vector] = await embedder.embed([query], "query");
      const hits = await index.search(vector as Float32Array, refs.length);
      console.info(
        `embedding.roundtrip: ${JSON.stringify(query)} -> ${hits
          .map((h) => `${h.ref}=${h.score.toFixed(4)}`)
          .join(", ")}`,
      );
      expect(hits[0]?.ref).toBe(expected);
    }
    expect(fetchCalls).toBe(0);
  });
});

if (enabled) {
  embeddingContract("transformers.js (real runtime, pinned bge-m3)", {
    create: realEmbedder,
    source: () => source,
  });
} else {
  describe.skip("embedding.roundtrip and embedding.contract on the real model", () => {
    it("runs only with PKI_REAL_EMBEDDING_MODELS_DIR set", () => undefined);
  });
}
