// The messages between the backend and the normalizer host process (I02B-R22, R23). Both ends parse
// what they receive. The host is the untrusted side (a parser bug that reaches code execution lives
// there), so its result is rebuilt field by field against the NormalizeResult shape with size caps, and
// only the rebuilt copy goes on: an extra field never gets through and a result that does not fit is
// `invalid`, which the backend answers `worker-failed` while it drops the host. What this cannot stop is
// the host sending a large message: it is copied into backend memory before any check (spec threat
// model). The job carries bytes, a name and a format only: no path crosses (I02B-C18).
import type { PartialLimits } from "./limits.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
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

export function parseFromHost(raw: unknown): FromHost | undefined {
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
    const result = parseNormalizeResult(raw.result);
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

/** Caps: the text and the blocks follow the normalizer's own input limit; names and paths are short. */
const CAP = {
  text: DEFAULT_LIMITS.maxFileBytes,
  blocks: 4_000_000,
  short: 1_024,
  meta: 65_536,
  list: 10_000,
  detail: 16,
};

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const int = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** `raw` has no key outside `allowed`, and every key of `required`. */
function keys(raw: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const all = new Set([...required, ...optional]);
  return Object.keys(raw).every((k) => all.has(k)) && required.every((k) => k in raw);
}

type Locator = Extract<NormalizeResult, { ok: true }>["document"]["blocks"][number]["locator"];

function parseLocator(raw: unknown): Locator | undefined {
  if (!isRecord(raw) || typeof raw.format !== "string") return undefined;
  const optStr = (k: string) => raw[k] === undefined || str(raw[k], CAP.short);
  const optInt = (k: string) => raw[k] === undefined || int(raw[k]);
  const pick = <K extends string>(names: readonly K[]) =>
    Object.fromEntries(names.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
  switch (raw.format) {
    case "pdf":
      return keys(raw, ["format", "page"]) && int(raw.page)
        ? ({ format: "pdf", page: raw.page } as Locator)
        : undefined;
    case "docx": {
      const t = raw.table;
      const table =
        t === undefined ||
        (isRecord(t) &&
          keys(t, ["index", "row", "cell"]) &&
          int(t.index) &&
          int(t.row) &&
          int(t.cell));
      return keys(raw, ["format", "paragraph"], ["style", "headingLevel", "table"]) &&
        int(raw.paragraph) &&
        optStr("style") &&
        optInt("headingLevel") &&
        table
        ? ({
            format: "docx",
            ...pick(["paragraph", "style", "headingLevel"]),
            ...(t === undefined
              ? {}
              : {
                  table: {
                    index: (t as Record<string, number>).index,
                    row: (t as Record<string, number>).row,
                    cell: (t as Record<string, number>).cell,
                  },
                }),
          } as Locator)
        : undefined;
    }
    case "xlsx":
      return keys(raw, ["format", "sheet"], ["cell", "row", "column"]) &&
        str(raw.sheet, CAP.short) &&
        optStr("cell") &&
        optInt("row") &&
        optInt("column")
        ? ({ format: "xlsx", ...pick(["sheet", "cell", "row", "column"]) } as Locator)
        : undefined;
    case "csv":
      return keys(raw, ["format", "record", "line", "field"]) &&
        int(raw.record) &&
        int(raw.line) &&
        int(raw.field)
        ? ({ format: "csv", ...pick(["record", "line", "field"]) } as Locator)
        : undefined;
    case "html":
      return keys(raw, ["format", "path", "line"]) && str(raw.path, CAP.meta) && int(raw.line)
        ? ({ format: "html", ...pick(["path", "line"]) } as Locator)
        : undefined;
    case "markdown":
      return keys(raw, ["format", "line", "node"], ["depth"]) &&
        int(raw.line) &&
        str(raw.node, CAP.short) &&
        optInt("depth")
        ? ({ format: "markdown", ...pick(["line", "node", "depth"]) } as Locator)
        : undefined;
    case "txt":
    case "json":
      return keys(raw, ["format", "line"]) && int(raw.line)
        ? ({ format: raw.format, line: raw.line } as Locator)
        : undefined;
    default:
      return undefined;
  }
}

function parseDocument(raw: Record<string, unknown>) {
  if (!keys(raw, ["format", "text", "blocks", "metadata", "limitations"], ["encoding"]))
    return undefined;
  if (!(DOCUMENT_FORMATS as readonly unknown[]).includes(raw.format)) return undefined;
  if (!str(raw.text, CAP.text)) return undefined;
  if (!Array.isArray(raw.blocks) || raw.blocks.length > CAP.blocks) return undefined;
  const blocks = [];
  for (const b of raw.blocks as unknown[]) {
    if (!isRecord(b) || !keys(b, ["start", "end", "locator"]) || !int(b.start) || !int(b.end)) {
      return undefined;
    }
    const locator = parseLocator(b.locator);
    if (locator === undefined) return undefined;
    blocks.push({ start: b.start, end: b.end, locator });
  }
  const meta = raw.metadata;
  if (
    !isRecord(meta) ||
    !keys(meta, [], ["title", "author", "created", "modified", "pageCount", "sheetNames"])
  ) {
    return undefined;
  }
  const metadata: Record<string, unknown> = {};
  for (const k of ["title", "author", "created", "modified"]) {
    if (meta[k] === undefined) continue;
    if (!str(meta[k], CAP.meta)) return undefined;
    metadata[k] = meta[k];
  }
  if (meta.pageCount !== undefined) {
    if (!int(meta.pageCount)) return undefined;
    metadata.pageCount = meta.pageCount;
  }
  if (meta.sheetNames !== undefined) {
    const names = meta.sheetNames;
    if (
      !Array.isArray(names) ||
      names.length > CAP.list ||
      !names.every((n) => str(n, CAP.short))
    ) {
      return undefined;
    }
    metadata.sheetNames = [...names];
  }
  let encoding;
  if (raw.encoding !== undefined) {
    const e = raw.encoding;
    const names: readonly unknown[] = ["utf-8", "utf-16le", "utf-16be", "euc-kr"];
    const methods: readonly unknown[] = ["bom", "strict", "fallback"];
    if (
      !isRecord(e) ||
      !keys(e, ["name", "method"]) ||
      !names.includes(e.name) ||
      !methods.includes(e.method)
    ) {
      return undefined;
    }
    encoding = { name: e.name, method: e.method };
  }
  if (!Array.isArray(raw.limitations) || raw.limitations.length > CAP.list) return undefined;
  const limitations = [];
  for (const l of raw.limitations as unknown[]) {
    if (!isRecord(l) || !keys(l, ["code"], ["count", "pages"])) return undefined;
    if (!(LIMITATION_CODES as readonly unknown[]).includes(l.code)) return undefined;
    if (l.count !== undefined && !int(l.count)) return undefined;
    if (
      l.pages !== undefined &&
      (!Array.isArray(l.pages) || l.pages.length > CAP.list || !l.pages.every(int))
    ) {
      return undefined;
    }
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
export function parseNormalizeResult(raw: unknown): NormalizeResult | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.ok === true) {
    if (!keys(raw, ["ok", "document"]) || !isRecord(raw.document)) return undefined;
    const document = parseDocument(raw.document);
    return document === undefined ? undefined : ({ ok: true, document } as NormalizeResult);
  }
  if (raw.ok !== false || !keys(raw, ["ok", "error"]) || !isRecord(raw.error)) return undefined;
  const e = raw.error;
  if (!keys(e, ["code", "message"], ["detail"])) return undefined;
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
