// V01-C6 `embedding.integrity` (V01-R14, ADR 0006): the embedder is "ready" only
// when every pinned file matched its pinned size and SHA-256, for a local pack and
// for an approved download alike. A file that does not match is never installed and
// never reaches the runtime. Nothing prepares by itself (`embedding.missing`), and
// a failure is reported by a fixed phrase, never the caught error's message.
import { AdapterUnavailableError } from "@pki/contracts";
import { FakeEmbeddingRuntime, writeModelPack } from "@pki/testkit";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BGE_M3_INT8, type PinnedModel } from "./bge-m3.ts";
import { TransformersEmbedder, type ModelFetch } from "./transformers-embedder.ts";

const FILES = {
  "config.json": '{"synthetic": true}',
  "tokenizer.json": '{"synthetic": "tokenizer"}',
  "onnx/model_int8.onnx": "synthetic weights ".repeat(64),
};

let root: string;
let pack: string;
let modelsDir: string;
let model: PinnedModel;
let runtime: FakeEmbeddingRuntime;
let requests: string[];
let serve: (path: string) => Response;

const fetchSpy: ModelFetch = async (url, init) => {
  init.signal.throwIfAborted();
  requests.push(url);
  return serve(url.slice(url.indexOf("/resolve/") + "/resolve/".length + 41));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-embed-integrity-"));
  pack = join(root, "pack");
  modelsDir = join(root, "data", "models");
  model = {
    ...BGE_M3_INT8,
    modelId: "synthetic/embedder",
    repository: "synthetic/embedder-onnx",
    revision: "a".repeat(40),
    dimension: 8,
    files: writeModelPack(pack, FILES),
  };
  runtime = new FakeEmbeddingRuntime();
  requests = [];
  serve = (path) => new Response(readFileSync(join(pack, path)));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const embedder = () => new TransformersEmbedder({ model, modelsDir, runtime, fetch: fetchSpy });
const signal = () => new AbortController().signal;
const installed = () => join(modelsDir, "synthetic_embedder", model.revision);
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("local pack", () => {
  it("installs the pinned files into the data directory, then loads them from there", async () => {
    const e = embedder();
    await e.prepare({ kind: "local-pack", path: pack }, signal());
    expect(await e.status()).toBe("ready");
    expect(runtime.loads).toEqual([
      {
        dir: installed(),
        files: ["config.json", "onnx", "onnx/model_int8.onnx", "tokenizer.json"],
      },
    ]);
    expect(readFileSync(join(installed(), "onnx/model_int8.onnx"), "utf8")).toBe(
      FILES["onnx/model_int8.onnx"],
    );
    expect(requests).toEqual([]);
  });

  it.each([
    [
      "a changed byte",
      (file: string) => writeFileSync(file, `X${readFileSync(file, "utf8").slice(1)}`),
    ],
    ["an extra byte", (file: string) => writeFileSync(file, `${readFileSync(file, "utf8")}!`)],
    [
      "a truncated file",
      (file: string) => writeFileSync(file, readFileSync(file, "utf8").slice(1)),
    ],
  ])("refuses a pack with %s in one file, and uses none of it", async (_name, tamper) => {
    tamper(join(pack, "onnx/model_int8.onnx"));
    const e = embedder();
    const error = await rejection(e.prepare({ kind: "local-pack", path: pack }, signal()));
    expect(error).toBeInstanceOf(Error);
    expect(await e.status()).toEqual({ unavailable: "model file hash mismatch" });
    expect(runtime.loads).toEqual([]);
    expect(existsSync(installed())).toBe(false);
    // Nothing half-installed stays behind either.
    expect(existsSync(modelsDir) ? readdirSync(modelsDir) : []).toEqual([]);
    expect(await rejection(e.embed(["합성 문장"], "query"))).toBeInstanceOf(
      AdapterUnavailableError,
    );
  });

  it.each([
    ["a file is missing", () => rmSync(join(pack, "tokenizer.json"))],
    ["the folder does not exist", () => rmSync(pack, { recursive: true })],
  ])("reports the model file missing when %s", async (_name, damage) => {
    damage();
    const e = embedder();
    await expect(e.prepare({ kind: "local-pack", path: pack }, signal())).rejects.toThrow();
    expect(await e.status()).toEqual({ unavailable: "model file missing" });
    expect(runtime.loads).toEqual([]);
  });

  it("refuses a relative pack path", async () => {
    const e = embedder();
    await expect(e.prepare({ kind: "local-pack", path: "pack" }, signal())).rejects.toThrow();
    expect(await e.status()).toEqual({ unavailable: "model file missing" });
  });

  it("can be prepared again after a refused pack", async () => {
    const good = readFileSync(join(pack, "config.json"), "utf8");
    writeFileSync(join(pack, "config.json"), "{}");
    const e = embedder();
    await expect(e.prepare({ kind: "local-pack", path: pack }, signal())).rejects.toThrow();
    writeFileSync(join(pack, "config.json"), good);
    await e.prepare({ kind: "local-pack", path: pack }, signal());
    expect(await e.status()).toBe("ready");
  });
});

describe("approved download", () => {
  it("fetches each pinned file at the pinned revision and installs it", async () => {
    const e = embedder();
    await e.prepare({ kind: "download" }, signal());
    expect(await e.status()).toBe("ready");
    expect(requests).toEqual(
      model.files.map(
        (f) => `https://huggingface.co/synthetic/embedder-onnx/resolve/${model.revision}/${f.path}`,
      ),
    );
    expect(runtime.loads.map((l) => l.dir)).toEqual([installed()]);
  });

  it("refuses a downloaded file whose hash differs, and uses none of it", async () => {
    serve = (path) =>
      new Response(
        path === "tokenizer.json" ? '{"synthetic": "tokenizeR"}' : readFileSync(join(pack, path)),
      );
    const e = embedder();
    await expect(e.prepare({ kind: "download" }, signal())).rejects.toThrow();
    expect(await e.status()).toEqual({ unavailable: "model file hash mismatch" });
    expect(runtime.loads).toEqual([]);
    expect(existsSync(installed())).toBe(false);
  });

  it("stops reading a download that runs past the pinned size", async () => {
    let sent = 0;
    serve = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            sent += 1024;
            controller.enqueue(new Uint8Array(1024));
            if (sent > 1024 * 1024) controller.close();
          },
        }),
      );
    const e = embedder();
    await expect(e.prepare({ kind: "download" }, signal())).rejects.toThrow();
    expect(await e.status()).toEqual({ unavailable: "model file hash mismatch" });
    expect(sent).toBeLessThan(64 * 1024);
  });

  it("reports a failed download by a fixed phrase, not the server's or network's words", async () => {
    for (const fail of [
      () => new Response("CANARY server text", { status: 404 }),
      () => {
        throw new TypeError("CANARY network failure");
      },
    ]) {
      serve = fail;
      const e = embedder();
      const error = await rejection(e.prepare({ kind: "download" }, signal()));
      expect(String(error)).not.toContain("CANARY");
      expect(await e.status()).toEqual({ unavailable: "model download failed" });
      expect(runtime.loads).toEqual([]);
    }
  });
});

