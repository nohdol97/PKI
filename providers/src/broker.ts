// Provider Broker core (V01-R8, ARCHITECTURE 5.1): every Provider call goes
// through here. The caller names IDs only. The Broker decides the call kind from
// its records, reads the text from the canonical store, grades it, asks the
// egress decision (T08) and the execution condition (T09), and applies the
// concurrency cap, call budget, timeout, retry with backoff and history.
// An outer AbortSignal ends a request (also between retries) as "cancelled".
// An attempt is written to history as "started" before the Provider is asked and
// fixed when it ends; at start the budget is read back from that history, so a
// restart or a call killed midway does not reset it (I03-R14).
// A request with anything but IDs, or naming a missing or used record, is
// rejected before any of that. The egress decision and the execution condition
// are asked again before every attempt, after waiting for a slot, so a consent
// revoked while a call waits or backs off stops it.
import {
  BrokerRequestSchema,
  ProviderError,
  ProviderRateLimitError,
  type BrokerRequest,
  type DataClassification,
  type EgressDecision,
  type LLMProvider,
  type LLMRequest,
  type StructuredRequest,
  type TaskKind,
  type UntrustedDocument,
} from "@pki/contracts";
import {
  defaultScopePolicy,
  parseScope,
  readJob,
  readSourceVersion,
  UnregisteredDerivativeError,
  type ScopePolicy,
  type SqlDriver,
  type StoredSourceVersion,
} from "@pki/storage";
import { randomUUID } from "node:crypto";
import material from "./connection-test-material.json" with { type: "json" };
import {
  publicScopeGrading,
  SCOPE_CLASSES,
  type ScopeClass,
  type ScopeGrading,
} from "./scope-grading.ts";
import { lookupSynthetic } from "./synthetic-manifest.ts";
import { TASKS, type TaskDefinition } from "./tasks.ts";
import type { UserActionRedeemer } from "./user-actions.ts";

/**
 * Connector kinds of the public repository whose records may grade synthetic.
 * Any other kind (site-*, "unknown" from schema v1, a fork's own) never does. The set stays
 * private; a frozen copy is exported so the backend's test can hold every one of them to its public
 * kinds (I05-R7, I05-C14 ①).
 */
const SYNTHETIC_CONNECTOR_KINDS: ReadonlySet<string> = new Set(["test-fixtures"]);

/** A frozen copy of the set, for a test to hold against the public kinds: a reader cannot add a trusted kind through it. */
export const SYNTHETIC_CONNECTOR_KIND_LIST: readonly string[] = Object.freeze([
  ...SYNTHETIC_CONNECTOR_KINDS,
]);
const CONNECTION_TEST_DOCUMENT: UntrustedDocument = Object.freeze({
  id: "connection-test-material",
  title: material.title,
  body: material.body,
});

export type { ScopeClass, ScopeGrading } from "./scope-grading.ts";

/** The judge of scopes and the mapping scope -> class (I01-R15); the public repository's own by default. */
export interface ScopeGrader {
  policy: ScopePolicy;
  grading: ScopeGrading;
}

export interface CandidateItem {
  readonly name: string;
  readonly evidenceSourceVersionIds: readonly string[];
  /** The name itself has no source of its own (a user-authored item): it is graded as unsourced even when `evidenceSourceVersionIds` names a group's sources. */
  readonly nameUnsourced?: boolean;
}

/** Existing knowledge items (V02 builds the store). V01 has none: every ID is missing. */
export interface CandidateItems {
  lookup(id: string): CandidateItem | undefined;
}

export interface EgressInput {
  providerId: LLMProvider["id"];
  taskKind: TaskKind;
  classification: DataClassification;
}

/** Consent and egress rules, decided before every call (ADR 0014): T08. */
export interface EgressPolicy {
  decide(input: EgressInput): EgressDecision | { allowed: false; reason: string };
}

