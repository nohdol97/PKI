// I02B-T01 PoC (throwaway), I02B-R47 / G14: the six-step open order, run for real on the dev OS.
// The swaps happen at fixed points through hooks (after step 1, after step 2, after step 5), so
// each case tests whether the later comparison catches that swap; it does not hope to win a race.
// Usage: node r47-open-order.ts <scratchDir>   (an empty directory this script may fill)
import { execFileSync, spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const mkfifo = async (path: string) => void execFileSync("mkfifo", [path]);

type Id = { dev: bigint; ino: bigint };
const idOf = (s: { dev: bigint; ino: bigint }): Id => ({ dev: s.dev, ino: s.ino });
const same = (a: Id, b: Id) => a.dev === b.dev && a.ino === b.ino;

interface Hooks {
  after1?: () => Promise<void>;
  after2?: () => Promise<void>;
  after5?: () => Promise<void>;
}
interface Flags {
  noFollow: boolean;
  nonBlock: boolean;
}
type Outcome = { status: "ok"; text: string } | { status: "skipped"; why: string };

async function parentState(dir: string) {
  return { real: realpathSync.native(dir), id: idOf(await stat(dir, { bigint: true })) };
}

/** I02B-R47 steps 1 to 6 for `dir/name`. */
export async function readInOrder(
  dir: string,
  name: string,
  flags: Flags,
  hooks: Hooks = {},
): Promise<Outcome> {
  const path = join(dir, name);
  const p1 = await parentState(dir); // 1
  await hooks.after1?.();
  const l = await lstat(path, { bigint: true }); // 2
  if (l.isSymbolicLink() || !l.isFile())
    return { status: "skipped", why: "step2: not a regular file" };
  if (l.ino === 0n) return { status: "skipped", why: "identity-unavailable" };
  const named = idOf(l);
  await hooks.after2?.();
  let handle;
  try {
    // 3
    handle = await open(
      path,
      constants.O_RDONLY |
        (flags.noFollow ? (constants.O_NOFOLLOW ?? 0) : 0) |
        (flags.nonBlock ? (constants.O_NONBLOCK ?? 0) : 0),
    );
  } catch (error) {
    return { status: "skipped", why: `step3: open failed ${(error as { code?: string }).code}` };
  }
  try {
    const f = await handle.stat({ bigint: true }); // 4
    if (!f.isFile()) return { status: "skipped", why: "step4: handle is not a regular file" };
    if (!same(idOf(f), named))
      return { status: "skipped", why: "step4: redirected (identity differs)" };
    const text = (await handle.readFile()).toString(); // 5
    await hooks.after5?.();
    const p6 = await parentState(dir); // 6
    if (p6.real !== p1.real || !same(p6.id, p1.id))
      return { status: "skipped", why: "step6: redirected (parent changed), bytes discarded" };
    return { status: "ok", text };
  } finally {
    await handle.close();
  }
}

const results: string[] = [];
const line = (s: string) => {
  results.push(s);
  console.log(s);
};
const show = (o: Outcome) => (o.status === "ok" ? `ok, read "${o.text}"` : `skipped (${o.why})`);

const root = process.argv[2];
if (!root) throw new Error("usage: r47-open-order.ts <scratchDir>");
await mkdir(root, { recursive: true });
console.log(`node ${process.version} ${process.platform}-${process.arch}`);
console.log(`uname: ${execFileSync("uname", ["-sr"]).toString().trim()}`);

// --- identity agreement, same file and different files (G14) ---
{
  const d = join(root, "ident");
  await mkdir(d);
  const N = 500;
  const ids = new Set<string>();
  let agree = 0;
  let crossEqual = 0;
  let zero = 0;
  for (let i = 0; i < N; i++) {
    await writeFile(join(d, `f${i}.txt`), `f${i}`);
  }
  for (let i = 0; i < N; i++) {
    const l = await lstat(join(d, `f${i}.txt`), { bigint: true });
    const h = await open(
      join(d, `f${i}.txt`),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const f = await h.stat({ bigint: true });
    await h.close();
    if (same(idOf(l), idOf(f))) agree++;
    if (l.ino === 0n || l.dev === 0n) zero++;
    ids.add(`${l.dev}:${l.ino}`);
    const other = await lstat(join(d, `f${(i + 1) % N}.txt`), { bigint: true });
    if (same(idOf(l), idOf(other))) crossEqual++;
  }
  line(
    `identity: files=${N} lstat==fstat for ${agree}/${N}; distinct (dev,ino)=${ids.size}/${N}; neighbour-pair equal=${crossEqual}; zero dev/ino=${zero}`,
  );
}

for (const [label, flags] of [
  ["POSIX flags (O_NOFOLLOW|O_NONBLOCK)", { noFollow: true, nonBlock: true }],
  ["Windows-like flags (no O_NOFOLLOW)", { noFollow: false, nonBlock: true }],
] as const) {
  line(`--- ${label} ---`);
  const base = join(root, flags.noFollow ? "posix" : "winlike");
  await mkdir(base);

  // control
  {
    const d = join(base, "c0");
    await mkdir(d);
    await writeFile(join(d, "a.txt"), "ORIGINAL");
    line(`control, no swap: ${show(await readInOrder(d, "a.txt", flags))}`);
  }
  // symlink swapped in between 2 and 3 (the name now points at another regular file in the folder)
  {
    const d = join(base, "c1");
    await mkdir(d);
    await writeFile(join(d, "a.txt"), "ORIGINAL");
    await writeFile(join(d, "other.txt"), "OTHER");
    const r = await readInOrder(d, "a.txt", flags, {
      after2: async () => {
        await unlink(join(d, "a.txt"));
        await symlink(join(d, "other.txt"), join(d, "a.txt"));
      },
    });
    line(`symlink swapped between 2 and 3 (to a regular file): ${show(r)}`);
  }
  // symlink to a file OUTSIDE the folder
  {
    const d = join(base, "c1b");
    await mkdir(d);
    await mkdir(join(base, "c1b-out"));
    await writeFile(join(base, "c1b-out", "secret.txt"), "OUTSIDE");
    await writeFile(join(d, "a.txt"), "ORIGINAL");
    const r = await readInOrder(d, "a.txt", flags, {
      after2: async () => {
        await unlink(join(d, "a.txt"));
        await symlink(join(base, "c1b-out", "secret.txt"), join(d, "a.txt"));
      },
    });
    line(`symlink swapped between 2 and 3 (to a file outside the folder): ${show(r)}`);
  }
  // another regular file renamed over the name
  {
    const d = join(base, "c2");
    await mkdir(d);
    await writeFile(join(d, "a.txt"), "ORIGINAL");
    await writeFile(join(d, "b.txt"), "REPLACEMENT");
    const r = await readInOrder(d, "a.txt", flags, {
      after2: () => rename(join(d, "b.txt"), join(d, "a.txt")),
    });
    line(`another regular file renamed over the name between 2 and 3: ${show(r)}`);
  }
  // FIFO swapped in
  {
    const d = join(base, "c3");
    await mkdir(d);
    await writeFile(join(d, "a.txt"), "ORIGINAL");
    const t0 = performance.now();
    const r = await readInOrder(d, "a.txt", flags, {
      after2: async () => {
        await unlink(join(d, "a.txt"));
        await mkfifo(join(d, "a.txt"));
      },
    });
    line(
      `FIFO swapped in between 2 and 3: ${show(r)} in ${(performance.now() - t0).toFixed(0)} ms`,
    );
  }
  // parent folder swapped for a symlink to another folder after step 1 and left that way
  {
    const d = join(base, "c4");
    await mkdir(join(d, "dir"), { recursive: true });
    await mkdir(join(d, "elsewhere"));
    await writeFile(join(d, "dir", "a.txt"), "ORIGINAL");
    await writeFile(join(d, "elsewhere", "a.txt"), "ELSEWHERE");
    const r = await readInOrder(join(d, "dir"), "a.txt", flags, {
      after1: async () => {
        await rename(join(d, "dir"), join(d, "dir-away"));
        await symlink(join(d, "elsewhere"), join(d, "dir"));
      },
    });
    line(`parent swapped for a symlink after step 1, left in place: ${show(r)}`);
  }
  // parent swapped after 1 and put back before 6 (the gap R47 says it does not close)
  {
    const d = join(base, "c5");
    await mkdir(join(d, "dir"), { recursive: true });
    await mkdir(join(d, "elsewhere"));
    await writeFile(join(d, "dir", "a.txt"), "ORIGINAL");
    await writeFile(join(d, "elsewhere", "a.txt"), "ELSEWHERE");
    const r = await readInOrder(join(d, "dir"), "a.txt", flags, {
      after1: async () => {
        await rename(join(d, "dir"), join(d, "dir-away"));
        await symlink(join(d, "elsewhere"), join(d, "dir"));
      },
      after5: async () => {
        await unlink(join(d, "dir"));
        await rename(join(d, "dir-away"), join(d, "dir"));
      },
    });
    line(`parent swapped after step 1, put back after step 5 (the documented gap): ${show(r)}`);
  }
}

// --- the FIFO open without O_NONBLOCK really blocks (why R47 step 3 has the flag) ---
{
  const d = join(root, "fifo-block");
  await mkdir(d);
  const fifo = join(d, "f");
  await mkfifo(fifo);
  const code = `const fs=require("node:fs");const t=Date.now();fs.open(${JSON.stringify(fifo)},"r",(e,fd)=>{console.log("opened after",Date.now()-t,"ms");process.exit(0)});`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c));
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const t0 = performance.now();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  const blocked = child.exitCode === null;
  if (blocked) child.kill("SIGKILL");
  await exited;
  line(
    `plain open() of a FIFO with no writer, no O_NONBLOCK: ${blocked ? "still blocked after 3000 ms (child killed)" : `returned: ${out.trim()}`} (elapsed ${(performance.now() - t0).toFixed(0)} ms)`,
  );
}

// --- inode reuse: does delete + create hand the new file the old file's (dev, ino)? ---
{
  const d = join(root, "reuse");
  await mkdir(d);
  let reused = 0;
  const N = 200;
  for (let i = 0; i < N; i++) {
    await writeFile(join(d, "a"), "x");
    const before = idOf(await lstat(join(d, "a"), { bigint: true }));
    await unlink(join(d, "a"));
    await writeFile(join(d, "a"), "y");
    const after = idOf(await lstat(join(d, "a"), { bigint: true }));
    if (same(before, after)) reused++;
    await unlink(join(d, "a"));
  }
  line(`delete then create at the same name: (dev,ino) reused ${reused}/${N}`);
}
// hard link: two names, one identity (informational: R47 treats it as the same file)
{
  const d = join(root, "hl");
  await mkdir(d);
  await writeFile(join(d, "a"), "x");
  await link(join(d, "a"), join(d, "b"));
  const a = await lstat(join(d, "a"), { bigint: true });
  const b = await lstat(join(d, "b"), { bigint: true });
  line(`hard link: two names, same (dev,ino)=${same(idOf(a), idOf(b))}, nlink=${a.nlink}`);
}
await rm(root, { recursive: true, force: true }).catch(() => undefined);
