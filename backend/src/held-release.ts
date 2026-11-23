// When a held job may be judged again (I03-R16). A job is held for a reason code
// the Broker gave; this table says which change can lift each reason, and the
// three ways it is lifted use it:
//  ① an event, in the transaction that writes the setting or consent that changed
//    (releaseHeldOnEvent), so a stop between the write and the release cannot lose it;
//  ② the clock, for reasons no event announces (a CLI fixed, a verified list that
//    changed): once at start and every hour, one Broker precheck per (reason, kind)
//    rather than one Broker pass per held job (reevaluateHeldJobs);
//  ③ a changed policy fingerprint at start, for rules that change outside the
//    process (releaseOnPolicyChange).
// Lifting puts a job back in the queue; whether it may run is the Broker's
// judgement at the next claim, which holds it again, attempt unspent, if the
// condition stands (R11). A reason not in the table (a source too large) is never lifted here.
import { TASK_KINDS, type TaskKind } from "@pki/contracts";
import { BUILD_KIND, readDefaultProvider, type Broker } from "@pki/providers";
import {
  heldGroups,
  requeueHeldOnFingerprint,
  requeueHeldReasons,
  type SqlDriver,
} from "@pki/storage";
import { createHash } from "node:crypto";
import type { JobRunner } from "./job-runner.ts";

/** A change of a condition that holds jobs: it is written together with its release. */
export type HeldEvent = "consent" | "background" | "default-provider" | "provider-config";

interface HeldReason {
  /** The changes that can lift it. */
  events: readonly HeldEvent[];
  /** No event announces its end: the clock re-judges it by a Broker precheck. */
  periodic?: true;
  /** The policy fingerprint's inputs (rules, verified list, default Provider) can end it. */
  policy?: true;
  /** A Connector instance's own state: lifted per instance (connector-sync-job.ts), never by the events above. */
  collector?: true;
}

const BY_PROVIDER = "default-provider" as const; // a different Provider may be allowed

export const HELD_REASONS: Readonly<Record<string, HeldReason>> = {
  "no-consent": { events: ["consent", BY_PROVIDER] },
  "consent-stale-destination": { events: ["consent", "provider-config", BY_PROVIDER] },
  "consent-stale-policy": { events: ["consent", BY_PROVIDER], policy: true },
  "rule-denied": { events: [BY_PROVIDER], policy: true },
  "no-matching-rule": { events: ["consent", BY_PROVIDER], policy: true },
  "destination-unavailable": { events: ["provider-config", BY_PROVIDER] },
  "insecure-endpoint": { events: ["provider-config", BY_PROVIDER] },
  "cli-background-off": { events: ["background", BY_PROVIDER] },
  "cli-not-verified": { events: [BY_PROVIDER], periodic: true, policy: true },
  "cli-unknown": { events: [BY_PROVIDER], periodic: true, policy: true },
  "capabilities-unavailable": { events: [BY_PROVIDER], periodic: true },
  "structured-output-unsupported": { events: [BY_PROVIDER], periodic: true },
  "no-provider": { events: [BY_PROVIDER], periodic: true, policy: true },
  // A collector held because its instance cannot run (I03-R16 ②′, I01-R20): the instance's
  // settings change, a start that finds it ready and the hourly recheck lift it, per instance.
  "unsupported-sdk-version": { events: [], collector: true },
  "connector-unavailable": { events: [], collector: true },
  "not-implemented": { events: [], collector: true },
  // The stored data binds the instance id to another kind (I05F-R4): a start that finds it ready lifts it.
  "instance-kind-mismatch": { events: [], collector: true },
  // The instance's credentials cannot be used (I06-R9): lifted per instance when it is ready again.
  "credential-store-unavailable": { events: [], collector: true },
  "credential-missing": { events: [], collector: true },
  "credential-unreadable": { events: [], collector: true },
  "credential-rejected": { events: [], collector: true },
  // Only the development exception gives these (execution-gate.ts), so a production
  // build never holds a job for them; the constant folds and the bundle keeps none of
  // the exception's strings (artifact.contents). Provisional: a production start on a
  // database a development build left with such a job keeps it held.
  ...(BUILD_KIND === "production"
    ? {}
    : {
        "unverified-background": { events: [BY_PROVIDER], periodic: true, policy: true },
        "unverified-not-synthetic": { events: [BY_PROVIDER], periodic: true, policy: true },
        "unverified-malicious": { events: [BY_PROVIDER], periodic: true, policy: true },
        "unverified-ack-required": { events: [BY_PROVIDER], periodic: true, policy: true },
      }),
};

