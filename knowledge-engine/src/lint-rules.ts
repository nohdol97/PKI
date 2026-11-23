// The four lint rules (K02-R6): pure functions of the DB, a set of merge groups and the time. They read the
// knowledge tables through the helpers extraction and the Insight rules use (merge groups, `validRow`, row
// lineage) and nothing the product wrote about them (R10: no `wiki_*`, `insights*` or `lint_*`). They call no
// Provider. A finding is a candidate: the rule name, the ids of the rows it bears on and their lineage.
import {
  entityGroups,
  INVALID,
  lineageOfItems,
  normalizeForLinking,
  rowLineage,
  unionOfVersions,
  validRow,
  type FindingTarget,
  type KnowledgeStatus,
  type LintRule,
  type SourceVersionRef,
  type SqlDriver,
} from "@pki/storage";
import { COMPLETION_DATE, isValidRow, TARGET_DATE, validDates } from "./dependency-delay.ts";

export interface LintFinding {
  rule: LintRule;
  target: FindingTarget;
  lineage: SourceVersionRef[];
}

/** Provisional (K02-R6, D5): the pairs one group offers, and the sources two groups must share. */
export const MISSING_LINK_PAIRS_PER_GROUP = 5;
export const MISSING_LINK_MIN_SHARED_SOURCES = 2;
const WORK_TYPES = ["Task", "Commitment"];

const IN = "IN (SELECT value FROM json_each(?))";
const ordered = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);
const typeOf = (db: SqlDriver, item: number) =>
  db.all("SELECT type FROM items WHERE id = ?", [item])[0]?.type as string | undefined;
const sourcesOf = (lineage: readonly SourceVersionRef[]) => new Set(lineage.map((v) => v.sourceId));

/** Two groups, the same type, a name or an alias (not rejected) of one equal to one of the other's. */
function synonyms(db: SqlDriver, reps: readonly number[]): LintFinding[] {
  const groupsOfKey = new Map<string, Set<number>>();
  const keysOfGroup = new Map<number, Set<string>>();
  const add = (item: number, text: string) => {
    const group = entityGroups.representativeOf(db, item);
    const key = normalizeForLinking(text);
    (groupsOfKey.get(key) ?? groupsOfKey.set(key, new Set()).get(key))?.add(group);
    (keysOfGroup.get(group) ?? keysOfGroup.set(group, new Set()).get(group))?.add(key);
  };
  for (const r of db.all("SELECT id, name FROM items")) add(r.id as number, r.name as string);
  for (const r of db.all(
    "SELECT item_id, value FROM facts WHERE substr(kind, 1, 6) = 'alias.' AND status <> 'rejected'",
  )) {
    add(r.item_id as number, r.value as string);
  }
  const candidate = (a: number, b: number) =>
    db.all("SELECT 1 FROM merge_candidates WHERE item_a = ? AND item_b = ?", [a, b]).length > 0;
  const distinct = (a: number, b: number) => {
    const left = JSON.stringify(entityGroups.membersOf(db, a));
    const right = JSON.stringify(entityGroups.membersOf(db, b));
    return (
      db.all(
        `SELECT 1 FROM item_distinct WHERE (item_a ${IN} AND item_b ${IN}) OR (item_a ${IN} AND item_b ${IN}) LIMIT 1`,
        [left, right, right, left],
      ).length > 0
    );
  };
  const seen = new Set<string>();
  const found: LintFinding[] = [];
  for (const rep of reps) {
    for (const key of keysOfGroup.get(rep) ?? []) {
      for (const other of groupsOfKey.get(key) ?? []) {
        if (other === rep) continue;
        const [a, b] = ordered(rep, other);
        if (seen.has(`${a}:${b}`)) continue;
        seen.add(`${a}:${b}`);
        if (typeOf(db, a) !== typeOf(db, b) || candidate(a, b) || distinct(a, b)) continue;
        found.push({
          rule: "synonym",
          target: { kind: "item", a, b },
          lineage: unionOfVersions(entityGroups.lineageOf(db, a), entityGroups.lineageOf(db, b)),
        });
      }
    }
  }
  return found;
}

/** A fact or relation that is neither superseded nor rejected yet is not valid: no current evidence, no user input. */
function stale(db: SqlDriver, reps: readonly number[]): LintFinding[] {
  const found: LintFinding[] = [];
  const seen = new Set<string>();
  const check = (kind: "fact" | "relation", id: number, status: KnowledgeStatus) => {
    if (seen.has(`${kind}:${id}`)) return;
    seen.add(`${kind}:${id}`);
    if (INVALID.has(status) || validRow(db, { kind, id }) !== undefined) return;
    found.push({
      rule: "stale",
      target: { kind, a: id, b: null },
      lineage: rowLineage(db, { kind, id }),
    });
  };
  for (const rep of reps) {
    const members = JSON.stringify(entityGroups.membersOf(db, rep));
    for (const r of db.all(`SELECT id, status FROM facts WHERE item_id ${IN} ORDER BY id`, [
      members,
    ])) {
      check("fact", r.id as number, r.status as KnowledgeStatus);
    }
    for (const r of db.all(
      `SELECT id, status FROM relations WHERE subject_id ${IN} OR object_id ${IN} ORDER BY id`,
      [members, members],
    )) {
      check("relation", r.id as number, r.status as KnowledgeStatus);
    }
  }
  return found;
}