export interface ExecutionInput {
  providerId: LLMProvider["id"];
  transport: LLMProvider["transport"];
  taskKind: TaskKind;
  trigger: "user" | "background";
  classification: DataClassification;
  /** Some input is a malicious variant in the synthetic manifest. */
  malicious: boolean;
  /**
   * A CLI's exact version from its fixed-argument version query, asked before
   * every attempt; undefined when it cannot be read (or for an HTTP Provider).
   */
  version: string | undefined;
  /** The user confirmed the unverified-isolation warning for this one call (its user action record). */
  unverifiedAcknowledged: boolean;
}

/** How a CLI call runs: the argument profile it must use and whether its isolation was verified. */
export type CliExecution = Omit<LLMRequest["execution"] & {}, "executable">;

export type ExecutionDecision = { run: true; cli?: CliExecution } | { run: false; reason: string };

/** CLI execution conditions (ARCHITECTURE 3.1): execution-gate.ts. */
export interface ExecutionGate {
  decide(input: ExecutionInput): ExecutionDecision;
}

export type CallOutcome =
  | "ok"
  | "timeout"
  | "rate-limited"
  | "provider-error"
  | "invalid-output"
  | "blocked"
  | "budget-exhausted"
  /** Written before the Provider is asked; fixed to the result when the attempt ends. */
  | "started"
  /** A "started" attempt whose process died: it still counts against the budget. */
  | "interrupted"
  /** Ended by the caller's AbortSignal after it was sent. */
  | "cancelled";

/** Outcomes of an attempt that reached the Provider and ended in this process. */
type AttemptOutcome = Exclude<
  CallOutcome,
  "blocked" | "budget-exhausted" | "started" | "interrupted"
>;

/** One history entry: no text, no Provider message (V01-R13). "blocked" and "budget-exhausted" never ran. */
export interface CallRecord {
  requestId: string;
  attempt: number;
  providerId: LLMProvider["id"];
  taskKind: TaskKind;
  classification: DataClassification;
  outcome: CallOutcome;
  destination?: string;
  policyVersion?: string;
  durationMs?: number;
  /** Why a blocked or budget-exhausted attempt did not run: a code, never Provider text. */
  reason?: string;
}

/** Writes history (provider_calls): T08. */
export interface CallRecorder {
  /** Writes an attempt that did not run, or one that is already over. */
  record(entry: CallRecord): void;
  /**
   * Writes an attempt about to reach the Provider as "started"; the returned
   * function sets its result. The row's time is what the budget counts.
   */
  begin(
    entry: Omit<CallRecord, "outcome" | "durationMs" | "reason">,
  ): (result: { outcome: AttemptOutcome; durationMs: number }) => void;
  /** When the attempts after `afterMs` (exclusive) were made, "started" and "interrupted" included. */
  attemptTimes(afterMs: number): number[];
  /** Turns the "started" attempts a dead process left into "interrupted"; returns how many. */
  interruptStarted(): number;
}

/** The window budget as it stands (also for the Activity screen, I03-R22). */
export interface BudgetUsage {
  used: number;
  maxCalls: number;
  windowMs: number;
  /** When the oldest counted attempt leaves the window and a slot frees; null with no attempt. */
  resetsAt: number | null;
}

export interface BrokerLimits {
  maxConcurrent: number;
  /** Attempts per request, the first included. */
  maxAttempts: number;
  backoffBaseMs: number;
  /** Ceiling for any wait, a Provider's retry-after included. */
  backoffMaxMs: number;
  /** Ceiling for a request's own timeout. */
  maxTimeoutMs: number;
  /**
   * Ceiling for a CLI's version query before each attempt; the request's timeout
   * bounds it too. One that does not answer in time is "version unknown" (not
   * listed), so a hung query cannot hold a concurrency slot.
   */
  versionQueryTimeoutMs: number;
  /** Provider attempts allowed in any window of windowMs. */
  callBudget: { maxCalls: number; windowMs: number };
}