describe("an installed model", () => {
  it("is reused when its files still match, without reading the source or the network", async () => {
    await embedder().prepare({ kind: "local-pack", path: pack }, signal());
    rmSync(pack, { recursive: true });
    const again = embedder();
    expect(await again.status()).toBe("model-missing");
    await again.prepare({ kind: "download" }, signal());
    expect(await again.status()).toBe("ready");
    expect(requests).toEqual([]);
  });

  it("is replaced from the source when one of its files was changed on disk", async () => {
    await embedder().prepare({ kind: "local-pack", path: pack }, signal());
    writeFileSync(join(installed(), "tokenizer.json"), "{}");
    const again = embedder();
    await again.prepare({ kind: "download" }, signal());
    expect(await again.status()).toBe("ready");
    expect(requests).toHaveLength(model.files.length);
    expect(readFileSync(join(installed(), "tokenizer.json"), "utf8")).toBe(FILES["tokenizer.json"]);
  });

  it("is refused, not loaded, when it was changed and the source is gone", async () => {
    await embedder().prepare({ kind: "local-pack", path: pack }, signal());
    writeFileSync(join(installed(), "tokenizer.json"), "{}");
    runtime.loads.length = 0;
    const again = embedder();
    await expect(
      again.prepare({ kind: "local-pack", path: join(root, "gone") }, signal()),
    ).rejects.toThrow();
    expect(await again.status()).toEqual({ unavailable: "model file missing" });
    expect(runtime.loads).toEqual([]);
  });
});

