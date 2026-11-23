// The messages between the backend and the normalizer host process (I02B-R22, R23). Both ends parse
// what they receive. The host is the untrusted side (a parser bug that reaches code execution lives
// there), so its result is rebuilt field by field against the NormalizeResult shape with size caps, and
// only the rebuilt copy goes on: an extra field never gets through and a result that does not fit is
// `invalid`, which the backend answers `worker-failed` while it drops the host. What this cannot stop is
// the host sending a large message: it is copied into backend memory before any check (spec threat
// model). The job carries bytes, a name and a format only: no path crosses (I02B-C18).
import type { PartialLimits } from "./limits.ts";
import type { Limits } from "./limits.ts";
import {
  DOCUMENT_FORMATS,
  LIMITATION_CODES,
  NORMALIZE_ERROR_CODES,
  type DocumentFormat,
  type NormalizeResult,
} from "./types.ts";

/** What the backend tells the host once, right after it is up. */
export interface HostConfig {
  maxHeapMb: number;
  maxExternalMemoryBytes: number;
  externalPollMs: number;
  timeoutMs: number;
}

export interface HostJob {
  id: number;
  bytes: Uint8Array;
  name: string;
  format?: DocumentFormat;
  limits?: PartialLimits;
}

export type ToHost = ({ type: "init" } & HostConfig) | ({ type: "job" } & HostJob);

/** Why a host ended a job by itself; the backend maps each to a result code. */
export type HostLimitCode = "timed-out" | "resource-exceeded" | "worker-failed";

export type ParentKind = "electron-main" | "node-ipc" | "none";

export type FromHost =
  /** A message of a known type that does not fit its shape (a result that is not a NormalizeResult). */
  | { type: "invalid" }
  | { type: "ready"; processType: string | null; parentKind: ParentKind }
  | { type: "result"; id: number; result: NormalizeResult }
  /** `diag`: a test worker's own record of when it crossed the memory limit (I02B-C45). */
  | {
      type: "limit";
      id: number;
      code: HostLimitCode;
      diag?: { crossedAtMs: number; seenAtMs: number };
    };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function parseToHost(raw: unknown): ToHost | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "init") {
    const { maxHeapMb, maxExternalMemoryBytes, externalPollMs, timeoutMs } = raw;
    if (
      positive(maxHeapMb) &&
      positive(maxExternalMemoryBytes) &&
      positive(externalPollMs) &&
      positive(timeoutMs)
    ) {
      return { type: "init", maxHeapMb, maxExternalMemoryBytes, externalPollMs, timeoutMs };
    }
    return undefined;
  }
  if (raw.type === "job") {
    const { id, bytes, name, format, limits } = raw;
    if (!Number.isSafeInteger(id) || !(bytes instanceof Uint8Array) || typeof name !== "string") {
      return undefined;
    }
    if (format !== undefined && !(DOCUMENT_FORMATS as readonly unknown[]).includes(format)) {
      return undefined;
    }
    return {
      type: "job",
      id: id as number,
      bytes,
      name,
      ...(format === undefined ? {} : { format: format as DocumentFormat }),
      ...(isRecord(limits) ? { limits: limits as PartialLimits } : {}),
    };
  }
  return undefined;
}

const LIMIT_CODES: readonly unknown[] = ["timed-out", "resource-exceeded", "worker-failed"];

/** `caps`: what the current job's result may hold (`resultCaps` of its limits). */
export function parseFromHost(raw: unknown, caps: ResultCaps): FromHost | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "ready") {
    const { processType, parentKind } = raw;
    const kinds: readonly unknown[] = ["electron-main", "node-ipc", "none"];
    if ((typeof processType === "string" || processType === null) && kinds.includes(parentKind)) {
      return { type: "ready", processType, parentKind: parentKind as ParentKind };
    }
    return undefined;
  }
  if (raw.type === "result") {
    if (!Number.isSafeInteger(raw.id)) return { type: "invalid" };
    const result = parseNormalizeResult(raw.result, caps);
    return result === undefined
      ? { type: "invalid" }
      : { type: "result", id: raw.id as number, result };
  }
  if (raw.type === "limit") {
    if (!Number.isSafeInteger(raw.id) || !LIMIT_CODES.includes(raw.code)) return undefined;
    const diag = raw.diag;
    const hasDiag =
      isRecord(diag) && typeof diag.crossedAtMs === "number" && typeof diag.seenAtMs === "number";
    return {
      type: "limit",
      id: raw.id as number,
      code: raw.code as HostLimitCode,
      ...(hasDiag
        ? { diag: { crossedAtMs: diag.crossedAtMs as number, seenAtMs: diag.seenAtMs as number } }
        : {}),
    };
  }
  return undefined;
}

// --- the host's result, rebuilt (I02B-R23) ---

/**
 * What the result of one job may hold, from that job's resolved limits: the text of a document is at most
 * what the normalizer can read in (`maxFileBytes`) or inflate from a zip (`zip.maxTotalBytes`), whichever is
 * larger, and a block spans at least one code unit, so there are at most `text.length + 1` blocks.
 */