export const DEFAULT_LIMITS: Readonly<BrokerLimits> = Object.freeze({
  maxConcurrent: 2,
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  maxTimeoutMs: 120_000,
  versionQueryTimeoutMs: 10_000,
  callBudget: Object.freeze({ maxCalls: 60, windowMs: 3_600_000 }),
});

export interface BrokerDeps {
  db: SqlDriver;
  /** The selected Provider; undefined blocks the call (no silent fallback). */
  provider: () => LLMProvider | undefined;
  userActions: UserActionRedeemer;
  candidates: CandidateItems;
  egress: EgressPolicy;
  execution: ExecutionGate;
  recorder: CallRecorder;
  /** How a source's scope becomes a class (I01-R15); the public default grades every scope general. */
  scope?: ScopeGrader;
  limits?: Partial<BrokerLimits>;
  /** `sleep` may end early when `signal` is cut; the Broker does not depend on that. */
  clock?: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
}

export type RejectReason =
  | "invalid-request"
  | "unknown-task-version"
  | "no-documents"
  | "unexpected-ids"
  | "unknown-origin"
  | "origin-used"
  | "origin-not-leased"
  | "origin-mismatch"
  | "missing-source"
  | "missing-candidate"
  /** An input names a derivative of a kind the registry does not know: its sources cannot be graded (I04-R16). */
  | "unregistered-derivative"
  /** The scope policy or the scope -> class mapping could not judge a source's scope: refused, never guessed (I01-R15). */
  | "scope-unjudged";

export type BrokerResult =
  | {
      status: "ok";
      requestId: string;
      output: unknown;
      attempts: number;
      /** For a CLI call: the profile it ran with and whether its isolation was verified. */
      cli?: CliExecution;
    }
  | { status: "rejected"; reason: RejectReason }
  | { status: "blocked"; requestId: string; reason: string }
  /** The caller's AbortSignal ended the request (not the Broker's own time limit). */
  | { status: "cancelled" }
  | {
      status: "failed";
      requestId: string;
      error: "timeout" | "rate-limited" | "provider-error" | "invalid-output";
      attempts: number;
    };

interface Prepared {
  request: BrokerRequest;
  task: TaskDefinition;
  trigger: "user" | "background";
  unverifiedAcknowledged: boolean;
  documents: UntrustedDocument[];
  candidates: { id: string; name: string }[];
  classification: DataClassification;
  malicious: boolean;
}

type Graded = { classification: DataClassification; malicious: boolean };

/** Synthetic only when the manifest lists exactly this title and body from a trusted origin. */
function listedSynthetic(title: string, body: string, trustedOrigin: boolean) {
  return trustedOrigin ? lookupSynthetic(title, body) : undefined;
}

/** The grade of a text that is not listed: general in the public repository; the fork's mapping decides (S08). */
function grade(title: string, body: string, trustedOrigin: boolean): Graded {
  const listed = listedSynthetic(title, body, trustedOrigin);
  return listed
    ? { classification: "synthetic", malicious: listed.malicious }
    : { classification: "general", malicious: false };
}

/** A policy or mapping that could not give a usable answer: the request is refused (I01-R15). */
class ScopeUnjudgedError extends Error {
  override name = "ScopeUnjudgedError";
}

const COMPARISONS: ReadonlySet<unknown> = new Set(["stricter", "equal", "looser", "incomparable"]);

/** The answer if it is a class a scope may give; synthetic (the manifest's alone) or any other is no answer. */
function asScopeClass(answer: unknown): ScopeClass {
  if (typeof answer === "string" && (SCOPE_CLASSES as readonly string[]).includes(answer)) {
    return answer as ScopeClass;
  }
  throw new ScopeUnjudgedError();
}

/**
 * The class the scope of a stored source gives (I01-R15). A scope the source system
 * reported is mapped as it stands. A scope an import claimed is compared with the scope the
 * deployment configured for the instance. Unless the comparison shows the claim as strict as
 * the configured scope or stricter, or looser, the strictest class is the result: an unknown
 * claim, an unknown configured scope and incomparable scopes. When it is shown, the result is
 * the stricter of the two scopes' classes, whichever way they compare, so the claim never gives
 * a looser class than the configured scope even for a mapping that is not monotone. A policy or
 * mapping that throws or answers outside its closed set judges nothing (`ScopeUnjudgedError`).
 */