describe("nothing prepares by itself (embedding.missing)", () => {
  it("reads no source, network or runtime on construction, status reads, embeds or the passage of time", async () => {
    await embedder().prepare({ kind: "local-pack", path: pack }, signal());
    runtime.loads.length = 0;
    vi.useFakeTimers();
    // An installed, matching model on disk is not loaded until prepare is asked for.
    const e = embedder();
    for (let i = 0; i < 5; i++) expect(await e.status()).toBe("model-missing");
    expect(await rejection(e.embed(["합성 문장"], "document"))).toBeInstanceOf(
      AdapterUnavailableError,
    );
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(await e.status()).toBe("model-missing");
    expect(requests).toEqual([]);
    expect(runtime.loads).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("creates nothing in the data directory before a preparation", async () => {
    const e = embedder();
    await e.status();
    await rejection(e.embed(["합성 문장"], "query"));
    expect(existsSync(modelsDir)).toBe(false);
  });
});

describe("preparation states", () => {
  it("is preparing while a preparation runs, and refuses a second one meanwhile", async () => {
    const e = embedder();
    const first = e.prepare({ kind: "local-pack", path: pack }, signal());
    expect(await e.status()).toBe("preparing");
    await expect(e.prepare({ kind: "local-pack", path: pack }, signal())).rejects.toThrow();
    await first;
    expect(await e.status()).toBe("ready");
    expect(runtime.loads).toHaveLength(1);
  });

  it("returns to model-missing and leaves nothing behind when aborted midway", async () => {
    const controller = new AbortController();
    serve = (path) => {
      if (path === "tokenizer.json") controller.abort();
      return new Response(readFileSync(join(pack, path)));
    };
    const e = embedder();
    await expect(e.prepare({ kind: "download" }, controller.signal)).rejects.toThrow();
    expect(await e.status()).toBe("model-missing");
    expect(runtime.loads).toEqual([]);
    expect(existsSync(modelsDir) ? readdirSync(modelsDir) : []).toEqual([]);
  });

  it("reports a runtime that cannot load by a fixed phrase, without its message", async () => {
    runtime.fail = "CANARY runtime message";
    const e = embedder();
    const error = await rejection(e.prepare({ kind: "local-pack", path: pack }, signal()));
    expect(String(error)).not.toContain("CANARY");
    const status = await e.status();
    expect(status).toEqual({ unavailable: "embedding runtime failed to load" });
    expect(JSON.stringify(status)).not.toContain("CANARY");
  });

  it("refuses an embedding whose vectors do not match the model's dimension", async () => {
    const e = new TransformersEmbedder({
      model,
      modelsDir,
      fetch: fetchSpy,
      runtime: {
        load: async () => ({
          embed: async (texts: string[]) => texts.map(() => new Float32Array(3)),
        }),
      },
    });
    await e.prepare({ kind: "local-pack", path: pack }, signal());
    await expect(e.embed(["합성 문장"], "query")).rejects.toThrow();
  });
});
