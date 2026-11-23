// The `local-files` connector (I02B-R1, R4, R11~R16, R19, R21, R26): the folders the user approved,
// read as Connector changes. It touches the outside only through ports: the index (a function bundle
// over the canonical store), the isolated normalizer, the settings and the clock; the disk only through
// the path boundary of @pki/connector-sdk. It is not registered anywhere yet (I02B-T03b).
//
// One sync is one pass over every readable location, then a read of the index after the cursor:
//  - the pass walks a location, pairs the files with the index entries (same path; else same content for
//    a moved file) and writes the result to the index with compare-and-set writes (I02B-R33);
//  - the read takes the entries with a sequence above the cursor and turns each into a change: a
//    present entry is read again, checked against the hash the index holds, normalized and emitted; a
//    deleted entry becomes `delete`. A skipped entry is no change; it stays in the index with its reason.
// The cursor is the greatest sequence number handed out, so every page, a null-cursor rescan and a
// deletion (I02B-R19) all come from the same index rows.
import {
  CONNECTOR_SDK_VERSION,
  ConnectorError,
  ISO_WITH_OFFSET,
  LOCAL_SKIP_REASONS,
  type Change,
  type ChangeSet,
  type Connector,
  type LocalFilesLimits,
  type LocalIndexEntry,
  type LocalIndexFields,
  type LocalIndexPort,
  type LocalLocationReport,
  type LocalLocationView,
  type LocalNormalizerPort,
  type LocalNormalizeResult,
  type LocalPassReport,
  type LocalSkipReason,
  type SourceRecord,
} from "@pki/contracts";
import {
  nodeBoundaryFs,
  readLocationFile,
  resolveExcluded,
  walkLocation,
  type BoundaryFs,
  type ExcludedFolder,
  type ReadFailure,
  type WalkSkipReason,
} from "@pki/connector-sdk";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, extname } from "node:path";

/** What the composition point hands the connector (I02B-R4). */
export interface LocalFilesPorts {
  index: LocalIndexPort;
  locations: () => readonly LocalLocationView[];
  normalizer: LocalNormalizerPort;
  /** The normalizer's `NORMALIZER_VERSION` (I02B-R14). */
  normalizerVersion: number;
  /** Folders a pass never reads: the data directory, the shell's user-data folder. */
  excluded: () => readonly string[];
  limits: () => LocalFilesLimits;
  /** Milliseconds, the wall clock. */
  now: () => number;
  /**
   * Moves a location to a state the pass found it in (I02B-R7); `active` is a reopening. Only from `expected`,
   * the state the pass decided from: false when the user changed it meanwhile (a pause is not overwritten).
   */
  setLocationState: (
    id: string,
    state: "active" | "paused" | "unavailable" | "needs-confirmation" | "revoking",
    reason: string | null,
    expected: "active" | "paused" | "unavailable" | "needs-confirmation" | "revoking",
  ) => boolean;
  /** Told what a finished sync learned, for the location list. */
  report?: (report: LocalPassReport) => void;
  fs?: BoundaryFs;
}

/** Names that are counted and not walked (I02B-R15). */
export const LOCAL_IGNORE_RULES = {
  prefixes: ["~$", ".~lock.", "."],
  suffixes: ["~", ".tmp", ".swp", ".swx", ".part", ".crdownload"],
  names: [".DS_Store", "Thumbs.db", "desktop.ini", "node_modules"],
} as const;

const isIgnored = (name: string): boolean =>
  LOCAL_IGNORE_RULES.prefixes.some((p) => name.startsWith(p)) ||
  LOCAL_IGNORE_RULES.suffixes.some((s) => name.endsWith(s)) ||
  (LOCAL_IGNORE_RULES.names as readonly string[]).includes(name);

/** The formats the normalizer reads, by extension (a `.jsonl` file is not a document: I02B-R42). */
const FORMAT_OF_EXTENSION: Readonly<Record<string, string>> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "txt",
  ".html": "html",
  ".htm": "html",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".csv": "csv",
  ".json": "json",
  ".pdf": "pdf",
};
const formatOf = (path: string): string | undefined =>
  FORMAT_OF_EXTENSION[extname(path).toLowerCase()];

/** Whether a file name is one of the document formats: what a `file` location may be approved for (I02B-R5). */
export const isDocumentFileName = (name: string): boolean => formatOf(name) !== undefined;