function scopeClass(stored: StoredSourceVersion, scope: ScopeGrader): ScopeClass {
  try {
    return judgeScope(stored, scope);
  } catch {
    // a policy or mapping that throws judges nothing either; its message stays out
    throw new ScopeUnjudgedError();
  }
}

/** The strictest class there is (`strictest([])`); a mapping that throws or answers outside the set judges nothing. */
function strictestOfNone(grading: ScopeGrading): ScopeClass {
  try {
    return asScopeClass(grading.strictest([]));
  } catch {
    throw new ScopeUnjudgedError();
  }
}

function judgeScope(stored: StoredSourceVersion, { policy, grading }: ScopeGrader): ScopeClass {
  const own = parseScope(stored.accessScope);
  if (!stored.scopeClaimed) return asScopeClass(grading.grade(own));
  const configured = stored.configuredScope;
  const strictestClass = () => strictestOfNone(grading);
  // nothing configured (the public default) or nothing claimed: no comparison can show the claim safe
  if (own === null || configured === null) return strictestClass();
  const compared: unknown = policy.compare(own, configured);
  if (!COMPARISONS.has(compared)) throw new ScopeUnjudgedError();
  if (compared === "incomparable") return strictestClass();
  const classes = [asScopeClass(grading.grade(own)), asScopeClass(grading.grade(configured))];
  const stricter = asScopeClass(grading.strictest(classes));
  // the stricter of two classes is one of them: the claim never gives a class beyond the two,
  // whatever the fork's `strictest` does
  if (!classes.includes(stricter)) throw new ScopeUnjudgedError();
  return stricter;
}

const reject = (reason: RejectReason) => ({ status: "rejected", reason }) as const;

/** The strictest class: synthetic only if there is input and all of it is synthetic. */
export function strictest(graded: readonly Graded[]): DataClassification {
  return graded.length > 0 && graded.every((g) => g.classification === "synthetic")
    ? "synthetic"
    : "general";
}

function readGraded(db: SqlDriver, id: string, scope: ScopeGrader) {
  const stored = readSourceVersion(db, Number(id));
  if (!stored) return undefined;
  const trusted =
    stored.connectorKind !== null && SYNTHETIC_CONNECTOR_KINDS.has(stored.connectorKind);
  const listed = listedSynthetic(stored.title, stored.body, trusted);
  const graded: Graded = listed
    ? { classification: "synthetic", malicious: listed.malicious }
    : { classification: scopeClass(stored, scope), malicious: false };
  return { document: { id, title: stored.title, body: stored.body }, ...graded };
}

const PUBLIC_SCOPE: ScopeGrader = Object.freeze({
  policy: defaultScopePolicy,
  grading: publicScopeGrading,
});

function prepare(deps: BrokerDeps, raw: unknown): Prepared | { reason: RejectReason } {
  try {
    return prepareInputs(deps, raw);
  } catch (error) {
    if (error instanceof ScopeUnjudgedError) return { reason: "scope-unjudged" };
    throw error;
  }
}

