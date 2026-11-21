// The zip guard of I02A-R4: decides whether an OOXML archive may reach a parser.
// 1. Central directory only: entry count, declared sizes, ratio, encryption, entry names.
// 2. Then each entry is inflated for real, counting bytes, and stopped the moment the
//    count passes (or ends short of) the declared size.
// 3. The parser gets a fresh archive built from the checked entries only.
import { zipSync } from "fflate";
import yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";
import type { Limits } from "./limits.ts";
import { formatFailure } from "./text-builder.ts";
import type { NormalizeError } from "./types.ts";

export interface GuardedEntry {
  name: string;
  data: Uint8Array;
}
export type GuardResult =
  | { ok: true; entries: GuardedEntry[]; rezipped: Uint8Array }
  | { ok: false; error: NormalizeError };

type Failure = { ok: false; error: NormalizeError };
type ZipLimits = Limits["zip"];

const limitFailure = (
  limit: string,
  message: string,
  extra: Record<string, number> = {},
): Failure => formatFailure("zip-limit", message, { limit, ...extra });
const corrupt = (cause: unknown): Failure =>
  formatFailure("corrupt", "압축 파일을 읽지 못했다", {
    cause: (cause instanceof Error ? cause.message : String(cause)).slice(0, 300),
  });

/** The rule an entry name breaks, or `undefined` for an acceptable name. */
function pathRule(name: string): string | undefined {
  if (name.includes("\0")) return "nul";
  if (name.includes("\\")) return "backslash";
  if (name.startsWith("/")) return "absolute";
  if (/^[A-Za-z]:/.test(name)) return "drive-letter";
  if (name.split("/").includes("..")) return "parent-segment";
  return undefined;
}

function open(bytes: Uint8Array): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { lazyEntries: true, decodeStrings: false, validateEntrySizes: false },
      (error, zip) => (error ? reject(error) : resolve(zip)),
    );
  });
}

/** Reads the central directory and applies every check that needs declared values only. */
function readDirectory(
  zip: ZipFile,
  limits: ZipLimits,
): Promise<{ ok: true; entries: { entry: Entry; name: string }[] } | Failure> {
  return new Promise((resolve) => {
    const entries: { entry: Entry; name: string }[] = [];
    let total = 0;
    const stop = (failure: Failure) => {
      zip.close();
      resolve(failure);
    };
    if (zip.entryCount > limits.maxEntries) {
      return stop(
        limitFailure("maxEntries", "압축 파일의 항목 수가 한도를 넘는다", {
          entries: zip.entryCount,
        }),
      );
    }
    zip.on("error", (error) => resolve(corrupt(error)));
    zip.on("end", () => resolve({ ok: true, entries }));
    zip.on("entry", (entry: Entry) => {
      const name = new TextDecoder().decode(entry.fileName as unknown as Uint8Array);
      if (entry.isEncrypted()) return stop(limitFailure("encrypted", "암호화된 항목이 있다"));
      if (entry.uncompressedSize > limits.maxEntryBytes) {
        return stop(
          limitFailure("maxEntryBytes", "한 항목의 크기가 한도를 넘는다", {
            size: entry.uncompressedSize,
          }),
        );
      }
      total += entry.uncompressedSize;
      if (total > limits.maxTotalBytes) {
        return stop(
          limitFailure("maxTotalBytes", "항목 크기의 합이 한도를 넘는다", { size: total }),
        );
      }
      if (
        entry.uncompressedSize >= limits.ratioMinBytes &&
        entry.uncompressedSize > entry.compressedSize * limits.maxRatio
      ) {
        return stop(
          limitFailure("maxRatio", "압축률이 한도를 넘는다", { size: entry.uncompressedSize }),
        );
      }
      const rule = pathRule(name);
      if (rule) return stop(formatFailure("zip-path", "허용되지 않는 항목 이름이 있다", { rule }));
      entries.push({ entry, name });
      zip.readEntry();
    });
    zip.readEntry();
  });
}

/** Inflates one entry, stopping as soon as the real size leaves the declared one. */
function inflate(zip: ZipFile, entry: Entry): Promise<{ ok: true; data: Buffer } | Failure> {
  return new Promise((resolve) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return resolve(corrupt(error));
      const chunks: Buffer[] = [];
      let inflated = 0;
      let settled = false;
      const finish = (result: { ok: true; data: Buffer } | Failure) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const sizeMismatch = () =>
        limitFailure("declaredSize", "항목의 실제 크기가 선언과 다르다", {
          declared: entry.uncompressedSize,
          inflated,
        });
      stream.on("data", (chunk: Buffer) => {
        inflated += chunk.length;
        if (inflated > entry.uncompressedSize) {
          stream.destroy();
          return finish(sizeMismatch());
        }
        chunks.push(chunk);
      });
      stream.on("end", () =>
        inflated === entry.uncompressedSize
          ? finish({ ok: true, data: Buffer.concat(chunks) })
          : finish(sizeMismatch()),
      );
      stream.on("error", (streamError) => finish(corrupt(streamError)));
    });
  });
}

/** Zip timestamps are fixed so the re-zipped archive is the same for the same input. */
const FIXED_MTIME = Date.UTC(2020, 0, 1);

export async function guardZip(bytes: Uint8Array, limits: ZipLimits): Promise<GuardResult> {
  let zip: ZipFile;
  try {
    zip = await open(bytes);
  } catch (error) {
    return corrupt(error);
  }
  try {
    const directory = await readDirectory(zip, limits);
    if (!directory.ok) return directory;

    const entries: GuardedEntry[] = [];
    for (const { entry, name } of directory.entries) {
      if (name.endsWith("/")) continue;
      const inflated = await inflate(zip, entry);
      if (!inflated.ok) return inflated;
      entries.push({ name, data: inflated.data });
    }
    const files: Record<string, Uint8Array> = Object.create(null);
    for (const { name, data } of entries) files[name] = data;
    return { ok: true, entries, rezipped: zipSync(files, { level: 0, mtime: FIXED_MTIME }) };
  } finally {
    zip.close();
  }
}