/**
 * Every code a walk, a read or the normalizer can fail with is a skip reason (I02B-R16): a code added
 * to one of those lists without a place in `LOCAL_SKIP_REASONS` stops compiling here.
 */
type Assert<T extends true> = T;
export type SkipReasonsAreClosed = Assert<
  Exclude<WalkSkipReason | Exclude<ReadFailure, "excluded">, LocalSkipReason> extends never
    ? true
    : false
>;

const asSkipReason = (code: string): LocalSkipReason =>
  Object.hasOwn(LOCAL_SKIP_REASONS, code) ? (code as LocalSkipReason) : "corrupt";
const readSkipReason = (failure: ReadFailure): LocalSkipReason =>
  failure === "excluded" ? "not-readable" : failure;
const retryOf = (reason: string | null): "every-pass" | "on-change" =>
  reason !== null && Object.hasOwn(LOCAL_SKIP_REASONS, reason)
    ? LOCAL_SKIP_REASONS[reason as LocalSkipReason].retry
    : "on-change";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const newId = () => randomBytes(16).toString("base64url");
const iso = (ms: number) => new Date(ms).toISOString();
const msOf = (mtimeNs: string) => Number(BigInt(mtimeNs) / 1_000_000n);
const limitsKey = (l: LocalFilesLimits) =>
  `${l.normalize.maxHeapMb}:${l.normalize.maxExternalMemoryBytes}`;
const fileNoOf = (dev: string, ino: string) => `${dev}:${ino}`;
const idOfFileNo = (fileNo: string): { dev: string; ino: string } => {
  const [dev = "", ino = ""] = fileNo.split(":");
  return { dev, ino };
};

type RootProblem = "root-missing" | "root-not-readable" | "root-changed";

interface WalkedFile {
  path: string;
  size: number;
  mtimeNs: string;
  dev: string;
  ino: string;
}

/** What one sync's pass remembers between its pages. */
interface Pass {
  id: string;
  /** The normalizer was called broken: nothing more is normalized (I02B-R23). */
  unavailable: boolean;
  /** Entries this pass skipped as `resource-exceeded` after a death nobody explained. */
  blamed: string[];
  reports: Map<string, LocalLocationReport>;
  excluded: ExcludedFolder[];
}

const CURSOR = /^(\d+)(?:\.([A-Za-z0-9_-]+))?$/;

