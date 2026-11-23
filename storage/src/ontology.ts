// The type-definition registry (S01-R18..R20, schema v21): item types, fact kinds and relation types
// as rows with a rule of a fixed shape, a status and an edition. A change (add, change a rule,
// retire) passes three checks in order (R19): a duplicate name, the shape of the name and rule, and
// the effect on the rows that exist; `checkOntologyChange` only reports, `applyOntologyChange`
// (automated) and `applyUserOntologyChange` (package-internal) check and apply.
// The user's change is applied and is `verified`. What an automated actor
// proposes is recorded as a `candidate` with the source version it rests on and is never applied
// (R20). The user's approval, rejection and undo of an element and of a retirement (S01-T07) are in
// `userOntology` at the end: three user transitions only (candidate -> verified, candidate -> rejected,
// verified -> superseded by a retirement), every one behind a history line.
//
// A name can come from a source, so no refusal and no history line carries one: a refusal holds
// counts and fixed codes, a history line numbers and codes (R6). The duplicates a check reports
// name the stored element, as the spec's `OntologyCheck` does, and are not copied into a refusal.
import {
  DATA_CHECK_NAMES,
  FACT_VALUE_TYPES,
  WORK_STATUSES,
  RESERVED_NAMES,
  type DataCheckName,
  type FactValueType,
} from "@pki/contracts";
import {
  ANALYTICAL_VALUE_TYPES,
  REQUIRED_DATA_CHECKS,
  normalizeValue,
  type AnalyticalValueType,
} from "./analytical-types.ts";
import type { KnowledgeStatus } from "./knowledge.ts";
import type { Actor, Basis } from "./semantic-lifecycle.ts";
import type { SqlDriver, SqlRow } from "./sql-driver.ts";

export type ElementKind = "item-type" | "fact-kind" | "relation-type";
export type ValueType = FactValueType;
/** Where a definition came from (S02-R3): written when it is made and never changed. */
export type ElementOrigin = "seed" | "user" | "source-proposed";
export type Cardinality = "one" | "many";
export type ElementRule =
  | { elementKind: "item-type" }
  | {
      elementKind: "fact-kind";
      itemTypes: readonly string[];
      valueType: ValueType;
      cardinality: Cardinality;
      /** S03-R13: the checks a row of this kind needs before it can be `verified`; absent or empty means none. */
      dataChecks?: readonly DataCheckName[] | undefined;
    }
  | {
      elementKind: "relation-type";
      subjectTypes: readonly string[];
      objectTypes: readonly string[];
      symmetric: boolean;
    };
export type OntologyChange =
  | { op: "add"; name: string; rule: ElementRule }
  | { op: "change-rule"; elementKind: ElementKind; name: string; rule: ElementRule }
  | { op: "retire"; elementKind: ElementKind; name: string };

export interface OntologyCheck {
  duplicates: readonly { name: string; status: KnowledgeStatus }[];
  /** Fixed codes, never text. */
  schemaErrors: readonly string[];
  impact: { liveRows: number; violations: number };
  /** True only when no duplicate, no schema error and no violation is found. */
  applicable: boolean;
}

export interface StoredElement {
  id: number;
  elementKind: ElementKind;
  name: string;
  rule: ElementRule;
  status: KnowledgeStatus;
  edition: number;
  origin: ElementOrigin;
}

export type OntologyRefusal =
  | "duplicate"
  | "schema-invalid"
  | "existing-data-violation"
  | "basis-required"
  | "invalid-transition"
  | "not-found"
  | "not-latest"
  | "nothing-to-undo";
export type OntologyOutcome =
  /** The user's change was applied; `seq` is its history line. */
  | { status: "applied"; id: number; edition: number; seq: number }
  /** An automated proposal was recorded as a candidate; nothing is in force. */
  | { status: "candidate"; id: number; seq: number }
  | {
      status: "refused";
      reason: OntologyRefusal;
      /** Counts and codes only: no name. */
      duplicates: number;
      schemaErrors: readonly string[];
      impact: { liveRows: number; violations: number };
    };

/** What the user's change answers: applied or refused, never a candidate (that is the automated actor's). */
export type UserChangeOutcome = Exclude<OntologyOutcome, { status: "candidate" }>;

