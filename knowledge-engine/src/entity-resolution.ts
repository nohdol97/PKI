// Entity resolution's deterministic half (S02-R8, R9, R10): the eight signals between two items (read
// over their merge groups, valid rows only, no LLM), the merge candidates built from them and kept in
// `merge_candidates`, and the check an extraction's link to an existing item passes before it is
// written. A candidate is a suggestion only: the user's merge is the one thing that joins items (R11).
import {
  entityGroups,
  keyedTextHash,
  lineageOfItems,
  listVerifiedForms,
  normalizeForLinking,
  rowLineage,
  withGroups,
  type KnowledgeStatus,
  type MembershipListener,
  type MembershipScope,
  type SqlDriver,
} from "@pki/storage";
import { isValidRow } from "./dependency-delay.ts";

/** The closed list of signal codes (S02-R9), as stored in a candidate's `signals`. */
export const SIGNALS = [
  "same-type",
  "name-match",
  "identifier-match",
  "identifier-mismatch",
  "organization-match",
  "organization-mismatch",
  "project-match",
  "shared-neighbor",
] as const;
export type Signal = (typeof SIGNALS)[number];

const BELONGS_TO = "BELONGS_TO";
const IDENTIFIER_KEY = "identifier.key";
const IDENTIFIER = (kind: string) => kind.startsWith("identifier.");
const SUPPORT: readonly Signal[] = ["organization-match", "project-match", "shared-neighbor"];

/** A valid-time interval; a missing end is unbounded, both ends missing is "not known". */
export interface Interval {
  from: string | null;
  to: string | null;
}

/**
 * Whether two known intervals overlap (S02-R9, the time that decides `organization-mismatch`). An interval
 * with neither end is not known and overlaps nothing. The interval is half-open, `[from, to)`: one that ends the
 * day the other starts shares no day with it (S02-R17).
 */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  const known = (i: Interval) => i.from !== null || i.to !== null;
  if (!known(a) || !known(b)) return false;
  const before = (end: string | null, start: string | null) =>
    end !== null && start !== null && end <= start;
  return !before(a.to, b.from) && !before(b.to, a.from);
}

const ordered = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);

/** What a group of items says about itself, the other ends of its relations read as their representatives. */
interface Profile {
  members: number[];
  type: string;
  names: Set<string>;
  /** `verified` surface forms whose evidence lies inside their item's (S01-T09, decision 29 D6). */
  forms: Set<string>;
  /** `kind \0 tag` to the processed values under it. */
  identifiers: Map<string, Set<string>>;
  /** The other end (a representative) of each valid relation, whether one of them is `BELONGS_TO` from here. */
  links: Map<number, { belongs: boolean }>;
  /** The valid interval of each `BELONGS_TO` from the group, per organization (S02-R9, R17). */
  belongings: Map<number, Interval[]>;
}

const typeOf = (db: SqlDriver, item: number): string =>
  db.all("SELECT type FROM items WHERE id = ?", [item])[0]?.type as string;

const slot = (kind: string, tag: string | null) => `${kind}\0${tag ?? ""}`;

function profileOf(db: SqlDriver, item: number): Profile {
  const members = [...entityGroups.membersOf(db, item)];
  const list = JSON.stringify(members);
  const IN = "IN (SELECT value FROM json_each(?))";
  const profile: Profile = {
    members,
    type: typeOf(db, entityGroups.representativeOf(db, item)),
    names: new Set(),
    forms: new Set(),
    identifiers: new Map(),
    links: new Map(),
    belongings: new Map(),
  };
  for (const r of db.all(`SELECT name FROM items WHERE id ${IN}`, [list])) {
    profile.names.add(normalizeForLinking(r.name as string));
  }
  for (const r of db.all(
    `SELECT id, item_id, kind, value, context, status FROM facts
     WHERE item_id ${IN} AND (substr(kind, 1, 11) = 'identifier.' OR (substr(kind, 1, 6) = 'alias.' AND status = 'verified'))`,
    [list],
  )) {
    const id = r.id as number;
    const kind = r.kind as string;
    if (!isValidRow(db, { kind: "fact", id }, r.status as KnowledgeStatus)) continue;
    if (IDENTIFIER(kind)) {
      const key = slot(kind, r.context as string | null);
      const values = profile.identifiers.get(key) ?? new Set<string>();
      values.add(normalizeForLinking(r.value as string));
      profile.identifiers.set(key, values);
    } else if (formInsideItem(db, id, r.item_id as number)) {
      profile.forms.add(normalizeForLinking(r.value as string));
    }
  }
  for (const r of db.all(
    `SELECT id, subject_id, type, object_id, status, valid_at, valid_until FROM relations
     WHERE subject_id ${IN} OR object_id ${IN}`,
    [list, list],
  )) {
    if (!isValidRow(db, { kind: "relation", id: r.id as number }, r.status as KnowledgeStatus)) {
      continue;
    }
    const mine = members.includes(r.subject_id as number);
    const other = entityGroups.representativeOf(db, (mine ? r.object_id : r.subject_id) as number);
    const seen = profile.links.get(other) ?? { belongs: false };
    if (mine && r.type === BELONGS_TO) {
      seen.belongs = true;
      profile.belongings.set(other, [
        ...(profile.belongings.get(other) ?? []),
        { from: r.valid_at as string | null, to: r.valid_until as string | null },
      ]);
    }
    profile.links.set(other, seen);
  }
  return profile;
}

