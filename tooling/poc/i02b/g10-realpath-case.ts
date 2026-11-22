// I02B-T01 PoC (throwaway), G10 + the R48 ancestor-identity judgement, on the dev OS.
//  1. Does `fs.realpathSync.native` return the stored letter case for a path typed with other
//     letter case (and for a different Unicode normalization form)? `fs.realpathSync` (JS) is
//     measured next to it as the contrast.
//  2. Does the ancestor identity walk (R48 (2)) call such a candidate "inside" the forbidden folder
//     even where the path comparison would be fooled?
// Usage: node g10-realpath-case.ts <scratchDir> [volumeNote]
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: g10-realpath-case.ts <scratchDir>");
mkdirSync(root, { recursive: true });
console.log(`node ${process.version} ${process.platform}-${process.arch}; scratch=${root}`);
console.log(`volume: ${execFileSync("df", [root]).toString().trim().split("\n").at(-1)}`);

// is this volume case-insensitive? (probe, not assumption)
writeFileSync(join(root, "Probe"), "x");
let insensitive: boolean;
try {
  statSync(join(root, "pROBE"));
  insensitive = true;
} catch {
  insensitive = false;
}
console.log(`volume treats Probe and pROBE as the same file: ${insensitive}`);

mkdirSync(join(root, "Docs", "SubDir"), { recursive: true });
writeFileSync(join(root, "Docs", "SubDir", "Note.TXT"), "n");
mkdirSync(join(root, "Docs2"));

const typed = join(root, "dOCS", "sUBdIR", "nOTE.txt");
const native = (() => {
  try {
    return realpathSync.native(typed);
  } catch (e) {
    return `ERR ${(e as { code?: string }).code}`;
  }
})();
const js = (() => {
  try {
    return realpathSync(typed);
  } catch (e) {
    return `ERR ${(e as { code?: string }).code}`;
  }
})();
const expected = realpathSync.native(join(root, "Docs", "SubDir", "Note.TXT"));
console.log(`typed:            ${typed}`);
console.log(`realpath.native:  ${native}`);
console.log(`realpath (JS):    ${js}`);
console.log(`stored case:      ${expected}`);
console.log(`native == stored case: ${native === expected}; JS == stored case: ${js === expected}`);

// Unicode normalization: stored NFC, typed NFD (and the reverse)
const realRoot = realpathSync.native(root);
const nfc = "한글폴더é";
const nfd = nfc.normalize("NFD");
mkdirSync(join(root, nfc));
const nfdTyped = join(root, nfd);
const un = (() => {
  try {
    return realpathSync.native(nfdTyped);
  } catch (e) {
    return `ERR ${(e as { code?: string }).code}`;
  }
})();
console.log(
  `unicode: stored NFC, typed NFD: realpath.native returns ${un === join(realRoot, nfc) ? "the stored NFC form" : un === join(realRoot, nfd) ? "the typed NFD form" : "something else: " + un}`,
);

// R48 (2): climb from the candidate to the volume root comparing (dev, ino) with the forbidden folders'
const idOf = (p: string) => {
  const s = statSync(p, { bigint: true });
  return `${s.dev}:${s.ino}`;
};
function ancestorIds(p: string): string[] {
  const out: string[] = [];
  for (let cur = p; ; cur = dirname(cur)) {
    out.push(idOf(cur));
    if (cur === parse(cur).root) break;
  }
  return out;
}
const fold = (p: string) => p.normalize("NFC").toLowerCase();
function judge(candidate: string, forbidden: string) {
  const byPathReal = fold(realpathSync.native(candidate)).startsWith(
    fold(realpathSync.native(forbidden)) + "/",
  );
  const byPathTyped = fold(candidate).startsWith(fold(forbidden) + "/");
  const byIdentity = ancestorIds(candidate).includes(idOf(forbidden));
  return { byPathTyped, byPathReal, byIdentity };
}
const forbidden = join(root, "Docs");
for (const [label, candidate] of [
  ["candidate typed with other letter case (dOCS/sUBdIR)", join(root, "dOCS", "sUBdIR")],
  ["candidate in a sibling folder (Docs2/ , must NOT be inside)", join(root, "Docs2")],
  ["candidate exactly as stored (Docs/SubDir)", join(root, "Docs", "SubDir")],
] as const) {
  try {
    mkdirSync(candidate, { recursive: true });
  } catch {
    // may already exist under another case
  }
  console.log(`R48 ${label}: ${JSON.stringify(judge(candidate, forbidden))}`);
}
// reverse direction: the forbidden folder sits below the candidate
console.log(
  `R48 reverse (candidate is the parent of the forbidden folder): forbiddenAncestorIds includes candidate id = ${ancestorIds(forbidden).includes(idOf(root))}`,
);