/** What the user's approve, reject and undo answer: the refusal of the changes, plus unchanged and removed. */
export type OntologyActionOutcome =
  | Extract<OntologyOutcome, { status: "applied" | "refused" }>
  | { status: "unchanged"; id: number }
  /** An undo took away the element itself (an add of the user's, or an approval with no lineage left). */
  | { status: "removed"; id: number };

const COLUMNS = "id, element_kind, name, rule, status, edition, origin";
const toElement = (row: SqlRow): StoredElement => ({
  id: row.id as number,
  elementKind: row.element_kind as ElementKind,
  name: row.name as string,
  rule: JSON.parse(row.rule as string) as ElementRule,
  status: row.status as KnowledgeStatus,
  edition: row.edition as number,
  origin: row.origin as ElementOrigin,
});

/** Every element in the order they were added. */
export const listOntologyElements = (db: SqlDriver): StoredElement[] =>
  db.all(`SELECT ${COLUMNS} FROM ontology_elements ORDER BY id`).map(toElement);

export function readOntologyElement(
  db: SqlDriver,
  elementKind: ElementKind,
  name: string,
): StoredElement | undefined {
  const row = db.all(
    `SELECT ${COLUMNS} FROM ontology_elements WHERE element_kind = ? AND name = ?`,
    [elementKind, name],
  )[0];
  return row ? toElement(row) : undefined;
}

export function readOntologyElementById(db: SqlDriver, id: number): StoredElement | undefined {
  const row = db.all(`SELECT ${COLUMNS} FROM ontology_elements WHERE id = ?`, [id])[0];
  return row ? toElement(row) : undefined;
}

export interface OntologyHistoryLine {
  seq: number;
  at: string;
  actor: Actor;
  action: string;
  fromStatus: KnowledgeStatus | null;
  toStatus: KnowledgeStatus;
  fromEdition: number | null;
  toEdition: number;
  reason: string | null;
  basisSourceId: number | null;
  basisVersion: number | null;
  batch: number | null;
  revertsSeq: number | null;
}