/** D6: a form counts only when the source versions it rests on are among its item's (the rule linking applies). */
function formInsideItem(db: SqlDriver, factId: number, itemId: number): boolean {
  const own = new Set(
    rowLineage(db, { kind: "item", id: itemId }).map((v) => `${v.sourceId}@${v.version}`),
  );
  return rowLineage(db, { kind: "fact", id: factId }).every((v) =>
    own.has(`${v.sourceId}@${v.version}`),
  );
}

const overlap = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>) => [...a].some((x) => b.has(x));

/**
 * The signals between two items, read over their groups (R13), sorted. Different types are not compared:
 * the list is empty. The organization signals read each `BELONGS_TO`'s valid interval (S02-R9): the same
 * organization matches when the intervals overlap or either is unknown; different organizations mismatch only
 * when two known intervals overlap.
 */
export function signalsBetween(db: SqlDriver, a: number, b: number): Signal[] {
  const pa = profileOf(db, a);
  const pb = profileOf(db, b);
  if (pa.type !== pb.type) return [];
  const found = new Set<Signal>(["same-type"]);
  if (overlap(pa.names, pb.names) || overlap(pa.names, pb.forms) || overlap(pa.forms, pb.names)) {
    found.add("name-match");
  }
  for (const [key, values] of pa.identifiers) {
    const theirs = pb.identifiers.get(key);
    if (!theirs) continue;
    if (overlap(values, theirs)) found.add("identifier-match");
    else if (key.startsWith(`${IDENTIFIER_KEY}\0`)) found.add("identifier-mismatch");
  }
  const reps = new Set([...pa.members, ...pb.members]);
  for (const [other, mine] of pa.links) {
    const theirs = pb.links.get(other);
    if (!theirs || reps.has(other)) continue;
    if (typeOf(db, other) === "Project") found.add("project-match");
    else if (mine.belongs && theirs.belongs && belongedTogether(pa, pb, other)) {
      found.add("organization-match");
    } else found.add("shared-neighbor");
  }
  if (mismatchedOrganizations(pa, pb)) found.add("organization-mismatch");
  return SIGNALS.filter((s) => found.has(s));
}

const known = (i: Interval) => i.from !== null || i.to !== null;

/** Both groups belong to the organization at overlapping times, or at least one of the two intervals is unknown. */
const belongedTogether = (a: Profile, b: Profile, org: number): boolean =>
  (a.belongings.get(org) ?? []).some((x) =>
    (b.belongings.get(org) ?? []).some((y) => !known(x) || !known(y) || intervalsOverlap(x, y)),
  );

/** The two groups belong to different organizations at the same time (both intervals known). */
const mismatchedOrganizations = (a: Profile, b: Profile): boolean =>
  [...a.belongings].some(([orgA, xs]) =>
    [...b.belongings].some(
      ([orgB, ys]) => orgA !== orgB && xs.some((x) => ys.some((y) => intervalsOverlap(x, y))),
    ),
  );

/** R10 conditions 1–3: same type, no negative signal, and an identifier or a name with support. */
function qualifies(signals: readonly Signal[]): boolean {
  const has = (s: Signal) => signals.includes(s);
  if (!has("same-type") || has("identifier-mismatch") || has("organization-mismatch")) return false;
  return has("identifier-match") || (has("name-match") && SUPPORT.some(has));
}

