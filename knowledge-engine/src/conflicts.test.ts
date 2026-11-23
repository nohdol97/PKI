// S02-T08 `conflict.rule`, `conflict.scope`, `conflict.auto-dispute` (S02-R19, R20, C3): the pairwise judgement of facts
// whose values differ in a `one` slot, ordered by valid interval only, the scope guard on the link's write, and the
// policy's dispute on a new CONTRADICTS. All data is synthetic.
import {
  addEvidence,
  automatedLifecycle,
  insertItem,
  listAssertionLinks,
  migrate,
  readFact,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  userDecisions,
  writeSetting,
  type KnowledgeAttributes,
  type KnowledgeStatus,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTO_DISPUTE_SETTING, refreshConflicts } from "./conflicts.ts";

const T = "2026-11-23T00:00:00.000Z";
let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const attrs = (over: Partial<KnowledgeAttributes> = {}): KnowledgeAttributes => ({
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
  ...over,
});
const item = () => {
  const id = insertItem(db, { type: "Project", name: `p${Math.random()}`, ...attrs() });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  return id;
};

let counter = 0;
interface Own {
  value: string;
  from?: string | null;
  until?: string | null;
  observedAt?: string;
  status?: KnowledgeStatus;
  source?: string;
}
/** A target_date fact with its own source's version as current evidence. */
function fact(itemId: number, { value, from, until, observedAt, status, source }: Own) {
  const saved = saveFact(db, {
    itemId,
    kind: "target_date",
    value,
    validUntil: until ?? null,
    ...attrs({
      validAt: from ?? null,
      ...(observedAt ? { observedAt } : {}),
      ...(status ? { status } : {}),
    }),
  });
  automatedLifecycle.created(db, { kind: "fact", id: saved.id }, "extraction", null);
  counter++;
  const externalId = source ?? `s-${counter}`;
  saveSourceRecord(db, "c1", { externalId, title: externalId, body: "body text" });
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  addEvidence(db, {
    target: { factId: saved.id },
    sourceVersionId: versionId,
    start: 0,
    end: 4,
    quote: "body",
  });
  return saved.id;
}
const allow = { combinable: () => true };
const refresh = (items: number[], scope = allow) =>
  db.transaction(() => refreshConflicts(db, items, scope, { at: T }));
const links = () =>
  listAssertionLinks(db).map((l) => [l.type, l.fromFactId, l.toFactId, l.createdBy] as const);
const lines = (id: number) =>
  db.all(
    "SELECT actor, action, reason, basis_source_id, basis_version FROM fact_history WHERE fact_id = ? ORDER BY seq",
    [id],
  );

describe("conflict.rule (S02-R19)", () => {
  it("two values whose intervals do not overlap are SUPERSEDES, the later interval superseding — also when it was observed earlier", () => {
    const owner = item();
    // A is valid first but was observed last: ordering by observed time would reverse the link
    const a = fact(owner, {
      value: "2026-12-01",
      from: "2026-01-01",
      until: "2026-06-01",
      observedAt: "2026-11-30T00:00:00Z",
    });
    const b = fact(owner, {
      value: "2026-12-02",
      from: "2026-06-01",
      until: "2026-12-31",
      observedAt: "2026-02-01T00:00:00Z",
    });
    expect(refresh([owner])).toMatchObject({ created: 1, removed: 0 });
    expect(links()).toEqual([["SUPERSEDES", b, a, "rule"]]);
    // an open end: the one that starts later supersedes it (B over C); C overlaps A, so that pair stays a contradiction
    const c = fact(owner, { value: "2026-12-03", from: "2026-03-01" });
    refresh([owner]);
    expect(links()).toContainEqual(["SUPERSEDES", b, c, "rule"]);
    expect(links()).toContainEqual(["CONTRADICTS", a, c, "rule"]);
  });

  it("overlapping or unknown intervals are CONTRADICTS (smaller id first); rejecting one side removes the link; no row changes", () => {
    const owner = item();
    const a = fact(owner, { value: "2026-12-01", from: "2026-01-01", until: "2026-09-01" });
    const b = fact(owner, { value: "2026-12-02", from: "2026-06-01", until: "2026-12-31" });
    const c = fact(owner, { value: "2026-12-03" });
    refresh([owner]);
    expect(links()).toEqual([
      ["CONTRADICTS", a, b, "rule"],
      ["CONTRADICTS", a, c, "rule"],
      ["CONTRADICTS", b, c, "rule"],
    ]);
    const before = [a, b, c].map((id) => readFact(db, id));
    expect(userDecisions.decide(db, { kind: "fact", id: c }, "reject", T)).toMatchObject({
      status: "applied",
    });
    const afterReject = [a, b].map((id) => readFact(db, id));
    expect(afterReject).toEqual(before.slice(0, 2));
    expect(refresh([owner])).toMatchObject({ created: 0, removed: 2 });
    expect(links()).toEqual([["CONTRADICTS", a, b, "rule"]]);
  });
});