/** An element's history, oldest first: numbers and closed codes only (S01-R6). */
export function readOntologyHistory(db: SqlDriver, id: number): OntologyHistoryLine[] {
  return db
    .all(
      `SELECT seq, at, actor, action, from_status, to_status, from_edition, to_edition, reason,
         basis_source_id, basis_version, batch, reverts_seq
       FROM ontology_history WHERE element_id = ? ORDER BY seq`,
      [id],
    )
    .map((r) => ({
      seq: r.seq as number,
      at: r.at as string,
      actor: r.actor as Actor,
      action: r.action as string,
      fromStatus: r.from_status as KnowledgeStatus | null,
      toStatus: r.to_status as KnowledgeStatus,
      fromEdition: r.from_edition as number | null,
      toEdition: r.to_edition as number,
      reason: r.reason as string | null,
      basisSourceId: r.basis_source_id as number | null,
      basisVersion: r.basis_version as number | null,
      batch: r.batch as number | null,
      revertsSeq: r.reverts_seq as number | null,
    }));
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.]{0,39}$/;
/** Whether a name has the shape R19 asks of a type definition's name; extraction checks a proposal with it before it offers one (S02-R5). */
export const isElementName = (name: string): boolean => IDENTIFIER.test(name);
const KINDS: readonly ElementKind[] = ["item-type", "fact-kind", "relation-type"];
const VALUE_TYPES: readonly string[] = FACT_VALUE_TYPES;
const CARDINALITIES: readonly string[] = ["one", "many"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIVE = "status NOT IN ('rejected', 'superseded')";

/** The comparison of R19's duplicate check: case, `_`, `.` and `-` do not count. */
export const squash = (name: string) => name.toLowerCase().replace(/[_.-]/g, "");

/** A normalized calendar date (YYYY-MM-DD) that exists; such strings order as dates. The one copy. */
export const isDate = (value: string): boolean => {
  const time = DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
};

/**
 * Whether a value is of the kind a fact kind's rule names (S01-R21): `date` a calendar date, `text`,
 * `surface-form` and `identifier` (S02-R2) not empty (after trimming), `work-status` (P01-R11) one of its four values (case aside). The one value check: extraction and the user's add
 * and value fix both use it, so the two paths accept and reject the same values.
 */
export const valueFits = (valueType: ValueType, value: string): boolean =>
  valueType === "date"
    ? isDate(value)
    : valueType === "work-status"
      ? (WORK_STATUSES as readonly string[]).includes(value.trim().toLowerCase())
      : (ANALYTICAL_VALUE_TYPES as readonly string[]).includes(valueType)
        ? normalizeValue(valueType as AnalyticalValueType, value) !== null
        : value.trim() !== "";

/**
 * The same check for a fact kind by name, reading the `verified` type definitions: `unregistered`
 * when no `verified` element names the kind (the user's own paths do not govern such a kind; extraction
 * drops it).
 */
export function factValueFit(
  db: SqlDriver,
  kind: string,
  value: string,
): "fits" | "misfit" | "unregistered" {
  const element = readOntologyElement(db, "fact-kind", kind);
  if (!element || element.status !== "verified" || element.rule.elementKind !== "fact-kind") {
    return "unregistered";
  }
  return valueFits(element.rule.valueType, value) ? "fits" : "misfit";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The item types a rule names, checked against the registry: present and verified. */
function typeListErrors(db: SqlDriver, list: unknown, invalid: string, errors: Set<string>): void {
  if (!Array.isArray(list) || list.length === 0 || list.some((t) => typeof t !== "string")) {
    errors.add(invalid);
    return;
  }
  for (const type of list as string[]) {
    const stored = readOntologyElement(db, "item-type", type);
    if (!stored) errors.add("item-type-unknown");
    else if (stored.status !== "verified") errors.add("item-type-not-verified");
  }
}

/**
 * `dataChecks` against the value type (S03-R13): the list is of known names without a repeat, holds every
 * check the value type requires and none it does not allow. The value type decides, so a kind a user adds
 * with a calculation-shaped value cannot go without the checks.
 */
function dataCheckErrors(rule: Record<string, unknown>, errors: Set<string>): void {
  const given = rule.dataChecks;
  if (given !== undefined) {
    const valid =
      Array.isArray(given) &&
      given.every((c) => (DATA_CHECK_NAMES as readonly unknown[]).includes(c)) &&
      new Set(given).size === given.length;
    if (!valid) return void errors.add("data-checks-invalid");
  }
  if (!VALUE_TYPES.includes(rule.valueType as string)) return;
  const list = (given ?? []) as readonly DataCheckName[];
  const need = REQUIRED_DATA_CHECKS[rule.valueType as FactValueType];
  const required = need?.required ?? [];
  const allowed = [...required, ...(need?.optional ?? [])];
  if (!required.every((c) => list.includes(c))) errors.add("data-checks-missing");
  if (!list.every((c) => allowed.includes(c))) errors.add("data-checks-not-allowed");
}

/** The shape of a rule of `kind` (R19 step 2). `rule` is untrusted: it may come from JSON. */
function ruleErrors(db: SqlDriver, kind: ElementKind, rule: unknown, errors: Set<string>): void {
  if (!isObject(rule)) return void errors.add("rule-malformed");
  if (rule.elementKind !== kind) return void errors.add("rule-kind-mismatch");
  const keys = Object.keys(rule).sort().join(",");
  if (kind === "item-type") {
    if (keys !== "elementKind") errors.add("rule-malformed");
  } else if (kind === "fact-kind") {
    if (
      keys !== "cardinality,elementKind,itemTypes,valueType" &&
      keys !== "cardinality,dataChecks,elementKind,itemTypes,valueType"
    ) {
      errors.add("rule-malformed");
    }
    typeListErrors(db, rule.itemTypes, "item-types-invalid", errors);
    if (!VALUE_TYPES.includes(rule.valueType as string)) errors.add("value-type-invalid");
    if (!CARDINALITIES.includes(rule.cardinality as string)) errors.add("cardinality-invalid");
    dataCheckErrors(rule, errors);
  } else {
    if (keys !== "elementKind,objectTypes,subjectTypes,symmetric") errors.add("rule-malformed");
    typeListErrors(db, rule.subjectTypes, "subject-types-invalid", errors);
    typeListErrors(db, rule.objectTypes, "object-types-invalid", errors);
    if (typeof rule.symmetric !== "boolean") errors.add("symmetric-invalid");
  }
}

const sortedUnique = (list: readonly string[]) => [...new Set(list)].sort();
/** A valid rule in its stored form: the type lists sorted and without repeats, the keys in a fixed order. */
export function canonicalRule(rule: ElementRule): ElementRule {
  if (rule.elementKind === "item-type") return { elementKind: "item-type" };
  if (rule.elementKind === "fact-kind") {
    return {
      elementKind: "fact-kind",
      itemTypes: sortedUnique(rule.itemTypes),
      valueType: rule.valueType,
      cardinality: rule.cardinality,
      // an empty list is no list: the stored form of a kind without checks stays what S01 and S02 stored
      ...(rule.dataChecks && rule.dataChecks.length > 0
        ? { dataChecks: sortedUnique(rule.dataChecks) as DataCheckName[] }
        : {}),
    };
  }
  return {
    elementKind: "relation-type",
    subjectTypes: sortedUnique(rule.subjectTypes),
    objectTypes: sortedUnique(rule.objectTypes),
    symmetric: rule.symmetric,
  };
}

function shapeErrors(
  db: SqlDriver,
  change: OntologyChange,
  target: StoredElement | undefined,
  /** The row already exists (an undo of a retirement): a reserved name it took before S02-R3 stays its. */
  existing = false,
): string[] {
  const errors = new Set<string>();
  if (change.op === "add") {
    if (typeof change.name !== "string" || !IDENTIFIER.test(change.name)) {
      errors.add("name-not-identifier");
    }
    // a name stored or computed elsewhere (S02-R3): compared as the duplicate check compares
    if (
      !existing &&
      typeof change.name === "string" &&
      RESERVED_NAMES.some((reserved) => squash(reserved) === squash(change.name))
    ) {
      errors.add("reserved-name");
    }
    const kind = isObject(change.rule) ? change.rule.elementKind : undefined;
    if (!KINDS.includes(kind as ElementKind)) errors.add("rule-kind-unknown");
    else ruleErrors(db, kind as ElementKind, change.rule, errors);
    return [...errors].sort();
  }
  if (!KINDS.includes(change.elementKind)) errors.add("rule-kind-unknown");
  if (!target) errors.add("element-not-found");
  else if (target.status !== "verified") errors.add("element-not-verified");
  if (change.op === "change-rule") {
    if (change.elementKind === "item-type") errors.add("item-type-has-no-rule");
    else if (KINDS.includes(change.elementKind)) {
      ruleErrors(db, change.elementKind, change.rule, errors);
      if (
        errors.size === 0 &&
        target &&
        JSON.stringify(canonicalRule(change.rule)) === JSON.stringify(target.rule)
      ) {
        errors.add("rule-unchanged");
      }
    }
  }
  return [...errors].sort();
}

const count = (db: SqlDriver, sql: string, params: (string | number)[] = []): number =>
  (db.all(sql, params)[0]?.n as number | undefined) ?? 0;

/** The live rows that use the element: items of the type, facts of the kind, relations of the type. */
function liveRowCount(db: SqlDriver, kind: ElementKind, name: string): number {
  const table = kind === "item-type" ? "items" : kind === "fact-kind" ? "facts" : "relations";
  const column = kind === "fact-kind" ? "kind" : "type";
  return count(db, `SELECT count(*) AS n FROM ${table} WHERE ${column} = ? AND ${LIVE}`, [name]);
}

/** Elements in `status` whose rule names the item type. */
function rulesNaming(db: SqlDriver, itemType: string, status: KnowledgeStatus): number {
  return listOntologyElements(db).filter(
    (e) =>
      e.status === status &&
      ((e.rule.elementKind === "fact-kind" && e.rule.itemTypes.includes(itemType)) ||
        (e.rule.elementKind === "relation-type" &&
          (e.rule.subjectTypes.includes(itemType) || e.rule.objectTypes.includes(itemType)))),
  ).length;
}

/** Verified elements whose rule names the item type: retiring it would leave their rules pointing nowhere. */
export const verifiedRulesNaming = (db: SqlDriver, itemType: string): number =>
  rulesNaming(db, itemType, "verified");

const setEquals = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t) => b.includes(t));

