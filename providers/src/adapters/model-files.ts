// Puts the pinned model files into the data directory (ADR 0006, V01-R14). Each
// file is hashed while it is written to a staging folder, so the bytes installed
// are exactly the bytes checked; the staging folder becomes the model folder only
// when every file matched. A file that does not match is never installed.
// Failures carry a fixed reason, never the message of what was caught.
import type { PrepareSource } from "@pki/contracts";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { PinnedFile, PinnedModel } from "./bge-m3.ts";

export type ModelFileReason =
  | "model file missing"
  | "model file hash mismatch"
  | "model download failed"
  | "model install failed"
  | "embedding runtime failed to load";

/** A preparation that failed; `reason` is one of the fixed phrases above. */
export class ModelFileError extends Error {
  readonly reason: ModelFileReason;
  constructor(reason: ModelFileReason) {
    super(reason);
    this.name = "ModelFileError";
    this.reason = reason;
  }
}

/** The approved download's request: an `https` GET that follows redirects. */
export type ModelFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: "follow" },
) => Promise<Response>;

const MODEL_HUB = "https://huggingface.co";

export const modelFolder = (modelsDir: string, model: PinnedModel) =>
  join(modelsDir, model.modelId.replace(/[^A-Za-z0-9._-]/g, "_"), model.revision);

const isAbort = (error: unknown, signal: AbortSignal) =>
  signal.aborted || (error instanceof Error && error.name === "AbortError");

/** Hashes what passes through and stops as soon as it runs past the pinned size. */
function checker(file: PinnedFile) {
  const hash = createHash("sha256");
  let size = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > file.size) return done(new ModelFileError("model file hash mismatch"));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { transform, matches: () => size === file.size && hash.digest("hex") === file.sha256 };
}

/** Streams one file's bytes into `target`, failing unless they are exactly the pinned ones. */
async function copyChecked(
  open: () => Promise<Readable>,
  file: PinnedFile,
  target: string,
  signal: AbortSignal,
) {
  const source = await open();
  const check = checker(file);
  await mkdir(dirname(target), { recursive: true });
  await pipeline(source, check.transform, createWriteStream(target, { flags: "wx", mode: 0o600 }), {
    signal,
  });
  if (!check.matches()) throw new ModelFileError("model file hash mismatch");
}

/**
 * Opens a regular file for reading. Anything else (a FIFO, a device, a folder) is
 * "model file missing": opening a FIFO blocks until a writer appears, and an abort
 * could not end that wait (it holds a thread-pool thread). The open itself also
 * gives way to an abort.
 */
async function openRegularFile(path: string, signal: AbortSignal): Promise<Readable> {
  let regular: boolean;
  try {
    regular = (await stat(path)).isFile();
  } catch {
    regular = false;
  }
  if (!regular) throw new ModelFileError("model file missing");
  signal.throwIfAborted();
  return new Promise<Readable>((resolve, reject) => {
    const stream = createReadStream(path);
    const onAbort = () => {
      stream.destroy();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stream.once("open", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(stream);
    });
    stream.once("error", () => {
      signal.removeEventListener("abort", onAbort);
      reject(new ModelFileError("model file missing"));
    });
  });
}

/** True when `dir` holds every pinned file, each matching. Reads only. */
async function matchesPinned(dir: string, model: PinnedModel, signal: AbortSignal) {
  for (const file of model.files) {
    const check = checker(file);
    try {
      await pipeline(
        await openRegularFile(join(dir, file.path), signal),
        check.transform,
        async (chunks: AsyncIterable<Buffer>) => {
          for await (const chunk of chunks) void chunk;
        },
        { signal },
      );
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return false;
    }
    if (!check.matches()) return false;
  }
  return true;
}

function localOpener(packDir: string, signal: AbortSignal) {
  return (file: PinnedFile) => () => openRegularFile(join(packDir, file.path), signal);
}

function downloadOpener(model: PinnedModel, fetch: ModelFetch, signal: AbortSignal) {
  return (file: PinnedFile) => async () => {
    let response: Response;
    try {
      response = await fetch(
        `${MODEL_HUB}/${model.repository}/resolve/${model.revision}/${file.path}`,
        {
          signal,
          redirect: "follow",
        },
      );
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      throw new ModelFileError("model download failed");
    }
    // Redirects are followed, but only to https: the bytes are hash-checked either
    // way, yet a plain-http hop would show which files are fetched (B4).
    if (!response.ok || response.body === null || !response.url.startsWith("https://")) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelFileError("model download failed");
    }
    return Readable.fromWeb(response.body as WebReadableStream);
  };
}

const STAGING_PREFIX = ".staging-";

/**
 * Removes staging folders a killed or crashed preparation left behind (each can
 * hold a partly written model). One embedder owns `modelsDir` and runs one
 * preparation at a time, so none of them belongs to a live preparation.
 */
async function removeStaleStaging(modelsDir: string) {
  let entries: string[];
  try {
    entries = await readdir(modelsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(STAGING_PREFIX)) {
      await rm(join(modelsDir, entry), { recursive: true, force: true });
    }
  }
}

/**
 * Makes the model folder hold exactly the pinned files and returns it. A folder
 * that already matches is used as is, without reading the source; otherwise every
 * file comes from `source` through a staging folder. Never changes the model
 * folder unless the new files all matched.
 */
export async function installModel(options: {
  model: PinnedModel;
  modelsDir: string;
  source: PrepareSource;
  fetch: ModelFetch;
  signal: AbortSignal;
}): Promise<string> {
  const { model, modelsDir, source, signal } = options;
  await removeStaleStaging(modelsDir);
  const target = modelFolder(modelsDir, model);
  if (await matchesPinned(target, model, signal)) return target;

  if (source.kind === "local-pack" && !isAbsolute(source.path)) {
    throw new ModelFileError("model file missing");
  }
  const open =
    source.kind === "local-pack"
      ? localOpener(source.path, signal)
      : downloadOpener(model, options.fetch, signal);

  const staging = join(modelsDir, `${STAGING_PREFIX}${randomUUID()}`);
  try {
    for (const file of model.files) {
      signal.throwIfAborted();
      await copyChecked(open(file), file, join(staging, file.path), signal);
    }
    signal.throwIfAborted();
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await rename(staging, target);
    return target;
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    throw error instanceof ModelFileError ? error : new ModelFileError("model install failed");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
