// Every limit is configuration with a local default (I02A-R19).

export interface Limits {
  maxFileBytes: number;
  zip: {
    maxEntries: number;
    maxEntryBytes: number;
    maxTotalBytes: number;
    maxRatio: number;
    ratioMinBytes: number;
  };
  pdf: { maxPages: number };
  encoding: { fallbackMaxForeignRatio: number };
}

export type PartialLimits = {
  [K in keyof Limits]?: Limits[K] extends number ? number : Partial<Limits[K]>;
};

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxFileBytes: 52_428_800,
  zip: Object.freeze({
    maxEntries: 5_000,
    maxEntryBytes: 33_554_432,
    maxTotalBytes: 134_217_728,
    maxRatio: 200,
    ratioMinBytes: 1_048_576,
  }),
  pdf: Object.freeze({ maxPages: 2_000 }),
  encoding: Object.freeze({ fallbackMaxForeignRatio: 0.1 }),
});

/** Limits that may be fractional; every other limit is a whole number of bytes/entries/pages. */
const RATIOS = new Set(["zip.maxRatio", "encoding.fallbackMaxForeignRatio"]);

function check(path: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`limit ${path} must be a positive number, got ${String(value)}`);
  }
  if (!RATIOS.has(path) && !Number.isSafeInteger(value)) {
    throw new TypeError(`limit ${path} must be a positive integer, got ${String(value)}`);
  }
  if (path === "encoding.fallbackMaxForeignRatio" && value > 1) {
    throw new TypeError(`limit ${path} must be at most 1, got ${value}`);
  }
  return value;
}

function merge<T extends object>(base: T, override: unknown, prefix: string): T {
  if (override === undefined) return base;
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    throw new TypeError(`limits ${prefix || "(root)"} must be an object`);
  }
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in base)) throw new TypeError(`unknown limit ${path}`);
    if (value === undefined) continue;
    const current = (base as Record<string, unknown>)[key];
    out[key] =
      typeof current === "object" && current !== null
        ? merge(current, value, path)
        : check(path, value);
  }
  return out as T;
}

/**
 * Overlay a partial override on the defaults. Throws `TypeError` for a bad
 * value or an unknown key: that is a caller bug, not an input failure (I02A-R5).
 */
export function resolveLimits(override?: PartialLimits): Limits {
  return merge(DEFAULT_LIMITS as Limits, override, "");
}
