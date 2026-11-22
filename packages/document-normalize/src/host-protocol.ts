// The messages between the backend and the normalizer host process (I02B-R22, R23). Both ends parse
// what they receive: a message that does not fit is dropped, never half-used. The job carries bytes,
// a name and a format only: no path crosses (I02B-C18).
import type { PartialLimits } from "./limits.ts";
import { DOCUMENT_FORMATS, type DocumentFormat, type NormalizeResult } from "./types.ts";

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
    if (!Number.isSafeInteger(raw.id) || !isRecord(raw.result)) return undefined;
    return {
      type: "result",
      id: raw.id as number,
      result: raw.result as unknown as NormalizeResult,
    };
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
