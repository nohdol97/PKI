// Survey runner (I02A-R22, S17): `pnpm --filter @pki/document-normalize survey <folder>`.
// Normalizes every regular file under a folder and prints counts only (per-format
// successes, error codes, limitation codes, encodings). It never prints a file name
// or any text, so its output can be pasted into a site report. A folder inside this
// repository is refused: a result made from the repository's synthetic documents
// must not be recorded as a site result. Both sides of that comparison use the native
// realpath, which also fixes the letter case (a case-variant path on a case-insensitive
// file system is still the repository).
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isInside } from "./input.ts";

type Counts = Record<string, number>;

function repositoryRoot(): string {
  let dir = import.meta.dirname;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) return realpathSync.native(import.meta.dirname);
    dir = parent;
  }
  return realpathSync.native(dir);
}

function bump(counts: Counts, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sorted(counts: Counts): Counts {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const argument = process.argv[2];
if (argument === undefined || process.argv.length > 3) {
  console.error("usage: survey <folder>");
  process.exit(2);
}

let folder: string;
try {
  folder = realpathSync.native(resolve(argument));
} catch {
  console.error("the folder cannot be read");
  process.exit(2);
}

if (isInside(repositoryRoot(), folder)) {
  console.log(
    "배포처 후속: 조사 실행기는 이 저장소 밖의 실제 문서 폴더에서 실행한다. " +
      "저장소 안의 합성 자료로 낸 결과는 S17의 결과로 기록하지 않는다.",
  );
  process.exit(1);
}

// Loaded only now, so usage and refusal paths do not pay for every parser.
const { normalizeDocument } = await import("./index.ts");

const success: Counts = {};
const errors: Counts = {};
const limitations: Counts = {};
const encodings: Counts = {};
let files = 0;
let symlinks = 0;
let others = 0;

const pending = [folder];
try {
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks++;
      } else if (entry.isDirectory()) {
        pending.push(path);
      } else if (!entry.isFile()) {
        others++;
      } else {
        files++;
        const result = await normalizeDocument({ kind: "path", path, allowedRoot: folder });
        if (result.ok) {
          const { document } = result;
          bump(success, document.format);
          if (document.encoding) bump(encodings, document.encoding.name);
          for (const limitation of document.limitations) bump(limitations, limitation.code);
        } else {
          bump(errors, result.error.code);
        }
      }
    }
  }
} catch {
  console.error("the folder could not be walked to the end");
  process.exit(2);
}

console.log(
  JSON.stringify({
    files,
    symlinks,
    others,
    success: sorted(success),
    errors: sorted(errors),
    limitations: sorted(limitations),
    encodings: sorted(encodings),
  }),
);