const reasonsWhere = (test: (reason: HeldReason) => boolean): string[] =>
  Object.entries(HELD_REASONS)
    .filter(([, reason]) => test(reason))
    .map(([code]) => code);

/** The reasons a collector is held for, lifted per Connector instance (connector-sync-job.ts). */
export const COLLECTOR_HELD_REASONS: readonly string[] = reasonsWhere((r) => r.collector === true);

/** Lifts the jobs `event` can lift, in the caller's transaction. Returns how many went back. */
export function releaseHeldOnEvent(db: SqlDriver, event: HeldEvent, at?: Date): number {
  return requeueHeldReasons(db, {
    reasons: reasonsWhere((r) => r.events.includes(event)),
    ...(at && { at }),
  });
}

/** The value stamped on a held job: the policy it was judged under (I03-R2, R16 ③). */
export function computePolicyFingerprint(inputs: {
  policyVersion: string;
  /** The verified CLI combinations the execution gate decides with. */
  verified: unknown;
  defaultProvider: string | undefined;
}): string {
  const canonical = JSON.stringify([
    inputs.policyVersion,
    inputs.verified,
    inputs.defaultProvider ?? null,
  ]);
  return `pf-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/**
 * At start (R16 ③): held jobs stamped with another fingerprint than the current
 * one go back, for the reasons the fingerprint's inputs can end; a job with no
 * stamp (migrated from V02) goes back for every reason in the table. A restart
 * alone does not lift anything else.
 */
export function releaseOnPolicyChange(
  db: SqlDriver,
  fingerprint: string,
  runner: Pick<JobRunner, "wake">,
): number {
  const released = requeueHeldOnFingerprint(db, {
    fingerprint,
    reasons: Object.keys(HELD_REASONS),
    changedReasons: reasonsWhere((r) => r.policy === true),
  });
  if (released > 0) void runner.wake();
  return released;
}

const isTaskKind = (kind: string): kind is TaskKind =>
  (TASK_KINDS as readonly string[]).includes(kind);

/**
 * One precheck per (reason, kind) among the held jobs of the reasons only the clock
 * can end (R16 ②); a group that passes goes back to the queue together. Returns
 * how many jobs went back. The Broker's version memory keeps the CLI queries to
 * one per Provider per hour.
 */
export async function reevaluateHeldJobs(
  db: SqlDriver,
  broker: Pick<Broker, "precheck">,
  at?: Date,
): Promise<number> {
  const providerId = readDefaultProvider(db);
  let released = 0;
  for (const { reason, kind } of heldGroups(db)) {
    if (HELD_REASONS[reason]?.periodic !== true || !isTaskKind(kind)) continue;
    const verdict = await broker.precheck({ taskKind: kind, ...(providerId && { providerId }) });
    if (verdict.allowed) {
      released += requeueHeldReasons(db, { reasons: [reason], kind, ...(at && { at }) });
    }
  }
  return released;
}

/** How often the clock re-judges held jobs (R16 ②). */
export const HELD_REEVALUATION_MS = 3_600_000;

/**
 * Re-evaluates now and every HELD_REEVALUATION_MS; wakes the runner when a job went
 * back. Errors go to `onError` (a failing pass is tried again at the next).
 */
export function startHeldReevaluation(options: {
  db: SqlDriver;
  broker: Pick<Broker, "precheck">;
  runner: Pick<JobRunner, "wake">;
  onError?: (error: unknown) => void;
}): { stop(): void } {
  const pass = () =>
    reevaluateHeldJobs(options.db, options.broker).then(
      (released) => {
        if (released > 0) void options.runner.wake();
      },
      (error: unknown) => options.onError?.(error),
    );
  void pass();
  const timer = setInterval(() => void pass(), HELD_REEVALUATION_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