describe("conflict.scope (S02-R19, I04-R14)", () => {
  it("two facts whose sources the policy will not put together get no link", () => {
    const owner = item();
    fact(owner, { value: "2026-12-01", source: "secret" });
    fact(owner, { value: "2026-12-02", source: "open" });
    const secretId = db.all("SELECT id FROM sources WHERE external_id = 'secret'")[0]?.id as number;
    const scope = {
      combinable: (lineage: readonly { sourceId: number }[]) =>
        !lineage.some((v) => v.sourceId === secretId) ||
        lineage.every((v) => v.sourceId === secretId),
    };
    expect(refresh([owner], scope)).toMatchObject({ created: 0 });
    expect(links()).toEqual([]);
    expect(refresh([owner])).toMatchObject({ created: 1 });
  });
});

describe("conflict.auto-dispute (S02-R20)", () => {
  it("off, only the link; on, the verified side becomes disputed by policy/contradiction with the other's source version; nothing across two items of a group or on a second run", () => {
    const owner = item();
    const a = fact(owner, { value: "2026-12-01", status: "verified", source: "sa" });
    fact(owner, { value: "2026-12-02", source: "sb" });
    refresh([owner]);
    expect(readFact(db, a)?.status).toBe("verified");
    expect(links()).toHaveLength(1);

    writeSetting(db, AUTO_DISPUTE_SETTING, "on");
    const owner2 = item();
    const c = fact(owner2, { value: "2026-12-01", status: "verified", source: "sc" });
    const d = fact(owner2, { value: "2026-12-02", source: "sd" });
    const sourceOfD = db.all(
      "SELECT s.id AS source_id, v.version FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE s.external_id = 'sd'",
    )[0];
    expect(refresh([owner2])).toMatchObject({ created: 1, disputesRaised: 1 });
    expect(readFact(db, c)).toMatchObject({
      status: "disputed",
      epistemic: "explicit",
      value: "2026-12-01",
    });
    expect(readFact(db, d)?.status).toBe("candidate");
    expect(lines(c).at(-1)).toEqual({
      actor: "policy",
      action: "dispute",
      reason: "contradiction",
      basis_source_id: sourceOfD?.source_id,
      basis_version: sourceOfD?.version,
    });
    const count = lines(c).length;
    expect(refresh([owner2])).toMatchObject({ created: 0, disputesRaised: 0 });
    expect(lines(c)).toHaveLength(count);

    // two items of one merge group: a link, no dispute
    const left = item();
    const right = item();
    const e = fact(left, { value: "2026-12-01", status: "verified", source: "se" });
    fact(right, { value: "2026-12-02", source: "sf" });
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, ?)",
      [right, left, T],
    );
    expect(refresh([left])).toMatchObject({ created: 1, disputesRaised: 0 });
    expect(readFact(db, e)?.status).toBe("verified");
  });
});