export function createLocalFilesConnector(bound: () => LocalFilesPorts | undefined): Connector {
  let ports: LocalFilesPorts | undefined;
  let initialized = false;
  let open: Pass | undefined;
  /** What the settle condition has seen of a file (I02B-R15): kept in memory, a restart waits once more. */
  const observed = new Map<string, { size: number; mtimeNs: string; at: number }>();
  /** Sequence numbers this connector gave an entry only to note its size or time: no change to announce. */
  const silent = new Set<number>();

  const configured = (): LocalFilesPorts => {
    if (!initialized) throw new Error("local-files Connector is not initialized");
    if (!ports)
      throw new ConnectorError("local-files: the ports are not bound", { retryable: true });
    return ports;
  };

  // --- reading one file --------------------------------------------------------------------------

  /**
   * The one place a file is opened. The identity passed is the one the walk saw (kept in the index as
   * `fileNo`), never one measured again here: a name swapped after the walk must not read as the file.
   */
  async function readFile(
    p: LocalFilesPorts,
    pass: Pass | undefined,
    location: LocalLocationView,
    path: string,
    seen: { dev: string; ino: string },
  ) {
    const fs = p.fs ?? nodeBoundaryFs;
    const single = location.type === "file";
    return readLocationFile({
      fs,
      rootRealPath: location.realPath,
      relativePath: single ? "" : path,
      kind: single ? "file" : "folder",
      maxFileBytes: p.limits().maxFileBytes,
      excluded: pass?.excluded ?? (await resolveExcluded(fs, p.excluded())),
      expectedId: seen,
    });
  }

  const fieldsOf = (e: LocalIndexEntry): LocalIndexFields => ({
    relativePath: e.relativePath as string,
    size: e.size,
    mtimeNs: e.mtimeNs,
    contentHash: e.contentHash,
    fileNo: e.fileNo,
    revision: e.revision,
    normalizerVersion: e.normalizerVersion,
    state: e.state === "skipped" ? "skipped" : "present",
    pendingDelete: e.pendingDelete,
    skipReason: e.skipReason,
    skippedAt: e.skippedAt,
    skipLimits: e.skipLimits,
  });

  /** Writes an entry as skipped with a reason; a write that does not apply is dropped (I02B-R33). */
  function writeSkip(
    p: LocalFilesPorts,
    e: LocalIndexEntry,
    reason: LocalSkipReason,
    over: Partial<LocalIndexFields> = {},
  ) {
    return p.index.updateEntry(e.externalId, e.seq, {
      ...fieldsOf(e),
      ...over,
      state: "skipped",
      skipReason: reason,
      skippedAt: iso(p.now()),
      skipLimits: reason === "resource-exceeded" ? limitsKey(p.limits()) : null,
    });
  }

  // --- the pass ----------------------------------------------------------------------------------

  /** The settle condition of a new or changed file (I02B-R15). */
  function settled(key: string, f: WalkedFile, now: number, settleMs: number): boolean {
    const before = observed.get(key);
    if (!before || before.size !== f.size || before.mtimeNs !== f.mtimeNs) {
      observed.set(key, { size: f.size, mtimeNs: f.mtimeNs, at: now });
      return false;
    }
    return now - before.at >= settleMs && now - msOf(f.mtimeNs) > settleMs;
  }

  /**
   * Why the location is not the folder that was approved, or null when it is (I02B-R7): it cannot be
   * opened, or its real path or identity (`dev`, `ino`) differs. Nothing is read or deleted otherwise.
   */
  async function rootProblem(
    fs: BoundaryFs,
    location: LocalLocationView,
  ): Promise<RootProblem | null> {
    try {
      if ((await fs.realpath(location.realPath)) !== location.realPath) return "root-changed";
      const stat = await fs.stat(location.realPath);
      return stat.isDirectory() &&
        String(stat.dev) === location.rootDev &&
        String(stat.ino) === location.rootIno
        ? null
        : "root-changed";
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return code === "EACCES" || code === "EPERM" ? "root-not-readable" : "root-missing";
    }
  }

  /**
   * The `file` kind's root (I02B-R3): the file itself. Its real path is the approved one and it is a regular
   * file; its identity is not compared, because an editor that saves by writing a new file and renaming it
   * gives the same path another number (a change of content, not of place). A name that is gone while the
   * folder that held it still reads is a deleted file (`file-gone`, announced as a deletion); a folder that
   * is gone too is the disk's absence (`root-missing`).
   */
  async function fileRootProblem(
    fs: BoundaryFs,
    location: LocalLocationView,
  ): Promise<RootProblem | "file-gone" | null> {
    try {
      if ((await fs.realpath(location.realPath)) !== location.realPath) return "root-changed";
      return (await fs.stat(location.realPath)).isFile() ? null : "root-changed";
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "EACCES" || code === "EPERM") return "root-not-readable";
      try {
        await fs.stat(dirname(location.realPath));
        return "file-gone";
      } catch {
        return "root-missing";
      }
    }
  }

  /** The one file of a `file` location, as the walk of a folder would give it. */
  async function* singleFile(
    fs: BoundaryFs,
    location: LocalLocationView,
  ): AsyncGenerator<
    | {
        kind: "file";
        relativePath: string;
        size: number;
        mtimeNs: string;
        dev: string;
        ino: string;
      }
    | { kind: "skip"; relativePath: string; reason: WalkSkipReason }
  > {
    const relativePath = basename(location.realPath);
    try {
      const stat = await fs.lstat(location.realPath);
      if (stat.isSymbolicLink()) yield { kind: "skip", relativePath, reason: "symlink" };
      else if (!stat.isFile()) yield { kind: "skip", relativePath, reason: "not-regular-file" };
      else if (stat.dev === 0n || stat.ino === 0n) {
        yield { kind: "skip", relativePath, reason: "identity-unavailable" };
      } else {
        yield {
          kind: "file",
          relativePath,
          size: Number(stat.size),
          mtimeNs: stat.mtimeNs.toString(),
          dev: stat.dev.toString(),
          ino: stat.ino.toString(),
        };
      }
    } catch {
      yield { kind: "skip", relativePath, reason: "not-readable" };
    }
  }

  async function scanLocation(
    p: LocalFilesPorts,
    pass: Pass,
    location: LocalLocationView,
    full: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const limits = p.limits();
    const fs = p.fs ?? nodeBoundaryFs;
    const now = p.now();
    const report: LocalLocationReport = {
      locationId: location.id,
      walked: 0,
      sourced: 0,
      skipped: 0,
      ignored: 0,
      pending: 0,
      limitExceeded: false,
      rootUnavailable: false,
      forgottenPaths: [],
    };
    pass.reports.set(location.id, report);
    const single = location.type === "file";
    const checked = single ? await fileRootProblem(fs, location) : await rootProblem(fs, location);
    const gone = checked === "file-gone";
    const problem = gone ? null : checked;
    if (problem !== null) {
      report.rootUnavailable = true;
      if (location.state !== "unavailable" || location.stateReason !== problem) {
        p.setLocationState(location.id, "unavailable", problem, location.state);
      }
      return;
    }
    // a root that was away and fits again is read again; one whose identity changed waits for the
    // user's relink (I02B-R7, R9)
    // the state the pass decides from from here on: a return makes it `active`, so held deletions put the
    // location back to `needs-confirmation` in this pass (I02B-R7); a user's change since the snapshot ends the pass
    let state = location.state;
    if (state === "unavailable") {
      if (!p.setLocationState(location.id, "active", null, "unavailable")) return;
      state = "active";
    }

    // walk; a thrown traversal rejects the sync and nothing is written as deleted (D7)
    const files: WalkedFile[] = [];
    const skips = new Map<string, string>();
    const shielded: string[] = [];
    let complete = true;
    const walk = gone
      ? []
      : single
        ? singleFile(fs, location)
        : walkLocation({
            fs,
            rootRealPath: location.realPath,
            limits: {
              maxDepth: limits.walk.maxDepth,
              maxRelativePathChars: limits.walk.maxRelativePathChars,
            },
            ignore: isIgnored,
            excluded: pass.excluded,
          });
    for await (const event of walk) {
      signal.throwIfAborted();
      if (event.kind === "file") {
        if (files.length >= limits.walk.maxFilesPerLocation) {
          report.limitExceeded = true;
          complete = false;
          break;
        }
        files.push({
          path: event.relativePath,
          size: event.size,
          mtimeNs: event.mtimeNs,
          dev: event.dev,
          ino: event.ino,
        });
      } else if (event.kind === "skip") {
        skips.set(event.relativePath, event.reason);
        shielded.push(event.relativePath);
      } else if (event.kind === "ignored") report.ignored += 1;
      else shielded.push(event.relativePath);
    }
    report.walked = files.length + skips.size + report.ignored;

    const entries = p.index.entriesOfLocation(location.id);
    const byPath = new Map<string, LocalIndexEntry>();
    for (const e of entries) {
      if ((e.state === "present" || e.state === "skipped") && e.relativePath !== null) {
        byPath.set(e.relativePath, e);
      }
    }
    const seen = new Set(files.map((f) => f.path));
    const underShield = (path: string) =>
      shielded.some((s) => s === "" || path.startsWith(`${s}/`));
    const version = p.normalizerVersion;
    const keyOf = (path: string) => `${location.id}\n${path}`;
    const hashed = new Map<string, string>();
    const sameContentPaths = (hash: string) => [
      ...files.filter((f) => hashed.get(f.path) === hash).map((f) => f.path),
    ];

    // a held or confirmed deletion whose file is back lets go of the mark (I02B-R8)
    for (const f of files) {
      const held = byPath.get(f.path);
      if (held && held.pendingDelete !== 0) {
        const cleared = p.index.updateEntry(held.externalId, held.seq, {
          ...fieldsOf(held),
          pendingDelete: 0,
        });
        if (cleared.applied) byPath.set(f.path, { ...held, pendingDelete: 0, seq: cleared.seq });
      }
    }

    // files that have an entry
    const fresh: WalkedFile[] = [];
    for (const f of files) {
      const e = byPath.get(f.path);
      if (!e) {
        const forgotten = p.index.findByPath(location.id, f.path);
        if (forgotten?.state === "forgotten") {
          report.skipped += 1;
          report.forgottenPaths.push(f.path);
        } else fresh.push(f);
        continue;
      }
      if (e.contentHash !== null) hashed.set(f.path, e.contentHash);
      const statChanged = e.size !== f.size || e.mtimeNs !== f.mtimeNs;
      const versionChanged = e.normalizerVersion !== version;
      if (e.state === "skipped") {
        const retry =
          retryOf(e.skipReason) === "every-pass" ||
          statChanged ||
          versionChanged ||
          full ||
          (e.skipReason === "resource-exceeded" && e.skipLimits !== limitsKey(limits));
        if (!retry) continue;
      } else if (!statChanged && !versionChanged && !full) continue;
      if (formatOf(f.path) === undefined) {
        if (e.skipReason !== "unsupported-format" || statChanged) {
          writeSkip(p, e, "unsupported-format", { size: f.size, mtimeNs: f.mtimeNs });
        }
        continue;
      }
      if (statChanged && !settled(keyOf(f.path), f, now, limits.settleMs)) {
        report.pending += 1;
        continue;
      }
      observed.delete(keyOf(f.path));
      const read = await readFile(p, pass, location, f.path, { dev: f.dev, ino: f.ino });
      if (!read.ok) {
        const reason = readSkipReason(read.reason);
        const same = e.state === "skipped" && e.skipReason === reason;
        if (!(same && e.size === f.size && e.mtimeNs === f.mtimeNs)) {
          writeSkip(p, e, reason, {
            size: f.size,
            mtimeNs: f.mtimeNs,
            fileNo: fileNoOf(f.dev, f.ino),
          });
        }
        continue;
      }
      const hash = sha256(read.bytes);
      hashed.set(f.path, hash);
      const contentChanged = hash !== e.contentHash;
      if (e.state === "present" && !contentChanged && !versionChanged) {
        if (!statChanged) continue;
        const silentWrite = p.index.updateEntry(e.externalId, e.seq, {
          ...fieldsOf(e),
          size: f.size,
          mtimeNs: f.mtimeNs,
          fileNo: fileNoOf(f.dev, f.ino),
        });
        if (silentWrite.applied) silent.add(silentWrite.seq);
        continue;
      }
      p.index.updateEntry(e.externalId, e.seq, {
        ...fieldsOf(e),
        size: f.size,
        mtimeNs: f.mtimeNs,
        contentHash: hash,
        fileNo: fileNoOf(f.dev, f.ino),
        revision:
          e.revision + (contentChanged || (versionChanged && e.state === "present") ? 1 : 0),
        normalizerVersion: version,
        state: "present",
        skipReason: null,
        skippedAt: null,
        skipLimits: null,
      });
    }

    // entries whose path is not in the location now; a walk skip is not "seen", but a folder that
    // could not be read shields what is under it (D7)
    let missing = [...byPath.values()].filter(
      (e) =>
        !seen.has(e.relativePath as string) &&
        !underShield(e.relativePath as string) &&
        !(e.state === "skipped" && skips.get(e.relativePath as string) === e.skipReason),
    );

    // new files: hash them (a file still being written only to pair a move: its bytes are not kept)
    const inserts: { f: WalkedFile; hash: string | null; reason: LocalSkipReason | null }[] = [];
    const movedHashes = new Map<string, { f: WalkedFile; hash: string }>();
    for (const f of fresh) {
      if (formatOf(f.path) === undefined) {
        inserts.push({ f, hash: null, reason: "unsupported-format" });
        continue;
      }
      const ready = settled(keyOf(f.path), f, now, limits.settleMs);
      if (!ready && missing.length === 0) {
        report.pending += 1;
        continue;
      }
      const read = await readFile(p, pass, location, f.path, { dev: f.dev, ino: f.ino });
      if (!read.ok) {
        if (ready) inserts.push({ f, hash: null, reason: readSkipReason(read.reason) });
        else report.pending += 1;
        continue;
      }
      const hash = sha256(read.bytes);
      hashed.set(f.path, hash);
      movedHashes.set(f.path, { f, hash });
      if (ready) {
        observed.delete(keyOf(f.path));
        inserts.push({ f, hash, reason: null });
      } else report.pending += 1;
    }

    // a path that vanished and a new path with the same content is a move (I02B-R12); a file number
    // alone never pairs, it only picks among equal contents
    const moved = new Set<string>();
    const movedFrom = new Set<string>();
    const byHash = (hash: string) => missing.filter((m) => m.contentHash === hash);
    for (const [path, { f, hash }] of movedHashes) {
      const sameNew = [...movedHashes.values()].filter((o) => o.hash === hash);
      const candidates = byHash(hash).filter((m) => !movedFrom.has(m.externalId));
      let match: LocalIndexEntry | undefined;
      if (candidates.length === 1 && sameNew.length === 1) match = candidates[0];
      else {
        const byNumber = candidates.filter((m) => m.fileNo === fileNoOf(f.dev, f.ino));
        if (byNumber.length === 1) match = byNumber[0];
      }
      if (!match) continue;
      const result = p.index.updateEntry(match.externalId, match.seq, {
        ...fieldsOf(match),
        relativePath: path,
        size: f.size,
        mtimeNs: f.mtimeNs,
        contentHash: hash,
        fileNo: fileNoOf(f.dev, f.ino),
        revision: match.revision + 1,
        normalizerVersion: version,
      });
      if (result.applied) {
        moved.add(path);
        movedFrom.add(match.externalId);
      }
    }
    missing = missing.filter((m) => !movedFrom.has(m.externalId));

    // a deletion is told only when the whole location was walked (I02B-R19)
    if (complete) {
      const gone = (m: LocalIndexEntry) =>
        p.index.updateEntry(m.externalId, m.seq, {
          ...fieldsOf(m),
          size: null,
          mtimeNs: null,
          contentHash: null,
          fileNo: null,
          revision: m.revision + 1,
          state: "deleted",
          skipReason: null,
          skippedAt: null,
          skipLimits: null,
        });
      // too many at once is held for the user (I02B-R8): the denominator is the tracked files not yet
      // confirmed, the numerator what vanished of them, a held one included; a skipped file is no
      // knowledge to lose and goes at once
      const tracked = entries.filter((e) => e.state === "present" && e.pendingDelete !== 2).length;
      const vanished = missing.filter((m) => m.state === "present" && m.pendingDelete !== 2);
      const { ratio, minFiles } = limits.deletionBrake;
      const brake = vanished.length >= minFiles && vanished.length / tracked >= ratio;
      for (const m of missing) {
        if (m.state === "present" && m.pendingDelete !== 2 && brake) {
          if (m.pendingDelete === 0) {
            p.index.updateEntry(m.externalId, m.seq, { ...fieldsOf(m), pendingDelete: 1 });
          }
        } else gone(m);
      }
      if (brake && state === "active") {
        if (p.setLocationState(location.id, "needs-confirmation", null, "active")) {
          state = "needs-confirmation";
        }
      }
    }
    // a location waiting for a confirmation that nothing is held for any more is active again
    if (
      state === "needs-confirmation" &&
      !p.index.entriesOfLocation(location.id).some((e) => e.pendingDelete === 1)
    ) {
      p.setLocationState(location.id, "active", null, "needs-confirmation");
    }

    for (const { f, hash, reason } of inserts) {
      if (moved.has(f.path)) continue;
      const result = p.index.insertEntry(
        {
          externalId: newId(),
          locationId: location.id,
          relativePath: f.path,
          size: f.size,
          mtimeNs: f.mtimeNs,
          contentHash: hash,
          fileNo: fileNoOf(f.dev, f.ino),
          revision: 1,
          normalizerVersion: version,
          pendingDelete: 0,
          state: reason === null ? "present" : "skipped",
          skipReason: reason,
          skippedAt: reason === null ? null : iso(now),
          skipLimits: null,
        },
        hash === null ? [] : sameContentPaths(hash),
      );
      if (!result.applied && result.reason === "forgotten") {
        report.skipped += 1;
        report.forgottenPaths.push(f.path);
      }
    }
    for (const [path, reason] of skips) {
      const kept = byPath.get(path);
      if (kept?.state === "skipped" && kept.skipReason === reason) continue;
      if (kept && !missing.includes(kept)) continue;
      p.index.insertEntry(
        {
          externalId: newId(),
          locationId: location.id,
          relativePath: path,
          size: null,
          mtimeNs: null,
          contentHash: null,
          fileNo: null,
          revision: 1,
          normalizerVersion: version,
          pendingDelete: 0,
          state: "skipped",
          skipReason: reason,
          skippedAt: iso(now),
          skipLimits: null,
        },
        [],
      );
    }
  }

  async function runPass(p: LocalFilesPorts, full: boolean, signal: AbortSignal): Promise<Pass> {
    const fs = p.fs ?? nodeBoundaryFs;
    const pass: Pass = {
      id: newId(),
      unavailable: false,
      blamed: [],
      reports: new Map(),
      excluded: await resolveExcluded(fs, p.excluded()),
    };
    // a broken host gets one canary at the start of a pass; while it is still broken, nothing is read
    if (!(await p.normalizer.recheck())) {
      pass.unavailable = true;
      return pass;
    }
    for (const location of p.locations()) {
      if (location.type === "jsonl-file") continue; // its own instance reads it (I02B-R41)
      if (location.state === "unavailable" && location.stateReason === "root-changed") continue;
      if (!isRead(location) && location.state !== "unavailable") continue;
      signal.throwIfAborted();
      await scanLocation(p, pass, location, full, signal);
    }
    return pass;
  }

  // --- a changed file as a record ----------------------------------------------------------------

  type Built =
    | { kind: "record"; record: SourceRecord }
    | { kind: "skip"; reason: LocalSkipReason; result?: LocalNormalizeResult }
    | { kind: "stale" };

  const titleOf = (path: string, title: string | undefined) =>
    title ?? basename(path, extname(path));

  async function buildRecord(
    p: LocalFilesPorts,
    pass: Pass | undefined,
    e: LocalIndexEntry,
    location: LocalLocationView,
    signal: AbortSignal,
  ): Promise<Built> {
    if (
      e.relativePath === null ||
      e.fileNo === null ||
      e.contentHash === null ||
      e.mtimeNs === null
    ) {
      return { kind: "stale" };
    }
    const read = await readFile(p, pass, location, e.relativePath, idOfFileNo(e.fileNo));
    if (!read.ok) return { kind: "skip", reason: readSkipReason(read.reason) };
    // the bytes to emit must be the bytes the index describes (I02B-R13)
    if (sha256(read.bytes) !== e.contentHash) return { kind: "stale" };
    const format = formatOf(e.relativePath);
    const result = await p.normalizer.normalize(
      { bytes: read.bytes, name: basename(e.relativePath), ...(format ? { format } : {}) },
      { limits: { maxFileBytes: p.limits().maxFileBytes }, signal },
    );
    if (!result.ok) return { kind: "skip", reason: asSkipReason(result.error.code), result };
    const { document } = result;
    const created = document.metadata.created;
    return {
      kind: "record",
      record: {
        namespace: e.locationId,
        externalId: e.externalId,
        revision: e.revision,
        schemaVersion: CONNECTOR_SDK_VERSION,
        title: titleOf(e.relativePath, document.metadata.title),
        body: document.text,
        ...(document.blocks.length > 0 ? { blocks: document.blocks } : {}),
        sourceType: "file",
        ...(document.metadata.author ? { author: document.metadata.author } : {}),
        ...(document.metadata.participants?.length
          ? { participants: document.metadata.participants }
          : {}),
        ...(created && ISO_WITH_OFFSET.test(created) ? { createdAt: created } : {}),
        updatedAt: iso(msOf(e.mtimeNs)),
        metadata: {
          format: document.format,
          relativePath: e.relativePath,
          sizeBytes: read.size,
          ...(document.encoding ? { encoding: document.encoding } : {}),
          limitations: document.limitations.map((l) => l.code),
          normalizerVersion: e.normalizerVersion,
        },
      } as SourceRecord,
    };
  }

  const isRead = (location: LocalLocationView) =>
    location.state === "active" || location.state === "needs-confirmation";

  const locationOf = (p: LocalFilesPorts, e: LocalIndexEntry) =>
    p.locations().find((l) => l.id === e.locationId && l.type !== "jsonl-file");

  /** One entry of the index as a change, or nothing; `halt` stops the read with the entry consumed. */
  async function emit(
    p: LocalFilesPorts,
    pass: Pass,
    e: LocalIndexEntry,
    signal: AbortSignal,
  ): Promise<{ change?: Change; halt?: true }> {
    // a location that is not read announces nothing, deletions included (I02B-R7, R10); what it was
    // not read for is given a new sequence number when it is read again (storage `reopenLocation`)
    const location = locationOf(p, e);
    if (!location || !isRead(location)) return {};
    if (e.state === "deleted") {
      return {
        change: {
          kind: "delete",
          namespace: e.locationId,
          externalId: e.externalId,
          revision: e.revision,
          at: iso(p.now()),
        },
      };
    }
    if (e.state !== "present" || e.mtimeNs === null || silent.has(e.seq)) return {};
    // a held or confirmed deletion changes nothing the product knows: the pass decides it (I02B-R8)
    if (e.pendingDelete !== 0) return {};
    const built = await buildRecord(p, pass, e, location, signal);
    if (built.kind === "stale") {
      // back to "to look at": the next pass reads the file again and announces it with a larger revision
      p.index.updateEntry(e.externalId, e.seq, { ...fieldsOf(e), size: null, mtimeNs: null });
      return {};
    }
    if (built.kind === "skip") {
      const result = built.result;
      const written = writeSkip(p, e, built.reason);
      if (result && !result.ok) {
        if (result.unavailable) {
          pass.unavailable = true;
          if (written.applied) rewriteBlamed(p, pass);
          return { halt: true };
        }
        if (result.unexplainedDeath) pass.blamed.push(e.externalId);
      }
      return {};
    }
    // the user may have deleted the source while it was being read: the index no longer holds this
    // entry as it was read, and the write the pass made is not repeated (I02B-R33)
    const current = p.index.entryOf(e.externalId);
    if (!current || current.seq !== e.seq || current.state !== "present") return {};
    return { change: { kind: "upsert", record: built.record } };
  }

  /** Files this pass blamed on a death nobody explained were the host's fault: they are seen again every pass. */
  function rewriteBlamed(p: LocalFilesPorts, pass: Pass): void {
    for (const id of pass.blamed.splice(0)) {
      const e = p.index.entryOf(id);
      if (e?.state === "skipped" && e.skipReason === "resource-exceeded")
        writeSkip(p, e, "worker-failed");
    }
  }

  // --- the Connector -----------------------------------------------------------------------------

  const finish = (p: LocalFilesPorts, pass: Pass): void => {
    if (!p.report) return;
    const locations = [...pass.reports.values()].map((r) => {
      const skipped = p.index
        .entriesOfLocation(r.locationId)
        .filter((e) => e.state === "skipped").length;
      const forgotten = r.skipped;
      const total = skipped + forgotten;
      return { ...r, skipped: total, sourced: Math.max(0, r.walked - r.ignored - total) };
    });
    p.report({ at: p.now(), normalizerUnavailable: pass.unavailable, locations });
  };

  return {
    manifest: {
      type: "local-files",
      schemaVersion: CONNECTOR_SDK_VERSION,
      capabilities: {
        incremental: true,
        deletes: true,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: true,
      },
    },
    async initialize() {
      ports = bound();
      initialized = true;
      open = undefined;
    },
    async healthCheck() {
      if (!initialized) return { state: "unavailable", reason: "not initialized" };
      if (!ports) return { state: "unavailable", reason: "the local file ports are not bound" };
      return { state: "ok" };
    },
    async getChanges(cursor, { limit, signal }): Promise<ChangeSet> {
      const p = configured();
      signal.throwIfAborted();
      let from = 0;
      let passId: string | undefined;
      if (cursor !== null) {
        const match = CURSOR.exec(cursor);
        from = match ? Number(match[1]) : Number.NaN;
        passId = match?.[2];
        if (!match || from > p.index.lastSeq()) {
          return { changes: [], nextCursor: "", hasMore: true, cursorExpired: true };
        }
      }
      let pass = open;
      if (!pass || pass.id !== passId || cursor === null) {
        pass = await runPass(p, cursor === null, signal);
        open = pass;
        // a rescan reads every entry: none stays hidden because this pass noted its size or time silently (#179 FU6)
        if (cursor === null) silent.clear();
      }
      const changes: Change[] = [];
      const started = p.now();
      const budget = p.limits().pageBudgetMs;
      let consumed = from;
      let handled = 0;
      let halted = false;
      read: for (;;) {
        const batch = p.index.entriesAfter(consumed, limit);
        if (batch.length === 0) break;
        for (const e of batch) {
          signal.throwIfAborted();
          if (pass.unavailable || changes.length >= limit) break read;
          if (handled > 0 && p.now() - started >= budget) break read;
          const out = await emit(p, pass, e, signal);
          consumed = e.seq;
          handled += 1;
          if (out.change) changes.push(out.change);
          if (out.halt) {
            halted = true;
            break read;
          }
        }
      }
      const more = !halted && !pass.unavailable && p.index.entriesAfter(consumed, 1).length > 0;
      for (const seq of silent) if (seq <= consumed) silent.delete(seq);
      if (more) return { changes, nextCursor: `${consumed}.${pass.id}`, hasMore: true };
      finish(p, pass);
      open = undefined;
      return { changes, nextCursor: String(consumed), hasMore: false };
    },
    async getDocument({ namespace, externalId }) {
      const p = configured();
      const e = p.index.entryOf(externalId);
      if (!e || e.locationId !== namespace || e.state !== "present") return null;
      const location = locationOf(p, e);
      if (!location || !isRead(location)) return null;
      const built = await buildRecord(p, undefined, e, location, new AbortController().signal);
      return built.kind === "record" ? built.record : null;
    },
  };
}