/** What the partner search matches on: processed names and forms, and identifier values. */
function searchKeys(db: SqlDriver): {
  byKey: Map<string, Set<number>>;
  keysOf: Map<number, string[]>;
} {
  const byKey = new Map<string, Set<number>>();
  const keysOf = new Map<number, string[]>();
  const add = (item: number, key: string) => {
    (byKey.get(key) ?? byKey.set(key, new Set()).get(key))?.add(item);
    (keysOf.get(item) ?? keysOf.set(item, []).get(item))?.push(key);
  };
  for (const r of db.all("SELECT id, name FROM items")) {
    add(r.id as number, `n\0${normalizeForLinking(r.name as string)}`);
  }
  for (const { factId, itemId, form } of listVerifiedForms(db)) {
    if (formInsideItem(db, factId, itemId)) add(itemId, `n\0${normalizeForLinking(form)}`);
  }
  for (const r of db.all(
    "SELECT id, item_id, kind, value, context, status FROM facts WHERE substr(kind, 1, 11) = 'identifier.'",
  )) {
    if (!isValidRow(db, { kind: "fact", id: r.id as number }, r.status as KnowledgeStatus))
      continue;
    add(
      r.item_id as number,
      `i\0${slot(r.kind as string, r.context as string | null)}\0${normalizeForLinking(r.value as string)}`,
    );
  }
  return { byKey, keysOf };
}

const markedDistinct = (db: SqlDriver, left: readonly number[], right: readonly number[]) =>
  db.all(
    `SELECT 1 FROM item_distinct
     WHERE (item_a IN (SELECT value FROM json_each(?)) AND item_b IN (SELECT value FROM json_each(?)))
        OR (item_a IN (SELECT value FROM json_each(?)) AND item_b IN (SELECT value FROM json_each(?)))
     LIMIT 1`,
    [JSON.stringify(left), JSON.stringify(right), JSON.stringify(right), JSON.stringify(left)],
  ).length > 0;

const DROP_DOMAIN = "scope-policy-drop";

/**
 * Records, content-free, that the policy would not put two lineages together for a candidate, as the commit
 * does for an item it refuses (kind `merge-candidate`, the keyed hash of the pair): a widening extracts the
 * version again (I04-R15).
 */
export function recordRefusedCandidate(
  tx: SqlDriver,
  source: { sourceId: number; version: number },
  a: number,
  b: number,
  at: string,
): void {
  tx.run(
    `INSERT INTO scope_policy_drops (source_id, version, kind, item_key_hash, reason, at)
     VALUES (?, ?, 'merge-candidate', ?, 'scope-policy', ?) ON CONFLICT DO NOTHING`,
    [source.sourceId, source.version, keyedTextHash(tx, DROP_DOMAIN, `candidate:${a}:${b}`), at],
  );
}

/**
 * Recomputes the candidates of the groups the touched items belong to (S02-R10): every pair of groups that
 * shares a name, a verified form or an identifier value with a touched group is judged, a pair that meets
 * R10's four conditions and whose lineages the policy lets be put together is kept, and every stored row
 * touching those groups that is not wanted is deleted. A row names the two representatives, the smaller
 * id first. A pair the policy refuses is reported to `onRefused`; items in `exclude` (about to be deleted)
 * are neither compared nor kept.
 */
