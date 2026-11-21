// The embedding model the product ships with (ADR 0006, V01-R14): BAAI/bge-m3 as
// the community int8 ONNX export, pinned to one commit and, per file, a size and
// SHA-256. This is a build resource; nothing at run time changes it. Changing the
// model (a fork, S09) means changing these values, which changes the embedding
// space and rebuilds the vector index.
// Values: the Hugging Face API tree of the revision (LFS files carry their
// SHA-256; the small JSON files were hashed after download), V01-T14.

export interface PinnedFile {
  /** Relative to the model folder. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PinnedModel {
  /** Names the embedding space: the repository and the data type. */
  readonly modelId: string;
  /** Model hub repository the approved download reads from. */
  readonly repository: string;
  /** Full commit of `repository`; the download reads exactly this. */
  readonly revision: string;
  /** Transformers.js data type; it loads `onnx/model_<dtype>.onnx`. */
  readonly dtype: "int8";
  /** bge-m3's dense vector is its CLS token, L2-normalized. */
  readonly pooling: "cls";
  readonly dimension: number;
  readonly maxTokens: number;
  readonly license: string;
  /** Every file the runtime reads. "ready" only when all of them match. */
  readonly files: readonly PinnedFile[];
}

const deepFreeze = (model: PinnedModel): PinnedModel =>
  Object.freeze({ ...model, files: Object.freeze(model.files.map((f) => Object.freeze(f))) });

export const BGE_M3_INT8: PinnedModel = deepFreeze({
  modelId: "onnx-community/bge-m3-ONNX:int8",
  repository: "onnx-community/bge-m3-ONNX",
  revision: "25b9af8e87a38eb120cfe87125383677b9cd309e",
  dtype: "int8",
  pooling: "cls",
  dimension: 1024,
  maxTokens: 8192,
  license: "MIT",
  files: [
    {
      path: "config.json",
      size: 658,
      sha256: "70dae5884ced999af00244f776ac9eaa71538d68497d3d6a6091e0318cd32905",
    },
    {
      path: "tokenizer_config.json",
      size: 1203,
      sha256: "b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80",
    },
    {
      path: "tokenizer.json",
      size: 17082799,
      sha256: "249df0778f236f6ece390de0de746838ef25b9d6954b68c2ee71249e0a9d8fd4",
    },
    {
      path: "onnx/model_int8.onnx",
      size: 568479395,
      sha256: "2237f770aad5c71bbc1fc2d361a57f9a37400574cc9eff32626f0cdb49234730",
    },
  ],
});