export interface ResultCaps {
  /** The longest `text`, in UTF-16 code units. */
  maxText: number;
}

export function resultCaps(limits: Limits): ResultCaps {
  return { maxText: Math.max(limits.maxFileBytes, limits.zip.maxTotalBytes) };
}

/** The other caps: names and paths are short, metadata and lists bounded (a producer never comes near them). */
const CAP = { short: 1_024, meta: 65_536, list: 10_000, detail: 16 };

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const int = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * `raw` has only keys of `allowed`, and every one of the first `required` of them. A loop over the object,
 * no allocation: it runs once per block.
 */
function shaped(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  required: number,
): boolean {
  let seen = 0;
  for (const k in raw) {
    const at = allowed.indexOf(k);
    if (at < 0) return false;
    if (at < required) seen++;
  }
  return seen === required;
}

type Locator = Extract<NormalizeResult, { ok: true }>["document"]["blocks"][number]["locator"];

const optStr = (v: unknown) => v === undefined || str(v, CAP.short);
const optInt = (v: unknown) => v === undefined || int(v);

/** A copy of `raw` limited to `names`, those that are present. */
function copyOf(raw: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of names) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

const PDF = ["format", "page"] as const;
const DOCX = ["format", "paragraph", "style", "headingLevel", "table", "comment"] as const;
const XLSX = ["format", "sheet", "cell", "row", "column"] as const;
const CSV = ["format", "record", "line", "field"] as const;
const HTML = ["format", "path", "line"] as const;
const MARKDOWN = ["format", "line", "node", "depth"] as const;
const LINE = ["format", "line"] as const;
const COMMENT = ["thread", "index", "part"] as const;
const TABLE = ["index", "row", "cell"] as const;

function parseLocator(raw: unknown): Locator | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.format) {
    case "pdf":
      return shaped(raw, PDF, 2) && int(raw.page) ? (copyOf(raw, PDF) as Locator) : undefined;
    case "docx": {
      const t = raw.table;
      if (
        !shaped(raw, DOCX, 2) ||
        !int(raw.paragraph) ||
        !optStr(raw.style) ||
        !optInt(raw.headingLevel)
      ) {
        return undefined;
      }
      const c = raw.comment;
      if (
        c !== undefined &&
        (!isRecord(c) ||
          !shaped(c, COMMENT, 3) ||
          !int(c.thread) ||
          !int(c.index) ||
          (c.part !== "head" && c.part !== "text"))
      ) {
        return undefined;
      }
      if (
        t !== undefined &&
        (!isRecord(t) || !shaped(t, TABLE, 3) || !int(t.index) || !int(t.row) || !int(t.cell))
      ) {
        return undefined;
      }
      return {
        ...copyOf(raw, DOCX),
        ...(t === undefined ? {} : { table: copyOf(t as Record<string, unknown>, TABLE) }),
        ...(c === undefined ? {} : { comment: copyOf(c as Record<string, unknown>, COMMENT) }),
      } as Locator;
    }
    case "xlsx":
      return shaped(raw, XLSX, 2) &&
        str(raw.sheet, CAP.short) &&
        optStr(raw.cell) &&
        optInt(raw.row) &&
        optInt(raw.column)
        ? (copyOf(raw, XLSX) as Locator)
        : undefined;
    case "csv":
      return shaped(raw, CSV, 4) && int(raw.record) && int(raw.line) && int(raw.field)
        ? (copyOf(raw, CSV) as Locator)
        : undefined;
    case "html":
      return shaped(raw, HTML, 3) && str(raw.path, CAP.meta) && int(raw.line)
        ? (copyOf(raw, HTML) as Locator)
        : undefined;
    case "markdown":
      return shaped(raw, MARKDOWN, 3) &&
        int(raw.line) &&
        str(raw.node, CAP.short) &&
        optInt(raw.depth)
        ? (copyOf(raw, MARKDOWN) as Locator)
        : undefined;
    case "txt":
    case "json":
      return shaped(raw, LINE, 2) && int(raw.line) ? (copyOf(raw, LINE) as Locator) : undefined;
    default:
      return undefined;
  }
}

/** Elements of `list`, each of which `ok` accepts; a hole in the array is an element that `ok` refuses. */
function everyElement(list: unknown, max: number, ok: (v: unknown) => boolean): list is unknown[] {
  if (!Array.isArray(list) || list.length > max) return false;
  for (let i = 0; i < list.length; i++) if (!ok(list[i])) return false;
  return true;
}

const DOCUMENT = ["format", "text", "blocks", "metadata", "limitations", "encoding"] as const;
const BLOCK = ["start", "end", "locator"] as const;
const META = [
  "title",
  "author",
  "created",
  "modified",
  "pageCount",
  "sheetNames",
  "participants",
] as const;
const LIMITATION = ["code", "count", "pages"] as const;
const ENCODING_NAMES: readonly unknown[] = ["utf-8", "utf-16le", "utf-16be", "euc-kr"];
const ENCODING_METHODS: readonly unknown[] = ["bom", "strict", "fallback"];

