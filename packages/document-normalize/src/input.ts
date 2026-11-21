// Gets the bytes of one input, with the boundary checks before any parser (I02A-R2, R3):
// real path inside the allowed root (compared by path segments), a regular file,
// size from the handle that does the reading, never more than the cap plus one chunk.
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Limits } from "./limits.ts";
import { formatFailure } from "./text-builder.ts";
import type { NormalizeError, NormalizeInput } from "./types.ts";

export const READ_CHUNK_BYTES = 65_536;

export type InputResult =
  { ok: true; bytes: Uint8Array; name: string | undefined } | { ok: false; error: NormalizeError };

const tooLarge = (limit: number): InputResult =>
  formatFailure("too-large", `입력이 maxFileBytes(${limit})보다 크다`, { limit });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const readFailed = (error: unknown): InputResult =>
  formatFailure("read-failed", "파일을 읽지 못했다", { cause: message(error).slice(0, 200) });

/**
 * Whether `real` is `root` or inside it, by path segments (`/data/a` is not inside
 * `/data/ab`). `api` is injectable so Windows semantics (another drive comes back
 * as an absolute "relative" path) are testable on any OS.
 */
export function isInside(
  root: string,
  real: string,
  api: Pick<typeof path, "relative" | "isAbsolute" | "sep"> = path,
): boolean {
  const rel = api.relative(root, real);
  return rel === "" || (!api.isAbsolute(rel) && rel.split(api.sep)[0] !== "..");
}

export async function readInput(input: NormalizeInput, limits: Limits): Promise<InputResult> {
  if (input.kind === "bytes") {
    if (input.bytes.byteLength > limits.maxFileBytes) return tooLarge(limits.maxFileBytes);
    return { ok: true, bytes: input.bytes, name: input.name };
  }

  let real: string;
  try {
    real = await realpath(input.path);
    if (input.allowedRoot !== undefined) {
      const root = await realpath(input.allowedRoot);
      if (!isInside(root, real)) {
        return formatFailure("outside-root", "허용 루트 밖의 경로다");
      }
    }
    // A FIFO or device must not be opened (open would block), so the type is read first.
    if (!(await stat(real)).isFile()) return formatFailure("not-a-file", "일반 파일이 아니다");
  } catch (error) {
    return readFailed(error);
  }

  let handle;
  try {
    // O_NOFOLLOW: the already-resolved path must not have become a symlink since.
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return readFailed(error);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return formatFailure("not-a-file", "일반 파일이 아니다");
    if (info.size > limits.maxFileBytes) return tooLarge(limits.maxFileBytes);

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limits.maxFileBytes) return tooLarge(limits.maxFileBytes);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { ok: true, bytes: new Uint8Array(Buffer.concat(chunks, total)), name: input.path };
  } catch (error) {
    return readFailed(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