/** Live fact rows of `kind` that the rule does not fit, plus the items with two values where one is allowed. */
function factViolations(
  db: SqlDriver,
  name: string,
  rule: Extract<ElementRule, { elementKind: "fact-kind" }>,
): number {
  const rows = db.all(
    `SELECT f.value AS value, i.type AS type FROM facts f JOIN items i ON i.id = f.item_id
     WHERE f.kind = ? AND f.${LIVE}`,
    [name],
  );
  const misfits = rows.filter(
    (r) =>
      !rule.itemTypes.includes(r.type as string) || !valueFits(rule.valueType, r.value as string),
  ).length;
  const crowded =
    rule.cardinality === "one"
      ? count(
          db,
          `SELECT count(*) AS n FROM (SELECT item_id FROM facts WHERE kind = ? AND ${LIVE}
           GROUP BY item_id HAVING count(*) > 1)`,
          [name],
        )
      : 0;
  return misfits + crowded;
}

/** Live relation rows the rule does not fit; a flipped direction misfits every live row. */
function relationViolations(
  db: SqlDriver,
  name: string,
  rule: Extract<ElementRule, { elementKind: "relation-type" }>,
  old: ElementRule | undefined,
  liveRows: number,
): number {
  if (
    old?.elementKind === "relation-type" &&
    !old.symmetric &&
    !rule.symmetric &&
    setEquals(rule.subjectTypes, old.objectTypes) &&
    setEquals(rule.objectTypes, old.subjectTypes) &&
    !setEquals(old.subjectTypes, old.objectTypes)
  ) {
    return liveRows;
  }
  const rows = db.all(
    `SELECT s.type AS subject, o.type AS object FROM relations r
     JOIN items s ON s.id = r.subject_id JOIN items o ON o.id = r.object_id
     WHERE r.type = ? AND r.${LIVE}`,
    [name],
  );
  return rows.filter(
    (r) =>
      !rule.subjectTypes.includes(r.subject as string) ||
      !rule.objectTypes.includes(r.object as string),
  ).length;
}