export function refreshCandidates(
  tx: SqlDriver,
  touched: readonly number[],
  scope: Pick<MembershipScope, "combinable">,
  options: { onRefused?: (a: number, b: number) => void; exclude?: ReadonlySet<number> } = {},
): { created: number; removed: number; updated: number } {
  const { onRefused, exclude = new Set<number>() } = options;
  const stored = touched.filter(
    (id) => !exclude.has(id) && tx.all("SELECT 1 FROM items WHERE id = ?", [id]).length > 0,
  );
  const reps = [...new Set(stored.map((id) => entityGroups.representativeOf(tx, id)))].sort(
    (a, b) => a - b,
  );
  const wanted = new Map<string, { a: number; b: number; signals: Signal[] }>();
  const judged = new Set<string>();
  const { byKey, keysOf } = searchKeys(tx);
  for (const rep of reps) {
    const partners = new Set<number>();
    for (const member of entityGroups.membersOf(tx, rep)) {
      for (const key of keysOf.get(member) ?? []) {
        for (const other of byKey.get(key) ?? []) {
          if (!exclude.has(other)) partners.add(entityGroups.representativeOf(tx, other));
        }
      }
    }
    partners.delete(rep);
    for (const other of [...partners].sort((x, y) => x - y)) {
      const [a, b] = ordered(rep, other);
      const id = `${a}:${b}`;
      if (judged.has(id)) continue;
      judged.add(id);
      const signals = signalsBetween(tx, a, b);
      const left = entityGroups.membersOf(tx, a);
      const right = entityGroups.membersOf(tx, b);
      if (!qualifies(signals) || markedDistinct(tx, left, right)) continue;
      if (!scope.combinable(lineageOfItems(tx, [...left, ...right]))) {
        onRefused?.(a, b);
        continue;
      }
      wanted.set(id, { a, b, signals });
    }
  }
  let created = 0;
  let removed = 0;
  let updated = 0;
  const reach = JSON.stringify(withGroups(tx, stored));
  const IN = "IN (SELECT value FROM json_each(?))";
  for (const r of tx.all(
    `SELECT item_a, item_b, signals FROM merge_candidates WHERE item_a ${IN} OR item_b ${IN}`,
    [reach, reach],
  )) {
    const id = `${r.item_a}:${r.item_b}`;
    const want = wanted.get(id);
    if (!want) {
      tx.run("DELETE FROM merge_candidates WHERE item_a = ? AND item_b = ?", [
        r.item_a as number,
        r.item_b as number,
      ]);
      removed++;
    } else {
      wanted.delete(id);
      if (r.signals !== JSON.stringify(want.signals)) {
        tx.run("UPDATE merge_candidates SET signals = ? WHERE item_a = ? AND item_b = ?", [
          JSON.stringify(want.signals),
          want.a,
          want.b,
        ]);
        updated++;
      }
    }
  }
  for (const { a, b, signals } of wanted.values()) {
    tx.run(
      "INSERT INTO merge_candidates (item_a, item_b, signals, at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      [a, b, JSON.stringify(signals)],
    );
    created++;
  }
  return { created, removed, updated };
}

/**
 * S02-R8 2: whether an answer's `identifier.key` values for an existing item contradict its group's. The
 * link is refused when, under one tag, the group (the representative's members too) has a valid key and the
 * answer's values under that tag equal none of them (decision 29 D10). `keys` are the answer's values by tag.
 */
export function linkRefused(
  db: SqlDriver,
  item: number,
  keys: readonly { tag: string | null; value: string }[],
): boolean {
  if (keys.length === 0) return false;
  const stored = profileOf(db, item).identifiers;
  const wanted = new Map<string, Set<string>>();
  for (const { tag, value } of keys) {
    const key = slot(IDENTIFIER_KEY, tag);
    (wanted.get(key) ?? wanted.set(key, new Set()).get(key))?.add(normalizeForLinking(value));
  }
  return [...wanted].some(([key, values]) => {
    const have = stored.get(key);
    return have !== undefined && have.size > 0 && !overlap(values, have);
  });
}

/** Leaves the mark of a refused link (S02-R16, `by = 'link-check'`) between X and the new item; a user's mark stays. */
export function markLinkRefused(tx: SqlDriver, a: number, b: number): void {
  const [low, high] = ordered(a, b);
  tx.run(
    `INSERT OR IGNORE INTO item_distinct (item_a, item_b, by, at)
     VALUES (?, ?, 'link-check', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    [low, high],
  );
  tx.run("DELETE FROM merge_candidates WHERE item_a = ? AND item_b = ?", [low, high]);
}

/** `links_refused` (decision 29 D1): the marks the link check stands behind now. */
export const countLinksRefused = (db: SqlDriver): number =>
  db.all("SELECT count(*) AS n FROM item_distinct WHERE by = 'link-check'")[0]?.n as number;

/** The stored candidates, ascending, at most `limit`: two ids and the signal codes (no text). */
export function listMergeCandidates(
  db: SqlDriver,
  limit: number,
): { a: number; b: number; signals: Signal[] }[] {
  return db
    .all("SELECT item_a, item_b, signals FROM merge_candidates ORDER BY item_a, item_b LIMIT ?", [
      limit,
    ])
    .map((r) => ({
      a: r.item_a as number,
      b: r.item_b as number,
      signals: JSON.parse(r.signals as string) as Signal[],
    }));
}

/**
 * The receiver of a changed membership (S02-R13): a merge, an unmerge, a rest or a split changes which
 * groups exist, so the candidates of the groups it reached are recomputed. It only recomputes; the merge
 * and the distinct mark already deleted their own rows.
 */
export const candidatesReceiver: MembershipListener = (tx, change, scope) => {
  const { created, removed, updated } = refreshCandidates(tx, change.items, scope);
  scope.recomputed?.("merge-candidate", created + removed + updated);
};
