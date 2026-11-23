// The user's decision on a finding (K02-R11, R12): the one place that changes a finding's status for the user.
// Accepting calls the existing entry for the rule (a merge, a rejection, a relation the user typed) in the
// caller's transaction and marks the finding `accepted` only when that entry took it; a refusal leaves the
// finding open and hands its code back. Dismissing and reopening change the finding alone (K02-D7: no
// "different thing" mark). A report of something the rules missed is stored as an open finding of origin
// `user`. The visibility of the rows is the caller's check (the read gate), as for every user entry.
import {
  fingerprintOf,
  findFinding,
  insertFinding,
  readFinding,
  setFindingStatus,
  type FindingTarget,
  type LintRule,
  type SqlDriver,
  type StoredFinding,
} from "@pki/storage";
import { itemsOfFinding, lineageOfTarget } from "./lint-rules.ts";

export type LintOp = "accept" | "dismiss" | "reopen";

/** What an entry answers: its status, and the code when it refused. */
interface EntryAnswer {
  status: string;
  reason?: string;
}

/**
 * The three existing entries accepting a finding calls, as the user's entry offers them (the API layer hands
 * over `UserDecisions`, which has this shape; the type itself is imported by the API layer alone).
 */
export interface LintEntries {
  decide(
    tx: SqlDriver,
    ref: { kind: "fact" | "relation"; id: number },
    action: "reject",
    at: string,
  ): EntryAnswer;
  add(
    tx: SqlDriver,
    entry: { kind: "relation"; subjectId: number; type: string; objectId: number },
    at: string,
  ): EntryAnswer;
  readonly entities: {
    merge(tx: SqlDriver, member: number, into: number, at: string): EntryAnswer;
  };
}

const refusal = (done: EntryAnswer): string | undefined =>
  done.status === "refused" ? (done.reason ?? "refused") : undefined;

export type DecideOutcome =
  | { status: "applied"; finding: StoredFinding }
  /** The entry's own refusal code (`type-mismatch`, `value-exists`, `scope-refused`…), or ours below. */
  | { status: "refused"; reason: string }
  | { status: "not-found" };

/** Our own refusals: the finding is not in a state the op applies to, the rule has no entry, a relation needs its type. */
export const NOT_IN_STATE = "invalid-state";
export const NO_ENTRY = "no-entry";
export const TYPE_REQUIRED = "relation-type-required";

const OPEN_LIKE = new Set(["open", "oscillating"]);

/** What accepting does for each rule: the existing entry's refusal reason, or undefined when it took it. */
function applyEntry(
  tx: SqlDriver,
  decisions: LintEntries,
  f: StoredFinding,
  relationType: string | undefined,
  at: string,
): string | undefined {
  const { target } = f;
  switch (f.rule) {
    case "stale": {
      const done = decisions.decide(
        tx,
        { kind: target.kind as "fact" | "relation", id: target.a },
        "reject",
        at,
      );
      return refusal(done);
    }
    case "synonym": {
      // the later item joins the earlier one's group
      const done = decisions.entities.merge(tx, target.b as number, target.a, at);
      return refusal(done);
    }
    case "missing-link": {
      if (relationType === undefined) return TYPE_REQUIRED;
      const done = decisions.add(
        tx,
        { kind: "relation", subjectId: target.a, type: relationType, objectId: target.b as number },
        at,
      );
      return refusal(done);
    }
    case "overdue-work":
      return NO_ENTRY;
  }
}

export function decideFinding(
  tx: SqlDriver,
  decisions: LintEntries,
  input: { id: number; op: LintOp; relationType?: string },
  at: string,
): DecideOutcome {
  const finding = readFinding(tx, input.id);
  if (!finding) return { status: "not-found" };
  const change = (status: StoredFinding["status"]): DecideOutcome => {
    setFindingStatus(tx, finding.id, status, at);
    return { status: "applied", finding: readFinding(tx, finding.id) as StoredFinding };
  };
  if (input.op === "reopen") {
    return finding.status === "dismissed"
      ? change("open")
      : { status: "refused", reason: NOT_IN_STATE };
  }
  if (!OPEN_LIKE.has(finding.status)) return { status: "refused", reason: NOT_IN_STATE };
  if (input.op === "dismiss") return change("dismissed");
  const refused = applyEntry(tx, decisions, finding, input.relationType, at);
  return refused === undefined ? change("accepted") : { status: "refused", reason: refused };
}

export type ReportOutcome =
  | { status: "applied"; finding: StoredFinding }
  /** The rule already found it (or the user reported it): nothing is stored and nothing counts as missed. */
  | { status: "exists"; finding: StoredFinding }
  | { status: "refused"; reason: "bad-target" | "not-found" };

const TWO_ITEMS: readonly LintRule[] = ["synonym", "missing-link"];

/** Whether the target has the shape the rule's findings have (`stale`: one fact or relation, the others items). */
export const hasRuleShape = (rule: LintRule, target: FindingTarget): boolean =>
  rule === "stale"
    ? target.kind !== "item" && target.b === null
    : target.kind === "item" &&
      (target.b !== null) === TWO_ITEMS.includes(rule) &&
      target.a !== target.b;

/** The user's "the rules missed this": an open finding of origin `user`, the rule's miss. */
export function reportMissed(
  tx: SqlDriver,
  input: { rule: LintRule; target: FindingTarget },
  at: string,
): ReportOutcome {
  const { rule } = input;
  if (!hasRuleShape(rule, input.target)) return { status: "refused", reason: "bad-target" };
  // two items are named smaller id first, as the rules name them: one fingerprint for one pair
  const target: FindingTarget =
    input.target.b !== null && input.target.a > input.target.b
      ? { kind: "item", a: input.target.b, b: input.target.a }
      : input.target;
  const items = itemsOfFinding(tx, target);
  if (!items) return { status: "refused", reason: "not-found" };
  const existing = findFinding(tx, fingerprintOf(rule, target));
  if (existing) return { status: "exists", finding: existing };
  const lineage = lineageOfTarget(tx, target, items);
  const id = insertFinding(tx, { rule, target, origin: "user", status: "open", lineage, at });
  return { status: "applied", finding: readFinding(tx, id) as StoredFinding };
}