/** A Task or Commitment group with a valid target date before `now` and no valid completion date. */
function overdueWork(db: SqlDriver, reps: readonly number[], now: string): LintFinding[] {
  const today = now.slice(0, 10);
  return reps.flatMap((rep) => {
    if (!WORK_TYPES.includes(typeOf(db, rep) ?? "")) return [];
    const members = entityGroups.membersOf(db, rep);
    const late = validDates(db, members, TARGET_DATE).rows.some((d) => d.value < today);
    if (!late || validDates(db, members, COMPLETION_DATE).rows.length > 0) return [];
    return [
      {
        rule: "overdue-work" as const,
        target: { kind: "item" as const, a: rep, b: null },
        lineage: lineageOfItems(db, members),
      },
    ];
  });
}

const relatedGroups = (db: SqlDriver, a: readonly number[], b: readonly number[]): boolean => {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  return db
    .all(
      `SELECT id, status FROM relations
        WHERE (subject_id ${IN} AND object_id ${IN}) OR (subject_id ${IN} AND object_id ${IN})`,
      [left, right, right, left],
    )
    .some((r) =>
      isValidRow(db, { kind: "relation", id: r.id as number }, r.status as KnowledgeStatus),
    );
};

/**
 * Two groups whose lineages share two or more sources and have no valid relation either way. Each group
 * offers at most MISSING_LINK_PAIRS_PER_GROUP partners, the ones it shares the most sources with.
 */
function missingLinks(db: SqlDriver, reps: readonly number[]): LintFinding[] {
  const lineages = new Map<number, SourceVersionRef[]>();
  const lineageOfGroup = (rep: number) =>
    lineages.get(rep) ?? lineages.set(rep, [...entityGroups.lineageOf(db, rep)]).get(rep) ?? [];
  const seen = new Set<string>();
  const found: LintFinding[] = [];
  for (const rep of reps) {
    const mine = sourcesOf(lineageOfGroup(rep));
    if (mine.size < MISSING_LINK_MIN_SHARED_SOURCES) continue;
    const sources = JSON.stringify([...mine]);
    const partners = new Set<number>();
    for (const r of db.all(
      `SELECT f.item_id AS item FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
         JOIN facts f ON f.id = e.fact_id WHERE v.source_id ${IN}
       UNION SELECT rel.subject_id FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
         JOIN relations rel ON rel.id = e.relation_id WHERE v.source_id ${IN}
       UNION SELECT rel.object_id FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
         JOIN relations rel ON rel.id = e.relation_id WHERE v.source_id ${IN}`,
      [sources, sources, sources],
    )) {
      partners.add(entityGroups.representativeOf(db, r.item as number));
    }
    partners.delete(rep);
    const scored = [...partners]
      .map((other) => ({
        other,
        shared: [...sourcesOf(lineageOfGroup(other))].filter((s) => mine.has(s)),
      }))
      .filter(
        (p) =>
          p.shared.length >= MISSING_LINK_MIN_SHARED_SOURCES &&
          !relatedGroups(db, entityGroups.membersOf(db, rep), entityGroups.membersOf(db, p.other)),
      )
      .sort((x, y) => y.shared.length - x.shared.length || x.other - y.other)
      .slice(0, MISSING_LINK_PAIRS_PER_GROUP);
    for (const { other, shared } of scored) {
      const [a, b] = ordered(rep, other);
      if (seen.has(`${a}:${b}`)) continue;
      seen.add(`${a}:${b}`);
      found.push({
        rule: "missing-link",
        target: { kind: "item", a, b },
        // the versions the two groups came together in: those of the sources they share
        lineage: unionOfVersions(lineageOfGroup(a), lineageOfGroup(b)).filter((v) =>
          shared.includes(v.sourceId),
        ),
      });
    }
  }
  return found;
}

/** The items the target rows of a finding sit on; undefined while a target row is gone (the finding is in every range). */
export function itemsOfFinding(db: SqlDriver, t: FindingTarget): number[] | undefined {
  const ends =
    t.kind === "item"
      ? [t.a, ...(t.b === null ? [] : [t.b])]
      : db
          .all(
            t.kind === "fact"
              ? "SELECT item_id AS a, NULL AS b FROM facts WHERE id = ?"
              : "SELECT subject_id AS a, object_id AS b FROM relations WHERE id = ?",
            [t.a],
          )
          .flatMap((r) => [r.a as number, ...(r.b === null ? [] : [r.b as number])]);
  if (ends.length === 0) return undefined;
  const stored = db.all("SELECT id FROM items WHERE id IN (SELECT value FROM json_each(?))", [
    JSON.stringify(ends),
  ]).length;
  return stored === new Set(ends).size ? ends : undefined;
}

/** Every rule over the groups `reps` (representatives, ascending), each finding once. */
export const lintFindings = (
  db: SqlDriver,
  reps: readonly number[],
  now: string,
): LintFinding[] => [
  ...synonyms(db, reps),
  ...stale(db, reps),
  ...overdueWork(db, reps, now),
  ...missingLinks(db, reps),
];