function impactOf(
  db: SqlDriver,
  change: OntologyChange,
  target: StoredElement | undefined,
): { liveRows: number; violations: number } {
  const kind = change.op === "add" ? change.rule.elementKind : change.elementKind;
  const liveRows = liveRowCount(db, kind, change.name);
  if (change.op === "retire") {
    // a retired item type also strands the verified rules that name it
    const stranded = kind === "item-type" ? verifiedRulesNaming(db, change.name) : 0;
    return { liveRows, violations: liveRows + stranded };
  }
  const rule = canonicalRule(change.rule);
  if (rule.elementKind === "fact-kind") {
    return { liveRows, violations: factViolations(db, change.name, rule) };
  }
  if (rule.elementKind === "relation-type") {
    return {
      liveRows,
      violations: relationViolations(db, change.name, rule, target?.rule, liveRows),
    };
  }
  return { liveRows, violations: 0 };
}

/** R19: the three checks of a change, without applying it or changing anything. */
export function checkOntologyChange(db: SqlDriver, change: OntologyChange): OntologyCheck {
  const target =
    change.op === "add" || !KINDS.includes(change.elementKind)
      ? undefined
      : readOntologyElement(db, change.elementKind, change.name);
  const duplicates =
    change.op === "add" && typeof change.name === "string" && isObject(change.rule)
      ? listOntologyElements(db)
          .filter(
            (e) =>
              e.elementKind === change.rule.elementKind && squash(e.name) === squash(change.name),
          )
          .map((e) => ({ name: e.name, status: e.status }))
      : [];
  const schemaErrors = shapeErrors(db, change, target);
  const impact =
    schemaErrors.length === 0 ? impactOf(db, change, target) : { liveRows: 0, violations: 0 };
  return {
    duplicates,
    schemaErrors,
    impact,
    applicable: duplicates.length === 0 && schemaErrors.length === 0 && impact.violations === 0,
  };
}