function prepareInputs(deps: BrokerDeps, raw: unknown): Prepared | { reason: RejectReason } {
  const scope = deps.scope ?? PUBLIC_SCOPE;
  const parsed = BrokerRequestSchema.safeParse(raw);
  if (!parsed.success) return { reason: "invalid-request" };
  const request = parsed.data;
  const versions: Record<number, Prepared["task"] | undefined> = TASKS[request.taskKind];
  const task = Object.hasOwn(versions, request.schemaVersion)
    ? versions[request.schemaVersion]
    : undefined;
  if (!task) return { reason: "unknown-task-version" };
  const ids = request.sourceVersionIds;
  if (new Set(ids).size !== ids.length) return { reason: "invalid-request" };
  if (request.taskKind !== "connection-test" && ids.length === 0) return { reason: "no-documents" };
  if (request.taskKind === "connection-test" && ids.length + request.candidateItemIds.length > 0) {
    return { reason: "unexpected-ids" };
  }

  let trigger: Prepared["trigger"];
  let unverifiedAcknowledged = false;
  if ("jobId" in request.origin) {
    const job = readJob(deps.db, Number(request.origin.jobId));
    if (!job) return { reason: "unknown-origin" };
    if (job.kind !== request.taskKind) return { reason: "origin-mismatch" };
    // only the holder of the running job's current lease calls for it (V02-T03,
    // I03-R2): a holder whose lease was reclaimed, or whose job was closed (a
    // source closing raises the token, I03-R3), names an older token
    if (job.status !== "running" || String(job.leaseToken) !== request.origin.leaseToken) {
      return { reason: "origin-not-leased" };
    }
    trigger = "background";
  } else {
    const redeemed = deps.userActions.redeem(request.origin.userActionId);
    if (redeemed === "unknown") return { reason: "unknown-origin" };
    if (redeemed === "used") return { reason: "origin-used" };
    trigger = "user";
    unverifiedAcknowledged = redeemed.unverifiedAcknowledged;
  }

  const graded: Graded[] = [];
  const documents: UntrustedDocument[] = [];
  if (request.taskKind === "connection-test") {
    const { title, body } = CONNECTION_TEST_DOCUMENT;
    documents.push(CONNECTION_TEST_DOCUMENT);
    graded.push(grade(title, body, true));
  }
  for (const id of ids) {
    const read = readGraded(deps.db, id, scope);
    if (!read) return { reason: "missing-source" };
    documents.push(read.document);
    graded.push(read);
  }
  const candidates: Prepared["candidates"] = [];
  for (const id of request.candidateItemIds) {
    let item: CandidateItem | undefined;
    try {
      item = deps.candidates.lookup(id);
    } catch (error) {
      // a kind the registry does not know has no lineage to grade by: refuse, never guess (I04-R16)
      if (error instanceof UnregisteredDerivativeError)
        return { reason: "unregistered-derivative" };
      throw error;
    }
    if (!item) return { reason: "missing-candidate" };
    candidates.push({ id, name: item.name });
    // a name with no source of its own has no known origin: the mapping's strictest class (R6-2, fail
    // closed), also when a group's sources are attached to a name the user typed
    if (item.nameUnsourced === true || item.evidenceSourceVersionIds.length === 0) {
      graded.push({ classification: strictestOfNone(scope.grading), malicious: false });
    }
    for (const evidenceId of item.evidenceSourceVersionIds) {
      const read = readGraded(deps.db, evidenceId, scope);
      if (!read) return { reason: "missing-source" };
      graded.push(read);
    }
  }
  return {
    request,
    task,
    trigger,
    unverifiedAcknowledged,
    documents,
    candidates,
    classification: strictest(graded),
    malicious: graded.some((g) => g.malicious),
  };
}

interface CliFound {
  version: string | undefined;
  /** The absolute path the query ran; the attempt runs that executable (V01-T10). */
  path: string | undefined;
}

const NOT_FOUND: CliFound = { version: undefined, path: undefined };

/**
 * The version a CLI reports through its fixed-argument query, and the executable
 * that answered; neither if it cannot tell within `timeoutMs`. A late answer is
 * ignored (the Provider ends its own query process, V01-T10).
 */
