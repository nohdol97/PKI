// A user's value for a fact, given as text or as pieces (S03-R19 `/correct`, S03-R3): the stored text of a fact
// kind the registry governs, or `misfit`. A value of one of the nine analytical types goes through the same
// normaliser extraction uses, so a column differing in case, or a column set in another order, is the same row.
// A kind no verified definition names is not governed: a text stays as given, pieces are refused.
import {
  ANALYTICAL_VALUE_TYPES,
  normalizeValue,
  type AnalyticalValueType,
} from "./analytical-types.ts";
import { factValueFit, readOntologyElement } from "./ontology.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** The text length the user path allows for a value (the contract's `SEMANTIC_TEXT_MAX`, in code points). */
const MAX_TEXT = 500;

export type UserValue = { status: "ok"; value: string } | { status: "misfit" };

export function normalizeUserValue(db: SqlDriver, kind: string, raw: unknown): UserValue {
  const element = readOntologyElement(db, "fact-kind", kind);
  const rule = element?.status === "verified" ? element.rule : undefined;
  const text = typeof raw === "string" ? raw.trim() : undefined;
  if (rule?.elementKind !== "fact-kind") {
    return text !== undefined && text !== "" ? { status: "ok", value: text } : { status: "misfit" };
  }
  if ((ANALYTICAL_VALUE_TYPES as readonly string[]).includes(rule.valueType)) {
    const stored = normalizeValue(rule.valueType as AnalyticalValueType, text ?? raw);
    return stored !== null && [...stored].length <= MAX_TEXT
      ? { status: "ok", value: stored }
      : { status: "misfit" };
  }
  // the older value types are text: pieces are not theirs
  return text !== undefined && factValueFit(db, kind, text) !== "misfit"
    ? { status: "ok", value: text }
    : { status: "misfit" };
}
