// Errors every adapter boundary (ARCHITECTURE 5) shares, so callers can tell
// "this build has no such implementation" from "this call came too late".

/** The configured implementation cannot serve any call (e.g. the Phase 1 empty VectorIndex). */
export class AdapterUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`adapter unavailable: ${reason}`);
    this.name = "AdapterUnavailableError";
    this.reason = reason;
  }
}

/** A method whose capability flag is false was called anyway. */
export class UnsupportedCapabilityError extends Error {
  readonly capability: string;
  constructor(capability: string) {
    super(`unsupported capability: ${capability}`);
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
  }
}

/**
 * A notification older than what the projection already applied (ADR 0013): a
 * stale version fence for the engine, an older change sequence for a vector ref.
 * The call changes nothing.
 */
export class StaleFenceError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`stale fence: ${detail}`);
    this.name = "StaleFenceError";
    this.detail = detail;
  }
}
