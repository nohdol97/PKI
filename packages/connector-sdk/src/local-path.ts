// The path boundary of local import (I02B-R5, R6, R46~R48): the one module that decides whether a
// path may be approved, walks an approved location and opens a file in it. Approval, the scan and the
// read all go through it; nothing else in the product touches an approved path.
//
// Every boundary failure closes: a path form nobody classified, an identity the OS does not give, a
// case sensitivity nobody knows is a rejection or a skip with a code from a closed list, never a
// fallback read. What is NOT closed is stated in I02B-R47: a folder swapped after the first check and
// put back before the last is not caught (Node cannot open a file relative to a folder handle).
// This module imports only node:fs, node:fs/promises and node:path (the SDK's import list).
import { constants as fsConstants, realpath as fsRealpath } from "node:fs";
import * as fsp from "node:fs/promises";
import nodePath from "node:path";

// --- the file system port ---------------------------------------------------------------------

/** What the boundary reads of a stat; `BigIntStats` satisfies it (a file number can exceed 2^53). */
export interface StatInfo {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileHandleLike {
  stat(): Promise<StatInfo>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** The calls the boundary makes, so a test can put a swap between any two of them. */
export interface BoundaryFs {
  /** `O_NOFOLLOW` and `O_NONBLOCK` are added only where the OS has them (Windows has no `O_NOFOLLOW`). */
  constants: { O_RDONLY: number; O_NOFOLLOW?: number | undefined; O_NONBLOCK?: number | undefined };
  lstat(path: string): Promise<StatInfo>;
  stat(path: string): Promise<StatInfo>;
  /** The OS's own answer (`fs.realpath.native`), not Node's own computation (I02B-R6). */
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  open(path: string, flags: number): Promise<FileHandleLike>;
  /** Throws when the place cannot be opened for reading; opens and closes, reads nothing. */
  probe(path: string, kind: "dir" | "file"): Promise<void>;
}

export const nodeBoundaryFs: BoundaryFs = {
  constants: {
    O_RDONLY: fsConstants.O_RDONLY,
    O_NOFOLLOW: fsConstants.O_NOFOLLOW,
    O_NONBLOCK: fsConstants.O_NONBLOCK,
  },
  lstat: (p) => fsp.lstat(p, { bigint: true }),
  stat: (p) => fsp.stat(p, { bigint: true }),
  realpath: (p) =>
    new Promise((resolve, reject) =>
      fsRealpath.native(p, (error, resolved) => (error ? reject(error) : resolve(resolved))),
    ),
  readdir: (p) => fsp.readdir(p),
  open: async (p, flags) => {
    const handle = await fsp.open(p, flags);
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
  probe: async (p, kind) => {
    if (kind === "dir") {
      await (await fsp.opendir(p)).close();
      return;
    }
    // O_NONBLOCK: a FIFO named as the file must not block the probe (the type check judges it)
    await (await fsp.open(p, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0))).close();
  },
};

// --- path shapes (I02B-R48): a pure function of the string, tested under both OS rules ----------

export type PathRules = "posix" | "win32";
/** The rules of the OS running this code. */
export const hostRules = (): PathRules => (nodePath.sep === "\\" ? "win32" : "posix");
const apiOf = (rules: PathRules) => (rules === "win32" ? nodePath.win32 : nodePath.posix);

/** The closed list of shapes refused as `unsupported-path-form`; a new shape is added here and in the tests. */
export const PATH_SHAPES = [
  "extended-prefix", // \\?\C:\…  \\.\PhysicalDrive0  \\?\Volume{…}\…  \??\…
  "drive-relative", // C:foo  C:
  "alternate-stream", // C:\a\b.md:stream
  "short-name", // C:\PROGRA~1\…
  "trailing-dot-or-space", // C:\a.\
  "reserved-device-name", // C:\CON\x
  "rooted-without-drive", // \foo  (this module's addition: not a form it classifies)
  "control-character", // a control character in the path (this module's addition)
] as const;
export type PathShape = (typeof PATH_SHAPES)[number];

export type PathClass =
  | { form: "ok" }
  | { form: "not-absolute" }
  | { form: "network-location" }
  | { form: "unsupported-path-form"; shape: PathShape };

const unsupported = (shape: PathShape): PathClass => ({ form: "unsupported-path-form", shape });
const hasControlCharacter = (path: string): boolean =>
  [...path].some((ch) => ch.charCodeAt(0) < 0x20);
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** An 8.3-looking part that carries `~digits` (`PROGRA~1`, `B~2.TXT`): maybe a short name the OS would expand. */
function looksLikeShortName(part: string): boolean {
  const dot = part.lastIndexOf(".");
  const base = dot > 0 ? part.slice(0, dot) : part;
  const ext = dot > 0 ? part.slice(dot + 1) : "";
  return base.length <= 8 && ext.length <= 3 && /~\d+$/.test(base);
}

/**
 * Which form a path string has, under the given OS rules (the host's by default). Order: not-absolute,
 * then the shape; a UNC path is decided by its shape alone, before any file system is asked, so the
 * product never touches the network to find out (I02B-R5).
 */
export function classifyPath(path: string, rules: PathRules = hostRules()): PathClass {
  const parts = path.split(rules === "win32" ? /[\\/]/ : /\//);
  if (path === "" || parts.includes("..")) return { form: "not-absolute" };
  if (rules === "posix") {
    if (!path.startsWith("/")) return { form: "not-absolute" };
    return hasControlCharacter(path) ? unsupported("control-character") : { form: "ok" };
  }
  const drive = /^[A-Za-z]:/.test(path);
  if (!drive && !/^[\\/]/.test(path)) return { form: "not-absolute" };
  if (hasControlCharacter(path)) return unsupported("control-character");
  if (/^[\\/]{2}[?.][\\/]UNC([\\/]|$)/i.test(path)) return { form: "network-location" };
  if (/^[\\/]{2}[?.]([\\/]|$)/.test(path) || /^\\\?\?\\/.test(path))
    return unsupported("extended-prefix");
  if (/^[\\/]{2}[^\\/]/.test(path)) return { form: "network-location" };
  if (!drive) return unsupported("rooted-without-drive");
  if (!/^[A-Za-z]:[\\/]/.test(path)) return unsupported("drive-relative");
  for (const part of path.slice(3).split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part.includes(":")) return unsupported("alternate-stream");
    if (/[. ]$/.test(part)) return unsupported("trailing-dot-or-space");
    if (RESERVED_DEVICE.test(part.split(".")[0] ?? "")) return unsupported("reserved-device-name");
    if (looksLikeShortName(part)) return unsupported("short-name");
  }
  return { form: "ok" };
}

// --- containment judged two ways (I02B-R48) -----------------------------------------------------

/** The parts of a path as compared: separators of both kinds, Unicode normalised, case folded. */
const foldedParts = (path: string): string[] =>
  path
    .toLowerCase()
    .normalize("NFC")
    .split(/[\\/]+/)
    .filter((part) => part !== "");
/** Part by part, never text by text (`/data/a` is not inside `/data/ab`). */
const isWithin = (inner: readonly string[], outer: readonly string[]): boolean =>
  outer.length <= inner.length && outer.every((part, i) => part === inner[i]);

export interface FileId {
  dev: bigint;
  ino: bigint;
}
/** The identity, or undefined when the OS gave none (a 0 in either number): then nothing can be compared. */
const idOf = (s: StatInfo): FileId | undefined =>
  s.dev === 0n || s.ino === 0n ? undefined : { dev: s.dev, ino: s.ino };
const sameId = (a: FileId, b: FileId) => a.dev === b.dev && a.ino === b.ino;

/**
 * The identities of a folder and of each ancestor up to the top of the volume; undefined when any of
 * them cannot be read or reads as 0 (then nothing is known and the caller closes).
 */
async function identityChain(
  fs: BoundaryFs,
  real: string,
  rules: PathRules,
): Promise<FileId[] | undefined> {
  const api = apiOf(rules);
  const chain: FileId[] = [];
  let current = real;
  for (;;) {
    let id: FileId | undefined;
    try {
      id = idOf(await fs.stat(current));
    } catch {
      return undefined;
    }
    if (!id) return undefined;
    chain.push(id);
    const up = api.dirname(current);
    if (up === current) return chain;
    current = up;
  }
}

/** A folder the product never reads: the data directory, the shell's user-data folder. */
export interface ExcludedFolder {
  /** Its folded paths: as given and as the OS resolved it. */
  paths: readonly (readonly string[])[];
  /** Its identity, when the OS gives one. */
  id: FileId | undefined;
}

export async function resolveExcluded(
  fs: BoundaryFs,
  paths: readonly string[],
): Promise<ExcludedFolder[]> {
  return Promise.all(
    paths.map(async (path) => {
      let real = path;
      try {
        real = await fs.realpath(path);
      } catch {
        /* a folder that does not exist yet: only its path can be compared */
      }
      let id: FileId | undefined;
      try {
        id = idOf(await fs.stat(real));
      } catch {
        id = undefined;
      }
      return { paths: [foldedParts(path), foldedParts(real)], id };
    }),
  );
}

// --- the approval check (I02B-R5) ---------------------------------------------------------------

/** The closed list of rejection codes, in the order the first match wins. */
export const APPROVAL_REJECTION_CODES = [
  "not-absolute",
  "unsupported-path-form",
  "not-found",
  "not-readable",
  "wrong-type",
  "identity-unavailable",
  "filesystem-root",
  "inside-data-directory",
  "overlaps-location",
  "network-location",
  "unsupported-format",
] as const;
export type ApprovalRejection = (typeof APPROVAL_REJECTION_CODES)[number];
export type ApprovalKind = "folder" | "file" | "jsonl-file";

/** The words the screen shows for a network location (I02B-R5, S25). */
export const NETWORK_LOCATION_NOTE = "미구현, 배포처 후속";

export interface ApprovalRequest {
  kind: ApprovalKind;
  path: string;
}
export interface ExistingLocation {
  id: string;
  realPath: string;
  /** The identity stored at approval, as decimal text. */
  rootDev: string;
  rootIno: string;
}
export interface ApprovalContext {
  fs?: BoundaryFs;
  /** The OS rules for the shape; the host's by default. */
  rules?: PathRules;
  /** The data directory and the shell's user-data folder. A place inside them, or equal, is refused. */
  forbidden: readonly string[];
  locations: readonly ExistingLocation[];
  /** A reconnect leaves the location itself out of the overlap check. */
  ignoreLocationId?: string;
  /** Whether a file name is one of the document formats (the boundary does not know the list). */
  isDocumentFile: (fileName: string) => boolean;
}
export type ApprovalResult =
  | { ok: true; displayPath: string; realPath: string; dev: string; ino: string }
  | { ok: false; code: ApprovalRejection; message?: string };

const rejected = (code: ApprovalRejection): ApprovalResult =>
  code === "network-location"
    ? { ok: false, code, message: `네트워크 위치는 승인할 수 없다 (${NETWORK_LOCATION_NOTE})` }
    : { ok: false, code };

const errorCode = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;

export async function checkApproval(
  request: ApprovalRequest,
  context: ApprovalContext,
): Promise<ApprovalResult> {
  const fs = context.fs ?? nodeBoundaryFs;
  const rules = context.rules ?? hostRules();
  const api = apiOf(rules);

  const shape = classifyPath(request.path, rules);
  if (shape.form !== "ok") return rejected(shape.form);

  let real: string;
  let stat: StatInfo;
  try {
    real = await fs.realpath(request.path);
    stat = await fs.stat(real);
  } catch (error) {
    const code = errorCode(error);
    return rejected(code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "not-readable");
  }
  try {
    await fs.probe(real, stat.isDirectory() ? "dir" : "file");
  } catch {
    return rejected("not-readable");
  }
  if (request.kind === "folder" ? !stat.isDirectory() : !stat.isFile())
    return rejected("wrong-type");
  const id = idOf(stat);
  if (!id) return rejected("identity-unavailable");
  if (api.dirname(real) === real) return rejected("filesystem-root");

  const candidate = [foldedParts(request.path), foldedParts(real)];
  let chain: FileId[] | undefined;
  let chainRead = false;
  const chainOfCandidate = async () => {
    if (!chainRead) {
      chain = await identityChain(fs, real, rules);
      chainRead = true;
    }
    return chain;
  };

  // inside the data directory or the user-data folder: by the folded path, and by identity
  for (const place of await resolveExcluded(fs, context.forbidden)) {
    if (candidate.some((c) => place.paths.some((p) => isWithin(c, p)))) {
      return rejected("inside-data-directory");
    }
    if (place.id) {
      const ancestors = await chainOfCandidate();
      // an identity nobody can read is not "outside" (fail closed)
      if (!ancestors || ancestors.some((a) => sameId(a, place.id as FileId))) {
        return rejected("inside-data-directory");
      }
    }
  }

  // overlap with another approved location: the same place, inside it, or containing it
  for (const location of context.locations) {
    if (location.id === context.ignoreLocationId) continue;
    const there = foldedParts(location.realPath);
    if (candidate.some((c) => isWithin(c, there) || isWithin(there, c))) {
      return rejected("overlaps-location");
    }
    const ancestors = await chainOfCandidate();
    const root: FileId = { dev: BigInt(location.rootDev), ino: BigInt(location.rootIno) };
    if (!ancestors || ancestors.some((a) => sameId(a, root))) return rejected("overlaps-location");
    // the other way round: the candidate lies above the location
    const above = await identityChain(fs, location.realPath, rules);
    if (above?.some((a) => sameId(a, id))) return rejected("overlaps-location");
  }

  const name = api.basename(real);
  if (request.kind === "jsonl-file" && !/\.jsonl$/i.test(name))
    return rejected("unsupported-format");
  if (request.kind === "file" && !context.isDocumentFile(name))
    return rejected("unsupported-format");

  return {
    ok: true,
    displayPath: request.path,
    realPath: real,
    dev: id.dev.toString(),
    ino: id.ino.toString(),
  };
}

// --- walking a location (I02B-R6) ---------------------------------------------------------------

export type WalkSkipReason =
  | "symlink"
  | "redirected"
  | "not-regular-file"
  | "path-too-long"
  | "too-deep"
  | "identity-unavailable"
  | "not-readable";

export type WalkEvent =
  | { kind: "file"; relativePath: string; size: number; mtimeNs: string; dev: string; ino: string }
  | { kind: "skip"; relativePath: string; reason: WalkSkipReason }
  /** A name on the ignore list, or a folder the product never reads: counted, not walked. */
  | { kind: "ignored"; relativePath: string }
  /** A folder that could not be listed: what is under it must not be taken as deleted (I02B-R19). */
  | { kind: "unreadable-dir"; relativePath: string };

export interface WalkOptions {
  fs?: BoundaryFs;
  /** The location's real path (the OS's answer, stored at approval). */
  rootRealPath: string;
  limits: { maxDepth: number; maxRelativePathChars: number };
  /** Names (not paths) that are counted and not walked. */
  ignore: (name: string) => boolean;
  excluded?: readonly ExcludedFolder[];
}

/**
 * Lists the regular files of a folder location, depth first, in name order. Relative paths are `/`
 * separated on every OS. It never follows a symlink and enters a folder only when its real path is the
 * location's real path plus its relative path (I02B-R6, R47 step 1). It reads no file.
 */
export async function* walkLocation(options: WalkOptions): AsyncGenerator<WalkEvent> {
  const fs = options.fs ?? nodeBoundaryFs;
  yield* walkDir(fs, options, options.rootRealPath, [], options.rootRealPath);
}

async function* walkDir(
  fs: BoundaryFs,
  options: WalkOptions,
  dir: string,
  relParts: readonly string[],
  expectedReal: string,
): AsyncGenerator<WalkEvent> {
  const relativePath = relParts.join("/");
  let real: string;
  let dirStat: StatInfo;
  try {
    real = await fs.realpath(dir);
    dirStat = await fs.stat(real);
  } catch {
    yield { kind: "unreadable-dir", relativePath };
    return;
  }
  if (real !== expectedReal) {
    yield { kind: "skip", relativePath, reason: "redirected" };
    return;
  }
  const dirId = idOf(dirStat);
  if (!dirId) {
    yield { kind: "skip", relativePath, reason: "identity-unavailable" };
    return;
  }
  const folded = foldedParts(real);
  for (const place of options.excluded ?? []) {
    if (place.paths.some((p) => isWithin(folded, p)) || (place.id && sameId(place.id, dirId))) {
      yield { kind: "ignored", relativePath };
      return;
    }
  }
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    yield { kind: "unreadable-dir", relativePath };
    return;
  }
  for (const name of names.sort()) {
    const childParts = [...relParts, name];
    const childRel = childParts.join("/");
    if (options.ignore(name)) {
      yield { kind: "ignored", relativePath: childRel };
      continue;
    }
    if (childRel.length > options.limits.maxRelativePathChars) {
      yield { kind: "skip", relativePath: childRel, reason: "path-too-long" };
      continue;
    }
    if (childParts.length > options.limits.maxDepth) {
      yield { kind: "skip", relativePath: childRel, reason: "too-deep" };
      continue;
    }
    const child = nodePath.join(dir, name);
    let stat: StatInfo;
    try {
      stat = await fs.lstat(child);
    } catch {
      yield { kind: "skip", relativePath: childRel, reason: "not-readable" };
      continue;
    }
    if (stat.isSymbolicLink()) {
      yield { kind: "skip", relativePath: childRel, reason: "symlink" };
    } else if (stat.isDirectory()) {
      yield* walkDir(fs, options, child, childParts, nodePath.join(expectedReal, name));
    } else if (stat.isFile()) {
      const id = idOf(stat);
      if (!id) yield { kind: "skip", relativePath: childRel, reason: "identity-unavailable" };
      else {
        yield {
          kind: "file",
          relativePath: childRel,
          size: Number(stat.size),
          mtimeNs: stat.mtimeNs.toString(),
          dev: id.dev.toString(),
          ino: id.ino.toString(),
        };
      }
    } else {
      yield { kind: "skip", relativePath: childRel, reason: "not-regular-file" };
    }
  }
}

// --- reading one file (I02B-R47) ----------------------------------------------------------------

export type ReadFailure =
  | "symlink"
  | "redirected"
  | "not-regular-file"
  | "identity-unavailable"
  | "not-readable"
  | "locked"
  | "too-large";

export type ReadResult =
  | { ok: true; bytes: Uint8Array; size: number; mtimeNs: string; dev: string; ino: string }
  | { ok: false; reason: ReadFailure };

export interface ReadOptions {
  fs?: BoundaryFs;
  rootRealPath: string;
  /** `/`-separated, below the root; empty for a `file` location (the root is the file). */
  relativePath: string;
  kind: "folder" | "file";
  maxFileBytes: number;
}

const READ_CHUNK_BYTES = 65_536;
const fail = (reason: ReadFailure): ReadResult => ({ ok: false, reason });

/**
 * Reads one file in the one order of I02B-R47: ① the folder's real path is the expected one and its
 * identity is noted, ② `lstat` the name (a regular file, not a symlink, an identity), ③ open with
 * `O_NOFOLLOW` and `O_NONBLOCK` where the OS has them, ④ `fstat` the handle (regular, the same
 * identity as ②), ⑤ read from that handle up to `maxFileBytes`, ⑥ measure the folder again and drop
 * the bytes if it changed. A swap put back before ⑥ is not caught (I02B-R47: reduced, not closed).
 */
export async function readLocationFile(options: ReadOptions): Promise<ReadResult> {
  const fs = options.fs ?? nodeBoundaryFs;
  const parts = options.kind === "file" ? [] : options.relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    return fail("not-readable");
  const target = nodePath.join(options.rootRealPath, ...parts);
  const parent = nodePath.dirname(target);
  const expectedParent =
    options.kind === "file" ? parent : nodePath.join(options.rootRealPath, ...parts.slice(0, -1));

  const measureParent = async (): Promise<{ real: string; id: FileId | undefined }> => {
    const real = await fs.realpath(parent);
    return { real, id: idOf(await fs.stat(parent)) };
  };

  // ① the folder
  let before: { real: string; id: FileId | undefined };
  try {
    before = await measureParent();
  } catch {
    return fail("not-readable");
  }
  if (before.real !== expectedParent) return fail("redirected");
  if (!before.id) return fail("identity-unavailable");

  // ② the name
  let named: FileId | undefined;
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return fail("symlink");
    if (!stat.isFile()) return fail("not-regular-file");
    named = idOf(stat);
  } catch {
    return fail("not-readable");
  }
  if (!named) return fail("identity-unavailable");

