// I02B-T01 PoC (throwaway), G5 (+ the G14 identity facts on this volume): after a rename inside
// one volume, do `stat` dev and ino stay? Also: copy and cross-volume move (expected to change),
// a directory rename (children keep theirs), a rename over an existing name.
// Usage: node g5-rename-identity.ts <emptyDirOnTheVolume> [otherVolumeDir]
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [dir, other] = process.argv.slice(2);
if (!dir) throw new Error("usage: g5-rename-identity.ts <dir> [otherVolumeDir]");
await mkdir(dir, { recursive: true });
console.log(`node ${process.version} ${process.platform}-${process.arch}`);
const device =
  execFileSync("df", [dir]).toString().trim().split("\n").at(-1)?.split(/\s+/)[0] ?? "?";
console.log(
  `volume: ${
    execFileSync("mount")
      .toString()
      .split("\n")
      .find((l) => l.startsWith(`${device} on `)) ?? device
  }`,
);
const N = 200;
const key = async (p: string) => {
  const s = await stat(p, { bigint: true });
  return `${s.dev}:${s.ino}`;
};

const names = Array.from({ length: N }, (_, i) => `f${i}.txt`);
await mkdir(join(dir, "a"));
await mkdir(join(dir, "b"));
for (const n of names) await writeFile(join(dir, "a", n), n);
const before = new Map<string, string>();
for (const n of names) before.set(n, await key(join(dir, "a", n)));

// identity facts (G14): lstat vs fstat, distinct, zero
{
  let agree = 0;
  let zero = 0;
  const distinct = new Set<string>();
  for (const n of names) {
    const l = await lstat(join(dir, "a", n), { bigint: true });
    const h = await open(join(dir, "a", n), constants.O_RDONLY);
    const f = await h.stat({ bigint: true });
    await h.close();
    if (l.dev === f.dev && l.ino === f.ino) agree++;
    if (l.ino === 0n) zero++;
    distinct.add(`${l.dev}:${l.ino}`);
  }
  console.log(
    `identity (G14): lstat==fstat ${agree}/${N}; distinct (dev,ino) ${distinct.size}/${N}; ino==0 ${zero}`,
  );
}

let kept = 0;
for (const n of names) {
  await rename(join(dir, "a", n), join(dir, "a", `r-${n}`));
  if ((await key(join(dir, "a", `r-${n}`))) === before.get(n)) kept++;
}
console.log(`rename in the same folder: (dev,ino) kept ${kept}/${N}`);

kept = 0;
for (const n of names) {
  await rename(join(dir, "a", `r-${n}`), join(dir, "b", n));
  if ((await key(join(dir, "b", n))) === before.get(n)) kept++;
}
console.log(`move to another folder, same volume: (dev,ino) kept ${kept}/${N}`);

await rename(join(dir, "b"), join(dir, "b-renamed"));
kept = 0;
for (const n of names) if ((await key(join(dir, "b-renamed", n))) === before.get(n)) kept++;
console.log(`rename of the parent folder: children (dev,ino) kept ${kept}/${N}`);

// a rename over an existing file: the name now has the source's identity, the old one is gone
await writeFile(join(dir, "victim.txt"), "v");
await writeFile(join(dir, "src.txt"), "s");
const victim = await key(join(dir, "victim.txt"));
const src = await key(join(dir, "src.txt"));
await rename(join(dir, "src.txt"), join(dir, "victim.txt"));
const now = await key(join(dir, "victim.txt"));
console.log(
  `rename over an existing name: name now has the moved file's identity=${now === src}, old victim identity=${now === victim ? "still" : "gone"}`,
);

// copy: a new file, a new identity
kept = 0;
for (const n of names.slice(0, 50)) {
  await copyFile(join(dir, "b-renamed", n), join(dir, `copy-${n}`));
  if ((await key(join(dir, `copy-${n}`))) === before.get(n)) kept++;
}
console.log(`copy: new file has the same (dev,ino) as the original in ${kept}/50 (expected 0)`);

if (other) {
  await mkdir(other, { recursive: true });
  let exdev = 0;
  let moved = 0;
  let sameIno = 0;
  for (const n of names.slice(0, 20)) {
    try {
      await rename(join(dir, "b-renamed", n), join(other, n));
      moved++;
      if ((await key(join(other, n))) === before.get(n)) sameIno++;
    } catch (e) {
      if ((e as { code?: string }).code === "EXDEV") exdev++;
    }
  }
  console.log(
    `rename to another volume: EXDEV ${exdev}/20, moved ${moved}/20, identity kept in ${sameIno}`,
  );
}
await rm(dir, { recursive: true, force: true });
