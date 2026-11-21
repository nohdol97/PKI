// Fake embedder (V01-R14, R17, ARCHITECTURE 5.2): the test double for the
// Embedding boundary. It lives in testkit, which only test files may import, so
// no product build can bind it. Vectors are a deterministic hash of the text
// alone (not of the kind), so a query finds the document with the same text.
import {
  AdapterUnavailableError,
  type EmbeddingEgress,
  type EmbeddingKind,
  type EmbeddingModel,
  type EmbeddingProvider,
  type EmbeddingStatus,
  type PrepareSource,
} from "@pki/contracts";
import { createHash } from "node:crypto";

export interface FakeEmbedderOptions {
  egress?: EmbeddingEgress;
  dimension?: number;
  modelId?: string;
  /** Stands for an embedder whose runtime cannot load: status and prepare report this. */
  unavailable?: string;
}

function vectorOf(text: string, dimension: number) {
  const values: number[] = [];
  for (let block = 0; values.length < dimension; block++) {
    const digest = createHash("sha256").update(`${block}\0${text}`).digest();
    for (const byte of digest) values.push(byte / 127.5 - 1);
  }
  const vector = Float32Array.from(values.slice(0, dimension));
  const norm = Math.hypot(...vector) || 1;
  return vector.map((x) => x / norm);
}

export class FakeEmbedder implements EmbeddingProvider {
  /** Every request, so tests can tell that nothing prepared or embedded by itself. */
  readonly calls: {
    status: number;
    prepare: PrepareSource[];
    embed: { texts: string[]; kind: EmbeddingKind }[];
  } = { status: 0, prepare: [], embed: [] };
  readonly #model: EmbeddingModel;
  readonly #unavailable: string | undefined;
  #state: "model-missing" | "preparing" | "ready" = "model-missing";

  constructor(options: FakeEmbedderOptions = {}) {
    this.#model = {
      modelId: options.modelId ?? "fake-embedder",
      revision: "fake-r1",
      dimension: options.dimension ?? 8,
      maxTokens: 512,
      license: "MIT",
      egress: options.egress ?? "local",
    };
    this.#unavailable = options.unavailable;
  }

  describe(): EmbeddingModel {
    return { ...this.#model };
  }

  async status(): Promise<EmbeddingStatus> {
    this.calls.status++;
    return this.#unavailable === undefined ? this.#state : { unavailable: this.#unavailable };
  }

  async prepare(source: PrepareSource, signal: AbortSignal): Promise<void> {
    this.calls.prepare.push(source);
    signal.throwIfAborted();
    if (this.#unavailable !== undefined) throw new AdapterUnavailableError(this.#unavailable);
    this.#state = "preparing";
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (signal.aborted) {
      this.#state = "model-missing";
      signal.throwIfAborted();
    }
    this.#state = "ready";
  }

  async embed(
    texts: readonly string[],
    kind: EmbeddingKind,
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    signal?.throwIfAborted();
    if (this.#state !== "ready") throw new AdapterUnavailableError("model-missing");
    this.calls.embed.push({ texts: [...texts], kind });
    return texts.map((text) => vectorOf(text, this.#model.dimension));
  }
}