async function cliVersion(provider: LLMProvider, timeoutMs: number): Promise<CliFound> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<CliFound>((resolve) => {
    timer = setTimeout(() => resolve(NOT_FOUND), timeoutMs);
  });
  try {
    // started inside a promise chain, so a synchronous throw is a rejection like any other
    const query = Promise.resolve()
      .then(() => provider.detect())
      .then((info): CliFound => {
        if (!info.installed) return NOT_FOUND;
        return {
          version: typeof info.version === "string" ? info.version : undefined,
          path: typeof info.path === "string" ? info.path : undefined,
        };
      });
    query.catch(() => undefined); // may settle after the timeout; nobody awaits it then
    return await Promise.race([query, late]);
  } catch {
    return NOT_FOUND; // not listed, then; the Provider's message stays out
  } finally {
    clearTimeout(timer);
  }
}

function semaphore(size: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < size) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

type Attempt =
  | { outcome: "ok"; output: unknown }
  | {
      outcome: Exclude<AttemptOutcome, "ok">;
      retryable: boolean;
      retryAfterMs?: number;
    };

/** Resolves when `signal` is cut (at once if it already is); `off` removes the listener. */
function whenAborted(signal: AbortSignal | undefined) {
  if (!signal) return { cut: new Promise<void>(() => {}), off: () => {} };
  let onAbort!: () => void;
  const cut = new Promise<void>((resolve) => (onAbort = resolve));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return { cut, off: () => signal.removeEventListener("abort", onAbort) };
}

async function attemptOnce(
  provider: LLMProvider,
  request: StructuredRequest,
  task: Prepared["task"],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Attempt> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outer = whenAborted(signal);
  const cancelled = outer.cut.then(() => "cancelled" as const);
  // started inside a promise chain, so a synchronous throw is a rejection like any other
  const running = Promise.resolve().then(() =>
    provider.generateStructured(request, controller.signal),
  );
  running.catch(() => undefined); // settles after a timeout too; nobody awaits it then
  try {
    const winner = await Promise.race([running, timedOut, cancelled]);
    if (winner === "timeout" || winner === "cancelled") {
      controller.abort();
      // asked, never awaited: a cancel that hangs or throws cannot hold the slot
      try {
        provider.cancel(request.requestId).catch(() => undefined);
      } catch {
        // the call is already aborted and reported as a timeout
      }
      return winner === "timeout"
        ? { outcome: "timeout", retryable: true }
        : { outcome: "cancelled", retryable: false };
    }
    const output = task.output.safeParse(winner.output);
    return output.success
      ? { outcome: "ok", output: output.data }
      : { outcome: "invalid-output", retryable: false };
  } catch (error) {
    if (error instanceof ProviderRateLimitError) {
      return {
        outcome: "rate-limited",
        retryable: true,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      };
    }
    return {
      outcome: "provider-error",
      retryable: error instanceof ProviderError && error.retryable,
    };
  } finally {
    clearTimeout(timer);
    outer.off();
  }
}

/** Waits for `wait`, or until `signal` is cut, whichever is first. */
async function unlessAborted(wait: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  const outer = whenAborted(signal);
  try {
    await Promise.race([wait, outer.cut]);
  } finally {
    outer.off();
  }
}

/** How long precheck remembers a CLI's version (I03-R16 ②): one query per Provider per hour. */
export const PRECHECK_VERSION_MEMORY_MS = 3_600_000;

/** The answer of precheck: the real call's decisions, without the call. */
export type PrecheckResult = { allowed: true } | { allowed: false; reason: string };