interface Line {
  actor: Actor;
  action: string;
  fromStatus: KnowledgeStatus | null;
  toStatus: KnowledgeStatus;
  fromEdition: number | null;
  toEdition: number;
  basis?: Basis | null;
  revertsSeq?: number;
  at?: string | undefined;
}

/** Writes the history line, then the caller changes the row: the order the schema's gate requires. */
function writeLine(tx: SqlDriver, id: number, line: Line): number {
  const seq = count(
    tx,
    "SELECT coalesce(max(seq), 0) + 1 AS n FROM ontology_history WHERE element_id = ?",
    [id],
  );
  tx.run(
    `INSERT INTO ontology_history (element_id, seq, at, actor, action, from_status, to_status,
       from_edition, to_edition, basis_source_id, basis_version, reverts_seq)
     VALUES (?, ?, coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      seq,
      line.at ?? null,
      line.actor,
      line.action,
      line.fromStatus,
      line.toStatus,
      line.fromEdition,
      line.toEdition,
      line.basis?.sourceId ?? null,
      line.basis?.version ?? null,
      line.revertsSeq ?? null,
    ],
  );
  return seq;
}

const refused = (
  reason: OntologyRefusal,
  check?: OntologyCheck,
): Extract<OntologyOutcome, { status: "refused" }> => ({
  status: "refused",
  reason,
  duplicates: check?.duplicates.length ?? 0,
  schemaErrors: check?.schemaErrors ?? [],
  impact: check?.impact ?? { liveRows: 0, violations: 0 },
});

/** An actor that is not the user: what extraction, propagation and policy code may be. */
export type AutomatedActor = Exclude<Actor, "user">;

/**
 * R19, R20: checks the change and records it as a `candidate` for an automated actor, which must
 * name the source version it rests on and may only propose an addition. This is the only entry
 * `@pki/storage` exports (S01-R7: the user's change is not reachable from extraction or product
 * code, as `applyTransition` is not). The type excludes `user`, and a caller that gets past the
 * type is refused at run time. The transaction is the caller's.
 */
export function applyOntologyChange(
  tx: SqlDriver,
  change: OntologyChange,
  actor: AutomatedActor,
  basis: Basis | null = null,
  at?: string,
): OntologyOutcome {
  if ((actor as Actor) === "user") return refused("invalid-transition");
  return applyChange(tx, change, actor, basis, at);
}

/**
 * The user's change: checked, applied, `verified` (edition +1 for a rule change or retirement).
 * Package-internal, not exported from the index: S01-T07 hands it to the API layer only, the way
 * S01-T02 hands the user's row actions.
 */
export const applyUserOntologyChange = (
  tx: SqlDriver,
  change: OntologyChange,
  at?: string,
): UserChangeOutcome => applyChange(tx, change, "user", null, at) as UserChangeOutcome;

function applyChange(
  tx: SqlDriver,
  change: OntologyChange,
  actor: Actor,
  basis: Basis | null,
  at?: string,
): OntologyOutcome {
  const byUser = actor === "user";
  if (!byUser) {
    if (change.op !== "add") return refused("invalid-transition");
    const known =
      basis !== null &&
      count(tx, "SELECT count(*) AS n FROM source_versions WHERE source_id = ? AND version = ?", [
        basis.sourceId,
        basis.version,
      ]) === 1;
    if (!known) return refused("basis-required");
  }
  const check = checkOntologyChange(tx, change);
  if (check.duplicates.length > 0) return refused("duplicate", check);
  if (check.schemaErrors.includes("element-not-found")) return refused("not-found", check);
  if (check.schemaErrors.length > 0) return refused("schema-invalid", check);
  if (!check.applicable) return refused("existing-data-violation", check);

  if (change.op === "add") {
    const status: KnowledgeStatus = byUser ? "verified" : "candidate";
    const id = tx.run(
      "INSERT INTO ontology_elements (element_kind, name, rule, status, edition, origin) VALUES (?, ?, ?, ?, 1, ?)",
      [
        change.rule.elementKind,
        change.name,
        JSON.stringify(canonicalRule(change.rule)),
        status,
        byUser ? "user" : "source-proposed",
      ],
    ).lastInsertRowid;
    if (!byUser && basis) {
      tx.run("INSERT INTO ontology_basis (element_id, source_id, version) VALUES (?, ?, ?)", [
        id,
        basis.sourceId,
        basis.version,
      ]);
    }
    const seq = writeLine(tx, id, {
      actor,
      action: "created",
      fromStatus: null,
      toStatus: status,
      fromEdition: null,
      toEdition: 1,
      basis: byUser ? null : basis,
      at,
    });
    return byUser ? { status: "applied", id, edition: 1, seq } : { status: "candidate", id, seq };
  }

  const target = readOntologyElement(tx, change.elementKind, change.name) as StoredElement;
  const edition = target.edition + 1;
  const retiring = change.op === "retire";
  const seq = writeLine(tx, target.id, {
    actor,
    action: retiring ? "retire" : "change-rule",
    fromStatus: target.status,
    toStatus: retiring ? "superseded" : target.status,
    fromEdition: target.edition,
    toEdition: edition,
    at,
  });
  if (change.op === "retire") {
    tx.run("UPDATE ontology_elements SET status = 'superseded', edition = ? WHERE id = ?", [
      edition,
      target.id,
    ]);
  } else {
    tx.run("UPDATE ontology_elements SET rule = ?, edition = ? WHERE id = ?", [
      JSON.stringify(canonicalRule(change.rule)),
      edition,
      target.id,
    ]);
  }
  return { status: "applied", id: target.id, edition, seq };
}

export type OntologyAction = "approve" | "reject" | "dispute";

/**
 * The user's way into the type definitions (S01-R5, R7, R20): a change, an approval or rejection of a
 * candidate, and the undo of the user's newest step. Handed to the API layer inside `userDecisions`
 * (semantic-user.ts), never exported by itself, so extraction and the job runner cannot reach it.
 * The transaction is the caller's.
 */
export interface UserOntologyDecisions {
  /** The user's add, rule change or retirement: checked (R19), applied, `verified`. */
  change(tx: SqlDriver, change: OntologyChange, at?: string): UserChangeOutcome;
  /**
   * Approve or reject a `candidate`. Those two are the user's only transitions of an element besides a
   * retirement; every other pair, and every dispute (elements have no `disputed`), is `invalid-transition`.
   */
  decide(tx: SqlDriver, id: number, action: OntologyAction, at?: string): OntologyActionOutcome;
  /**
   * Cancels the element's newest line when it is the user's: an approval returns to `candidate` (the
   * element is removed when no lineage row is left), a rejection returns to `candidate`, a retirement
   * returns to `verified` with the edition one higher (an edition never goes down), the user's add
   * removes the element. An approval or an add of an element in use is refused with counts only
   * (`existing-data-violation`). A rule change is not undone (`invalid-transition`).
   */
  undo(tx: SqlDriver, id: number, at?: string): OntologyActionOutcome;
}

const refusedWith = (
  reason: OntologyRefusal,
  detail: {
    schemaErrors?: readonly string[];
    impact?: { liveRows: number; violations: number };
  } = {},
): Extract<OntologyActionOutcome, { status: "refused" }> => ({
  status: "refused",
  reason,
  duplicates: 0,
  schemaErrors: detail.schemaErrors ?? [],
  impact: detail.impact ?? { liveRows: 0, violations: 0 },
});

/** The lines a user action writes: an undo reverts one of these. */
const USER_LINES: ReadonlySet<string> = new Set([
  "created",
  "approve",
  "reject",
  "retire",
  "change-rule",
]);

/**
 * What uses the element (R20): live rows of its name and, for an item type, the verified and the
 * candidate rules that name it (a candidate rule would name a type that is no longer in force).
 */
function inUse(db: SqlDriver, element: StoredElement): { liveRows: number; violations: number } {
  const liveRows = liveRowCount(db, element.elementKind, element.name);
  const naming =
    element.elementKind === "item-type"
      ? rulesNaming(db, element.name, "verified") + rulesNaming(db, element.name, "candidate")
      : 0;
  return { liveRows, violations: liveRows + naming };
}

/** One line, then the row: only the columns that change are set (the identity trigger fires on any SET of name or kind). */
function step(
  tx: SqlDriver,
  element: StoredElement,
  action: string,
  to: KnowledgeStatus,
  edition: number,
  revertsSeq: number | undefined,
  at: string | undefined,
): number {
  const seq = writeLine(tx, element.id, {
    actor: "user",
    action,
    fromStatus: element.status,
    toStatus: to,
    fromEdition: element.edition,
    toEdition: edition,
    ...(revertsSeq === undefined ? {} : { revertsSeq }),
    at,
  });
  if (edition === element.edition) {
    tx.run("UPDATE ontology_elements SET status = ? WHERE id = ?", [to, element.id]);
  } else {
    tx.run("UPDATE ontology_elements SET status = ?, edition = ? WHERE id = ?", [
      to,
      edition,
      element.id,
    ]);
  }
  return seq;
}

export const userOntology: UserOntologyDecisions = {
  change: (tx, change, at) => applyUserOntologyChange(tx, change, at),

  decide(tx, id, action, at) {
    const element = readOntologyElementById(tx, id);
    if (!element) return refusedWith("not-found");
    // an element is never `disputed`: no dispute, whatever its status
    if (action === "dispute") return refusedWith("invalid-transition");
    const to: KnowledgeStatus = action === "approve" ? "verified" : "rejected";
    if (element.status === to) return { status: "unchanged", id };
    if (element.status !== "candidate") return refusedWith("invalid-transition");
    if (action === "approve") {
      // the candidate is judged again as an addition: the types its rule names and the rows it would govern may have changed
      const addition: OntologyChange = { op: "add", name: element.name, rule: element.rule };
      const schemaErrors = shapeErrors(tx, addition, undefined);
      if (schemaErrors.length > 0) return refusedWith("schema-invalid", { schemaErrors });
      const impact = impactOf(tx, addition, undefined);
      if (impact.violations > 0) return refusedWith("existing-data-violation", { impact });
    }
    const seq = step(tx, element, action, to, element.edition, undefined, at);
    return { status: "applied", id, edition: element.edition, seq };
  },

  undo(tx, id, at) {
    const element = readOntologyElementById(tx, id);
    if (!element) return refusedWith("not-found");
    const newest = readOntologyHistory(tx, id).at(-1);
    if (!newest || newest.action === "undo") return refusedWith("nothing-to-undo");
    if (newest.actor !== "user" || !USER_LINES.has(newest.action)) return refusedWith("not-latest");
    if (newest.action === "change-rule") return refusedWith("invalid-transition");
    if (newest.action === "created" || newest.action === "approve") {
      const impact = inUse(tx, element);
      if (impact.violations > 0) return refusedWith("existing-data-violation", { impact });
      if (
        newest.action === "created" ||
        count(tx, "SELECT count(*) AS n FROM ontology_basis WHERE element_id = ?", [id]) === 0
      ) {
        // no lineage is left to return to: a candidate without lineage must not remain (R20)
        tx.run("DELETE FROM ontology_elements WHERE id = ?", [id]);
        return { status: "removed", id };
      }
    }
    if (newest.action === "retire") {
      // the element comes back in force: its rule is judged again as for an addition (an item type it names
      // may have been retired or removed while it was retired, and a retired rule is not counted by `inUse`)
      const schemaErrors = shapeErrors(
        tx,
        { op: "add", name: element.name, rule: element.rule },
        undefined,
        true,
      );
      if (schemaErrors.length > 0) return refusedWith("schema-invalid", { schemaErrors });
      // and against the rows that exist: a user's row of the kind may have been added while it was retired
      const impact = impactOf(tx, { op: "add", name: element.name, rule: element.rule }, undefined);
      if (impact.violations > 0) return refusedWith("existing-data-violation", { impact });
    }
    // a retirement comes back as a new edition: the number only rises
    const edition = newest.action === "retire" ? element.edition + 1 : element.edition;
    const seq = step(
      tx,
      element,
      "undo",
      newest.fromStatus as KnowledgeStatus,
      edition,
      newest.seq,
      at,
    );
    return { status: "applied", id, edition, seq };
  },
};
