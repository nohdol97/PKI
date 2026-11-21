// Provider Broker core (V01-R8, ARCHITECTURE 5.1): every Provider call goes
// through here. The caller names IDs only. The Broker decides the call kind from
// its records, reads the text from the canonical store, grades it, asks the
// egress decision (T08) and the execution condition (T09), and applies the
// concurrency cap, call budget, timeout, retry with backoff and history.
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
import { readJob, readSourceVersion, type SqlDriver } from "@pki/storage";
import { randomUUID } from "node:crypto";
import material from "./connection-test-material.json" with { type: "json" };
import { lookupSynthetic } from "./synthetic-manifest.ts";
import { TASKS } from "./tasks.ts";
import type { UserActionRedeemer } from "./user-actions.ts";

/**
 * Connector kinds of the public repository whose records may grade synthetic.
 * Any other kind (site-*, "unknown" from schema v1, a fork's own) never does.
 */
const SYNTHETIC_CONNECTOR_KINDS: ReadonlySet<string> = new Set(["test-fixtures"]);
const CONNECTION_TEST_DOCUMENT: UntrustedDocument = Object.freeze({
  id: "connection-test-material",
  title: material.title,
  body: material.body,
});

export interface CandidateItem {
  readonly name: string;
  readonly evidenceSourceVersionIds: readonly string[];
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
export type CliExecution = LLMRequest["execution"] & {};

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
  | "budget-exhausted";

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
  record(entry: CallRecord): void;
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
  /** Provider attempts allowed in any window of windowMs. */
  callBudget: { maxCalls: number; windowMs: number };
}