  // ③ open
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let handle: FileHandleLike;
  try {
    handle = await fs.open(target, flags);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ELOOP") return fail("redirected");
    return fail(code === "EBUSY" || code === "ETXTBSY" ? "locked" : "not-readable");
  }
  try {
    // ④ the handle is the file the name showed
    const opened = await handle.stat();
    if (!opened.isFile()) return fail("not-regular-file");
    const openedId = idOf(opened);
    if (!openedId) return fail("identity-unavailable");
    if (!sameId(openedId, named)) return fail("redirected");
    if (opened.size > BigInt(options.maxFileBytes)) return fail("too-large");

    // ⑤ read from the handle only
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = new Uint8Array(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > options.maxFileBytes) return fail("too-large");
      chunks.push(chunk.subarray(0, bytesRead));
    }

    // ⑥ the folder again; a change drops the bytes
    let after: { real: string; id: FileId | undefined };
    try {
      after = await measureParent();
    } catch {
      return fail("redirected");
    }
    if (after.real !== before.real || !after.id || !sameId(after.id, before.id)) {
      return fail("redirected");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      ok: true,
      bytes,
      size: total,
      mtimeNs: opened.mtimeNs.toString(),
      dev: openedId.dev.toString(),
      ino: openedId.ino.toString(),
    };
  } catch {
    return fail("not-readable");
  } finally {
    await handle.close().catch(() => undefined);
  }
}