function parseDocument(raw: Record<string, unknown>, caps: ResultCaps) {
  if (!shaped(raw, DOCUMENT, 5)) return undefined;
  if (!(DOCUMENT_FORMATS as readonly unknown[]).includes(raw.format)) return undefined;
  if (!str(raw.text, caps.maxText)) return undefined;
  const textLength = raw.text.length;
  // a block spans at least one code unit, so the blocks of a text are fewer than its length + 1
  if (!Array.isArray(raw.blocks) || raw.blocks.length > textLength + 1) return undefined;
  const blocks = new Array<unknown>(raw.blocks.length);
  for (let i = 0; i < raw.blocks.length; i++) {
    const b = raw.blocks[i] as unknown;
    // start <= end <= the text's length: the normalizer counts code points (I02A-R9), which are never
    // more than the code units `length` counts, so the code-unit length is a bound every real block meets
    if (!isRecord(b) || !shaped(b, BLOCK, 3) || !int(b.start) || !int(b.end)) return undefined;
    if (b.start > b.end || b.end > textLength) return undefined;
    const locator = parseLocator(b.locator);
    if (locator === undefined) return undefined;
    blocks[i] = { start: b.start, end: b.end, locator };
  }
  const meta = raw.metadata;
  if (!isRecord(meta) || !shaped(meta, META, 0)) return undefined;
  const metadata: Record<string, unknown> = {};
  for (const k of ["title", "author", "created", "modified"] as const) {
    if (meta[k] === undefined) continue;
    if (!str(meta[k], CAP.meta)) return undefined;
    metadata[k] = meta[k];
  }
  if (meta.pageCount !== undefined) {
    if (!int(meta.pageCount)) return undefined;
    metadata.pageCount = meta.pageCount;
  }
  if (meta.sheetNames !== undefined) {
    if (!everyElement(meta.sheetNames, CAP.list, (n) => str(n, CAP.short))) return undefined;
    metadata.sheetNames = [...meta.sheetNames];
  }
  if (meta.participants !== undefined) {
    if (!everyElement(meta.participants, CAP.list, (n) => str(n, CAP.short))) return undefined;
    metadata.participants = [...meta.participants];
  }
  let encoding;
  if (raw.encoding !== undefined) {
    const e = raw.encoding;
    if (
      !isRecord(e) ||
      !shaped(e, ["name", "method"], 2) ||
      !ENCODING_NAMES.includes(e.name) ||
      !ENCODING_METHODS.includes(e.method)
    ) {
      return undefined;
    }
    encoding = { name: e.name, method: e.method };
  }
  const limitations = [];
  if (!Array.isArray(raw.limitations) || raw.limitations.length > CAP.list) return undefined;
  for (let i = 0; i < raw.limitations.length; i++) {
    const l = raw.limitations[i] as unknown;
    if (!isRecord(l) || !shaped(l, LIMITATION, 1)) return undefined;
    if (!(LIMITATION_CODES as readonly unknown[]).includes(l.code)) return undefined;
    if (l.count !== undefined && !int(l.count)) return undefined;
    if (l.pages !== undefined && !everyElement(l.pages, CAP.list, int)) return undefined;
    limitations.push({
      code: l.code,
      ...(l.count === undefined ? {} : { count: l.count }),
      ...(l.pages === undefined ? {} : { pages: [...(l.pages as number[])] }),
    });
  }
  return {
    format: raw.format,
    text: raw.text,
    blocks,
    metadata,
    ...(encoding === undefined ? {} : { encoding }),
    limitations,
  };
}

/** The host's result as a NormalizeResult built here, or undefined when it does not fit (I02B-R23). */
export function parseNormalizeResult(raw: unknown, caps: ResultCaps): NormalizeResult | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.ok === true) {
    if (!shaped(raw, ["ok", "document"], 2) || !isRecord(raw.document)) return undefined;
    const document = parseDocument(raw.document, caps);
    return document === undefined ? undefined : ({ ok: true, document } as NormalizeResult);
  }
  if (raw.ok !== false || !shaped(raw, ["ok", "error"], 2) || !isRecord(raw.error))
    return undefined;
  const e = raw.error;
  if (!shaped(e, ["code", "message", "detail"], 2)) return undefined;
  if (
    !(NORMALIZE_ERROR_CODES as readonly unknown[]).includes(e.code) ||
    !str(e.message, CAP.short)
  ) {
    return undefined;
  }
  let detail: Record<string, string | number> | undefined;
  if (e.detail !== undefined) {
    if (!isRecord(e.detail) || Object.keys(e.detail).length > CAP.detail) return undefined;
    detail = {};
    for (const [k, v] of Object.entries(e.detail)) {
      if (!(typeof v === "number" && Number.isFinite(v)) && !str(v, CAP.short)) return undefined;
      if (k.length > CAP.short) return undefined;
      detail[k] = v as string | number;
    }
  }
  return {
    ok: false,
    error: {
      code: e.code as never,
      message: e.message,
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

/** The worker's side: it says it is loaded (`up`), then one job in, one result out. */
export interface WorkerUp {
  type: "up";
}
export interface WorkerJob extends HostJob {
  type: "job";
}
export interface WorkerReply {
  type: "result";
  id: number;
  result: NormalizeResult;
}