export const DEFAULT_LIMITS: Readonly<BrokerLimits> = Object.freeze({
  maxConcurrent: 2,
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  maxTimeoutMs: 120_000,
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
  limits?: Partial<BrokerLimits>;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
}

export type RejectReason =
  | "invalid-request"
  | "unknown-task-version"
  | "no-documents"
  | "unexpected-ids"
  | "unknown-origin"
  | "origin-used"
  | "origin-mismatch"
  | "missing-source"
  | "missing-candidate";

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
  | {
      status: "failed";
      requestId: string;
      error: "timeout" | "rate-limited" | "provider-error" | "invalid-output";
      attempts: number;
    };

interface Prepared {
  request: BrokerRequest;
  task: (typeof TASKS)[TaskKind][1];
  trigger: "user" | "background";
  unverifiedAcknowledged: boolean;
  documents: UntrustedDocument[];
  candidates: { id: string; name: string }[];
  classification: DataClassification;
  malicious: boolean;
}

type Graded = { classification: DataClassification; malicious: boolean };

/** Synthetic only when the manifest lists exactly this title and body from a trusted origin. */
function grade(title: string, body: string, trustedOrigin: boolean): Graded {
  const listed = trustedOrigin ? lookupSynthetic(title, body) : undefined;
  // The public repository has one general class for every access scope (ADR 0014);
  // a deployment fork maps access_scope to its own classes here (S08).
  return listed
    ? { classification: "synthetic", malicious: listed.malicious }
    : { classification: "general", malicious: false };
}

const reject = (reason: RejectReason) => ({ status: "rejected", reason }) as const;

/** The strictest class: synthetic only if there is input and all of it is synthetic. */
export function strictest(graded: readonly Graded[]): DataClassification {
  return graded.length > 0 && graded.every((g) => g.classification === "synthetic")
    ? "synthetic"
    : "general";
}

function readGraded(db: SqlDriver, id: string) {
  const stored = readSourceVersion(db, Number(id));
  if (!stored) return undefined;
  const trusted =
    stored.connectorKind !== null && SYNTHETIC_CONNECTOR_KINDS.has(stored.connectorKind);
  return {
    document: { id, title: stored.title, body: stored.body },
    ...grade(stored.title, stored.body, trusted),
  };
}

function prepare(deps: BrokerDeps, raw: unknown): Prepared | { reason: RejectReason } {
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
  if (request.taskKind === "extract" && ids.length === 0) return { reason: "no-documents" };
  if (request.taskKind === "connection-test" && ids.length + request.candidateItemIds.length > 0) {
    return { reason: "unexpected-ids" };
  }

  let trigger: Prepared["trigger"];
  let unverifiedAcknowledged = false;
  if ("jobId" in request.origin) {
    const job = readJob(deps.db, Number(request.origin.jobId));
    if (!job) return { reason: "unknown-origin" };
    if (job.kind !== request.taskKind) return { reason: "origin-mismatch" };
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
    const read = readGraded(deps.db, id);
    if (!read) return { reason: "missing-source" };
    documents.push(read.document);
    graded.push(read);
  }
  const candidates: Prepared["candidates"] = [];
  for (const id of request.candidateItemIds) {
    const item = deps.candidates.lookup(id);
    if (!item) return { reason: "missing-candidate" };
    candidates.push({ id, name: item.name });
    // a name with no evidence source has no known origin: general (fail closed)
    if (item.evidenceSourceVersionIds.length === 0) {
      graded.push({ classification: "general", malicious: false });
    }
    for (const evidenceId of item.evidenceSourceVersionIds) {
      const read = readGraded(deps.db, evidenceId);
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

/** The version a CLI reports through its fixed-argument query; undefined if it cannot tell. */
async function cliVersion(provider: LLMProvider): Promise<string | undefined> {
  try {
    const info = await provider.detect();
    return info.installed && typeof info.version === "string" ? info.version : undefined;
  } catch {
    return undefined; // not listed, then; the Provider's message stays out
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
      outcome: Exclude<CallOutcome, "ok" | "blocked" | "budget-exhausted">;
      retryable: boolean;
      retryAfterMs?: number;
    };

async function attemptOnce(
  provider: LLMProvider,
  request: StructuredRequest,
  task: Prepared["task"],
  timeoutMs: number,
): Promise<Attempt> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  // started inside a promise chain, so a synchronous throw is a rejection like any other
  const running = Promise.resolve().then(() =>
    provider.generateStructured(request, controller.signal),
  );
  running.catch(() => undefined); // settles after a timeout too; nobody awaits it then
  try {
    const winner = await Promise.race([running, timedOut]);
    if (winner === "timeout") {
      controller.abort();
      // asked, never awaited: a cancel that hangs or throws cannot hold the slot
      try {
        provider.cancel(request.requestId).catch(() => undefined);
      } catch {
        // the call is already aborted and reported as a timeout
      }
      return { outcome: "timeout", retryable: true };
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
  }
}

export function createBroker(deps: BrokerDeps) {
  const limits: BrokerLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const clock = deps.clock ?? {
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const slot = semaphore(limits.maxConcurrent);
  const attemptTimes: number[] = [];

  function takeBudget(): boolean {
    const now = clock.now();
    while (attemptTimes.length > 0 && (attemptTimes[0] ?? 0) <= now - limits.callBudget.windowMs) {
      attemptTimes.shift();
    }
    if (attemptTimes.length >= limits.callBudget.maxCalls) return false;
    attemptTimes.push(now);
    return true;
  }

  async function call(raw: unknown): Promise<BrokerResult> {
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
      { egress: EgressDecision; cli: CliExecution | undefined } | { reason: string }
    > => {
      const egress = deps.egress.decide({
        providerId: provider.id,
        taskKind: request.taskKind,
        classification,
      });
      if (!egress.allowed) return { reason: egress.reason };
      const execution = deps.execution.decide({
        providerId: provider.id,
        transport: provider.transport,
        taskKind: request.taskKind,
        trigger,
        classification,
        malicious,
        // asked again every attempt: a CLI updated meanwhile is no longer the listed one
        version: provider.transport === "cli" ? await cliVersion(provider) : undefined,
        unverifiedAcknowledged: prepared.unverifiedAcknowledged,
      });
      return execution.run ? { egress, cli: execution.cli } : { reason: execution.reason };
    };

    return slot(async (): Promise<BrokerResult> => {
      for (let attempt = 1; ; attempt++) {
        const decided = await decide();
        if ("reason" in decided) {
          deps.recorder.record({ ...base, attempt, outcome: "blocked", reason: decided.reason });
          return { status: "blocked", requestId, reason: decided.reason };
        }
        const { egress, cli } = decided;
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
          ...(cli ? { execution: cli } : {}),
        };
        const started = clock.now();
        const result = await attemptOnce(provider, outgoing, task, timeoutMs);
        deps.recorder.record({
          ...base,
          ...where,
          attempt,
          outcome: result.outcome,
          durationMs: clock.now() - started,
        });
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
        await clock.sleep(Math.min(result.retryAfterMs ?? backoff, limits.backoffMaxMs));
      }
    });
  }

  return { call };
}

export type Broker = ReturnType<typeof createBroker>;
