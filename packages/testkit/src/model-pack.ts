// Synthetic model packs for embedder tests (V01-T14 `embedding.integrity`): a folder
// of small files and the pinned list (path, size, SHA-256) that matches them, so a
// test can pin a pack, then change one file and see it refused. No model weights.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PackFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export const sha256Hex = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Writes `files` under `dir` and returns their pinned entries, in the given order. */
export function writeModelPack(dir: string, files: Record<string, string>): PackFile[] {
  return Object.entries(files).map(([path, content]) => {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    const bytes = Buffer.from(content);
    return { path, size: bytes.length, sha256: sha256Hex(bytes) };
  });
}

/**
 * Stands for the model runtime (Transformers.js) in embedder tests: it records
 * every folder it was asked to load and what it was given, and its vectors are a
 * hash of the text only. `fail` makes every load reject with that message.
 */
export class FakeEmbeddingRuntime {
  readonly loads: { dir: string; files: string[] }[] = [];
  readonly batches: string[][] = [];
  fail: string | undefined;

  async load(dir: string, model: { readonly dimension: number }) {
    this.loads.push({ dir, files: readdirSync(dir, { recursive: true }).map(String).sort() });
    if (this.fail !== undefined) throw new Error(this.fail);
    return {
      embed: async (texts: string[]) => {
        this.batches.push([...texts]);
        return texts.map((text) => hashVector(text, model.dimension));
      },
    };
  }
}

function hashVector(text: string, dimension: number) {
  const values: number[] = [];
  for (let block = 0; values.length < dimension; block++) {
    for (const byte of createHash("sha256").update(`${block}\0${text}`).digest()) {
      values.push(byte / 127.5 - 1);
    }
  }
  const vector = Float32Array.from(values.slice(0, dimension));
  const norm = Math.hypot(...vector) || 1;
  return vector.map((x) => x / norm);
}