export function createBroker(deps: BrokerDeps) {
  const limits: BrokerLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const clock = deps.clock ?? {
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const slot = semaphore(limits.maxConcurrent);
  // The window budget is read back from history (I03-R14): attempts a dead process
  // left "started" are "interrupted" first, and still count.
  deps.recorder.interruptStarted();
  const attemptTimes: number[] = deps.recorder.attemptTimes(
    clock.now() - limits.callBudget.windowMs,
  );
  const CANCELLED = { status: "cancelled" } as const;

  /** Drops attempts out of the window; one dated after now (the clock went back) counts as now. */
  function settleBudget(now: number): void {
    for (let i = 0; i < attemptTimes.length; i++) {
      if ((attemptTimes[i] ?? 0) > now) attemptTimes[i] = now;
    }
    while (attemptTimes.length > 0 && (attemptTimes[0] ?? 0) <= now - limits.callBudget.windowMs) {
      attemptTimes.shift();
    }
  }

  function takeBudget(): boolean {
    const now = clock.now();
    settleBudget(now);
    if (attemptTimes.length >= limits.callBudget.maxCalls) return false;
    attemptTimes.push(now);
    return true;
  }

  function budgetUsage(): BudgetUsage {
    settleBudget(clock.now());
    const { maxCalls, windowMs } = limits.callBudget;
    return {
      used: attemptTimes.length,
      maxCalls,
      windowMs,
      resetsAt: attemptTimes.length > 0 ? (attemptTimes[0] ?? 0) + windowMs : null,
    };
  }

  /** `signal` ends the request wherever it is: before an attempt, in one, or between two. */
  async function call(raw: unknown, signal?: AbortSignal): Promise<BrokerResult> {
    if (signal?.aborted) return CANCELLED;
    const prepared = prepare(deps, raw);
    if ("reason" in prepared) return reject(prepared.reason);
    const { request, task, trigger, classification, malicious } = prepared;
    const requestId = randomUUID();
    const provider = deps.provider();
    if (!provider) return { status: "blocked", requestId, reason: "no-provider" };

    const base = { requestId, providerId: provider.id, taskKind: request.taskKind, classification };
    // every Phase 1 task asks for structured output; a Provider without it is never called
    let structured: unknown;
    try {
      structured = provider.getCapabilities().structuredOutput;
    } catch {
      structured = "unreadable"; // the Provider's message stays out of results and history
    }
    if (structured !== true) {
      const reason =
        structured === "unreadable" ? "capabilities-unavailable" : "structured-output-unsupported";
      deps.recorder.record({ ...base, attempt: 1, outcome: "blocked", reason });
      return { status: "blocked", requestId, reason };
    }
    const timeoutMs = Math.min(request.budget.timeoutMs, limits.maxTimeoutMs);

    /** Consent and egress rules (T08), then execution conditions (T09), as they stand now. */
    const decide = async (): Promise<
      | { egress: EgressDecision; cli: CliExecution | undefined; executable: string | undefined }
      | { reason: string }
    > => {
      const egress = deps.egress.decide({
        providerId: provider.id,
        taskKind: request.taskKind,
        classification,
      });
      if (!egress.allowed) return { reason: egress.reason };
      // asked again every attempt: a CLI updated meanwhile is no longer the listed one
      const found =
        provider.transport === "cli"
          ? await cliVersion(provider, Math.min(timeoutMs, limits.versionQueryTimeoutMs))
          : NOT_FOUND;
      const execution = deps.execution.decide({
        providerId: provider.id,
        transport: provider.transport,
        taskKind: request.taskKind,
        trigger,
        classification,
        malicious,
        version: found.version,
        unverifiedAcknowledged: prepared.unverifiedAcknowledged,
      });
      return execution.run
        ? { egress, cli: execution.cli, executable: found.path }
        : { reason: execution.reason };
    };

    return slot(async (): Promise<BrokerResult> => {
      for (let attempt = 1; ; attempt++) {
        if (signal?.aborted) return CANCELLED;
        const decided = await decide();
        if (signal?.aborted) return CANCELLED; // nothing was sent: no row, no budget
        if ("reason" in decided) {
          deps.recorder.record({ ...base, attempt, outcome: "blocked", reason: decided.reason });
          return { status: "blocked", requestId, reason: decided.reason };
        }
        const { egress, cli, executable } = decided;
        const where = { destination: egress.destination, policyVersion: egress.policyVersion };
        if (!takeBudget()) {
          deps.recorder.record({
            ...base,
            ...where,
            attempt,
            outcome: "budget-exhausted",
            reason: "budget-exhausted",
          });
          return { status: "blocked", requestId, reason: "budget-exhausted" };
        }
        const outgoing: StructuredRequest = {
          // one ID per attempt, so a late cancel of attempt N cannot stop attempt N + 1;
          // history keeps the Broker's request ID and the attempt number
          requestId: `${requestId}:${attempt}`,
          taskKind: request.taskKind,
          trigger,
          dataClassification: classification,
          egress,
          schemaVersion: request.schemaVersion,
          budget: request.budget,
          retryable: request.retryable,
          input: {
            instructions: task.instructions,
            untrustedDocuments: prepared.documents,
            candidates: prepared.candidates,
          },
          outputSchema: task.outputJsonSchema,
          // the executable whose version was just judged runs, not one found anew
          ...(cli ? { execution: executable === undefined ? cli : { ...cli, executable } } : {}),
        };
        // history first: a call killed midway still leaves its attempt (I03-R14)
        const finish = deps.recorder.begin({ ...base, ...where, attempt });
        const started = clock.now();
        const result = await attemptOnce(provider, outgoing, task, timeoutMs, signal);
        finish({ outcome: result.outcome, durationMs: clock.now() - started });
        if (result.outcome === "cancelled") return CANCELLED;
        if (result.outcome === "ok") {
          return {
            status: "ok",
            requestId,
            output: result.output,
            attempts: attempt,
            ...(cli ? { cli } : {}),
          };
        }
        if (!request.retryable || !result.retryable || attempt >= limits.maxAttempts) {
          return { status: "failed", requestId, error: result.outcome, attempts: attempt };
        }
        const backoff = limits.backoffBaseMs * 2 ** (attempt - 1);
        await unlessAborted(
          clock.sleep(Math.min(result.retryAfterMs ?? backoff, limits.backoffMaxMs), signal),
          signal,
        );
      }
    });
  }

  const versions = new Map<string, { at: number; found: CliFound }>();

  /**
   * Would a background call of `taskKind` to the selected Provider run now? The
   * decisions are the real call's, in its order: a Provider selected (and the one
   * named, if one is), structured output, the egress decision, the execution
   * condition. The Provider's model is never called and history is not written. It
   * is asked as the strictest call: background, "general" data, and possibly a
   * malicious variant (no document is read), so a pass can be too generous
   * but never too strict: a job put back that is blocked again loses nothing
   * (I03-R16 ②). A CLI's version is asked at most once an hour per Provider.
   */
  async function precheck(input: {
    taskKind: TaskKind;
    providerId?: LLMProvider["id"];
  }): Promise<PrecheckResult> {
    const provider = deps.provider();
    if (!provider || (input.providerId !== undefined && provider.id !== input.providerId)) {
      return { allowed: false, reason: "no-provider" };
    }
    let structured: unknown;
    try {
      structured = provider.getCapabilities().structuredOutput;
    } catch {
      structured = "unreadable";
    }
    if (structured !== true) {
      return {
        allowed: false,
        reason:
          structured === "unreadable"
            ? "capabilities-unavailable"
            : "structured-output-unsupported",
      };
    }
    const classification: DataClassification = "general";
    const egress = deps.egress.decide({
      providerId: provider.id,
      taskKind: input.taskKind,
      classification,
    });
    if (!egress.allowed) return { allowed: false, reason: egress.reason };
    let found = NOT_FOUND;
    if (provider.transport === "cli") {
      const at = clock.now();
      const known = versions.get(provider.id);
      if (known && at - known.at < PRECHECK_VERSION_MEMORY_MS) found = known.found;
      else {
        found = await cliVersion(provider, limits.versionQueryTimeoutMs);
        versions.set(provider.id, { at, found });
      }
    }
    const execution = deps.execution.decide({
      providerId: provider.id,
      transport: provider.transport,
      taskKind: input.taskKind,
      trigger: "background",
      classification,
      malicious: true,
      version: found.version,
      unverifiedAcknowledged: false,
    });
    return execution.run ? { allowed: true } : { allowed: false, reason: execution.reason };
  }

  return { call, budgetUsage, precheck };
}

export type Broker = ReturnType<typeof createBroker>;
