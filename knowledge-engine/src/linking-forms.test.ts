// linking.verified-forms (S01-R16, S01-C3, S01-T09): before extraction, the candidate search also reads an
// item's `verified` surface forms (`alias.*` facts) and only those. The user's rows are made by the real
// user entry (add, approve, reject, dispute, value fix, undo); the policy-verified row is raised by the
// real auto-verify gate (`assessAutoVerify`, S01-T05, #173). The egress half runs the real
// extract handler and Broker: what the Provider is offered is the item's name, graded by the item's lineage.
// All data is synthetic.
import type { BrokerRequest } from "@pki/contracts";
import { createBroker, createUserActionLedger, type EgressInput } from "@pki/providers";
import {
  addEvidence,
  automatedLifecycle,
  closeJob,
  createCommitScope,
  defaultScopePolicy,
  insertItem,
  leaseNextJob,
  migrate,
  registerConnectorInstance,
  registerJob,
  saveFact,
  saveSourceRecord,
  userDecisions,
  writeSetting,
  type KnowledgeAttributes,
  type ScopePolicy,
  type ScopePurpose,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, setStatusForTest } from "@pki/testkit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessAutoVerify, AUTO_VERIFY_SETTING } from "./auto-verify.ts";
import { createProductRegistry } from "./canonical-kinds.ts";
import { createExtractHandler } from "./extraction.ts";
import { findCandidates, knowledgeCandidates } from "./linking.ts";
import { purgeSource } from "./purge.test-support.ts";

const T0 = new Date("2026-11-23T00:00:00.000Z");
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-23T00:00:00Z",
};

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "imported", "jsonl-import");
  registerConnectorInstance(db, "fixtures", "test-fixtures");
});
afterEach(() => db.close());

const open_ = createProductRegistry({ policy: defaultScopePolicy });
/** The search as extraction runs it: with the registry (a search without one reads no forms, W3). */
const find = (text: string) => findCandidates(db, text, open_);
const item = (name: string) => insertItem(db, { type: "Concept", name, ...attrs });
const alias = (itemId: number, value: string, kind = "alias.abbreviation") =>
  saveFact(db, { itemId, kind, value, ...attrs }).id;
const ref = (id: number) => ({ kind: "fact" as const, id });

describe("linking.verified-forms: which forms the search reads", () => {
  it("finds an item through a form the user approved, one the user added, and one the policy verified", () => {
    const a = item("멀티테넌시");
    const b = item("지연 평가");
    const c = item("빌드 캐시");
    userDecisions.decide(db, ref(alias(a, "MT")), "approve");
    const added = userDecisions.add(db, {
      kind: "fact",
      itemId: b,
      factKind: "alias.synonym",
      value: "lazy eval",
    });
    expect(added.status).toBe("applied");
    // the policy's row: a candidate form with current evidence in two sources of different content
    const f = alias(c, "BC");
    automatedLifecycle.created(db, ref(f), "extraction", null);
    for (const [externalId, body] of [
      ["p", "BC 는 빌드 캐시의 약어, 첫 번째 글"],
      ["q", "BC 라고 줄여 부른다, 두 번째 글"],
    ] as const) {
      const saved = saveSourceRecord(db, "imported", { externalId, title: "용어", body });
      if (saved.status !== "created") throw new Error(saved.status);
      const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
      addEvidence(db, {
        target: { factId: f },
        sourceVersionId: versionId,
        start: body.indexOf("BC"),
        end: body.indexOf("BC") + 2,
        quote: "BC",
      });
    }
    expect(find("BC")).toEqual([]); // before the gate runs
    writeSetting(db, AUTO_VERIFY_SETTING, "on");
    expect(assessAutoVerify(db, ref(f)).status).toBe("applied");
    expect(find("mt 와 lazy eval 과 BC")).toEqual([a, b, c]);
  });

  it("finds an item through a verified form of each of the three kinds", () => {
    const a = item("항목 하나");
    const ids = ["alias.synonym", "alias.abbreviation", "alias.translation"].map((kind, i) =>
      alias(a, `표기${i}`, kind),
    );
    for (const id of ids) setStatusForTest(db, "fact", id, "verified");
    for (let i = 0; i < 3; i++) expect(find(`...표기${i}...`)).toEqual([a]);
  });

  it.each(["candidate", "disputed", "rejected", "superseded"] as const)(
    "does not find an item through a form that is %s",
    (status) => {
      const a = item("멀티테넌시");
      setStatusForTest(db, "fact", alias(a, "MT"), status);
      expect(find("MT")).toEqual([]);
    },
  );

  it("sees the user's decisions as they happen: undo, dispute and reject take a form away, approving brings it back", () => {
    const a = item("멀티테넌시");
    const decide = (id: number, action: "approve" | "dispute" | "reject") =>
      expect(userDecisions.decide(db, ref(id), action).status).toBe("applied");
    const f = alias(a, "MT");
    decide(f, "approve");
    expect(find("MT")).toEqual([a]);
    expect(userDecisions.undo(db, ref(f)).status).toBe("applied");
    expect(find("MT")).toEqual([]);
    decide(f, "approve");
    decide(f, "dispute");
    expect(find("MT")).toEqual([]);
    decide(f, "reject");
    expect(find("MT")).toEqual([]);
    decide(f, "approve"); // a rejected form the user approves again
    expect(find("MT")).toEqual([a]);

    const g = alias(a, "QX");
    decide(g, "approve");
    const fixed = userDecisions.replaceValue(db, ref(g), "QY");
    expect(fixed.status).toBe("applied"); // QX is superseded, MTY is the user's own verified row
    expect(find("QX")).toEqual([]);
    expect(find("QY")).toEqual([a]);
  });

  it("matches a form as it matches a name: case, width and white space, and the stored form stays as written", () => {
    const a = item("멀티테넌시");
    const f = alias(a, "Ｍulti  Tenant", "alias.translation");
    setStatusForTest(db, "fact", f, "verified");
    expect(find("the MULTI TENANT design")).toEqual([a]);
    expect(find("multi\n\ttenant")).toEqual([a]);
    expect(find("multitenant")).toEqual([]);
    expect(db.all("SELECT value FROM facts WHERE id = ?", [f])).toEqual([
      { value: "Ｍulti  Tenant" },
    ]);
  });

  it("does not treat a verified fact of another kind as a form, nor an empty form as a match for every text", () => {
    const a = item("프로젝트 가");
    setStatusForTest(
      db,
      "fact",
      saveFact(db, { itemId: a, kind: "target_date", value: "2026-12-05", ...attrs }).id,
      "verified",
    );
    setStatusForTest(
      db,
      "fact",
      saveFact(db, { itemId: a, kind: "definition", value: "정의 문장", ...attrs }).id,
      "verified",
    );
    setStatusForTest(db, "fact", alias(a, "   "), "verified");
    expect(find("2026-12-05 정의 문장 아무 글")).toEqual([]);
  });

  it("offers an item once when its name and a form both appear, and keeps the name path as it was", () => {
    const a = item("멀티테넌시");
    setStatusForTest(db, "fact", alias(a, "MT"), "verified");
    const b = item("다른 항목"); // matched by its name only
    expect(find("MT 멀티테넌시 다른 항목")).toEqual([a, b]);
    // an item found by a form only comes in id order among the ones found by name
    expect(find("MT 다른 항목")).toEqual([a, b]);
  });

  it("offers every item that holds the same verified form, in id order, and merges none", () => {
    const a = item("멀티테넌시");
    const b = item("멀티 모니터");
    const c = item("연결 안 된 항목");
    setStatusForTest(db, "fact", alias(a, "MT"), "verified");
    setStatusForTest(db, "fact", alias(b, "mt"), "verified");
    expect(find("MT")).toEqual([a, b]);
    expect(db.all("SELECT id FROM items ORDER BY id")).toEqual([{ id: a }, { id: b }, { id: c }]);
  });
});

/** A merge line as the user's entry leaves it: the member is the representative's; `active = 0` is a resting line. */
const line = (member: number, representative: number, active = 1) =>
  db.run("INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, ?, ?)", [
    member,
    representative,
    active,
    "2026-11-23T00:00:00.000Z",
  ]);

describe("resolution.group-reads: a member's name sends the representative (S02-R13)", () => {
  it("finds the representative when only a member's name is in the text, once when both names are, with and without a registry", () => {
    const [rep, member] = [item("대표 항목"), item("구성원 항목")] as const;
    line(member, rep);
    expect(find("구성원 항목 만")).toEqual([rep]);
    expect(find("구성원 항목 과 대표 항목")).toEqual([rep]);
    expect(findCandidates(db, "구성원 항목 만")).toEqual([rep]);
    expect(findCandidates(db, "대표 항목 만")).toEqual([rep]);
  });

  it("finds the representative through a member's verified form, and not through a candidate-status one", () => {
    const [rep, member] = [item("대표 항목"), item("구성원 항목")] as const;
    line(member, rep);
    setStatusForTest(db, "fact", alias(member, "MT"), "verified");
    alias(member, "CANDIDATE"); // stays a candidate
    expect(find("MT")).toEqual([rep]);
    expect(find("CANDIDATE")).toEqual([]);
  });

  it("finds the member itself while its group rests, and sends each of them as it is", () => {
    const [rep, member] = [item("대표 항목"), item("구성원 항목")] as const;
    line(member, rep, 0);
    expect(find("구성원 항목 만")).toEqual([member]);
    expect(find("구성원 항목 과 대표 항목")).toEqual([rep, member]);
  });
});

describe("linking.verified-forms: rules the search pins", () => {
  it("reads no form at all when called without a registry: names only, as before T09 (no ungated path)", () => {
    const a = item("멀티테넌시");
    const b = item("지연 평가");
    setStatusForTest(db, "fact", alias(a, "MT"), "verified");
    expect(findCandidates(db, "MT 와 지연 평가")).toEqual([b]);
    expect(find("MT 와 지연 평가")).toEqual([a, b]);
  });

  it("matches a form as a name is matched: no word boundary and no minimum length", () => {
    const a = item("인공지능");
    const k = item("케이");
    setStatusForTest(db, "fact", alias(a, "AI"), "verified");
    setStatusForTest(db, "fact", alias(k, "가", "alias.translation"), "verified");
    expect(find("MAIL 과 fresh air")).toEqual([a]); // inside a longer word
    expect(find("가나다")).toEqual([k]); // one character
    const n = item("물결");
    expect(find("물결무늬")).toEqual([n]); // a name matches inside a longer word too
  });

  it("does not read a fact whose kind only looks like a form kind in another case", () => {
    const a = item("대소문자 항목");
    for (const [factKind, value] of [
      ["Alias.note", "QQKIND"],
      ["ALIAS.x", "RRKIND"],
      ["alias.note", "SSKIND"],
    ] as const) {
      expect(userDecisions.add(db, { kind: "fact", itemId: a, factKind, value }).status).toBe(
        "applied",
      );
    }
    expect(find("QQKIND")).toEqual([]);
    expect(find("RRKIND")).toEqual([]);
    expect(find("SSKIND")).toEqual([a]); // the shared definition: starts with `alias.` as written
  });
});

describe("linking.verified-forms: deletion", () => {
  it("stops offering an item whose form came from a deleted source, with the form", () => {
    const saved = saveSourceRecord(db, "imported", {
      externalId: "g",
      title: "용어",
      body: "MT는 멀티테넌시의 약어",
    });
    if (saved.status !== "created") throw new Error(saved.status);
    const versionRow = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    const a = item("멀티테넌시");
    const f = alias(a, "MT");
    addEvidence(db, {
      target: { factId: f },
      sourceVersionId: versionRow,
      start: 0,
      end: 2,
      quote: "MT",
    });
    setStatusForTest(db, "fact", f, "verified");
    expect(find("MT")).toEqual([a]);
    purgeSource(db, saved.sourceId, { reason: "source-deleted", at: "2026-11-23T00:00:00Z" });
    expect(db.all("SELECT id FROM facts WHERE id = ?", [f])).toEqual([]);
    expect(find("MT")).toEqual([]);
  });
});

/** Sources can be told apart by scope: a stand-in for a site's rule (the default policy refuses nothing). */
const hidingSecret: ScopePolicy & { asked: ScopePurpose[] } = {
  ...defaultScopePolicy,
  asked: [],
  allows(scopes, purpose) {
    hidingSecret.asked.push(purpose);
    return scopes.every((s) => s === null || !s.includes("secret"));
  },
};
const sameScopeOnly: ScopePolicy = {
  ...defaultScopePolicy,
  combinable: (scopes) => new Set(scopes.map((s) => JSON.stringify(s))).size <= 1,
};

function sourceIn(
  externalId: string,
  body: string,
  scope: readonly string[],
  instance = "imported",
) {
  const saved = saveSourceRecord(db, instance, { externalId, title: `제목 ${externalId}`, body });
  if (saved.status !== "created") throw new Error(saved.status);
  db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
    JSON.stringify(scope),
    saved.sourceId,
  ]);
  return { ...saved, row: db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number };
}
const quoted = (factId: number, from: { row: number }) =>
  addEvidence(db, {
    target: { factId },
    sourceVersionId: from.row,
    start: 0,
    end: 1,
    quote: db.all("SELECT substr(body, 1, 1) AS q FROM source_versions WHERE id = ?", [from.row])[0]
      ?.q as string,
  });

describe("linking.verified-forms: egress (the policy's read gate)", () => {
  beforeEach(() => {
    hidingSecret.asked.length = 0;
  });

  it("does not use a form whose own row the policy hides, but uses the same form from an open source", () => {
    const open = sourceIn("open", "제목", ["team"]);
    const secret = sourceIn("secret", "제목", ["secret"]);
    const a = item("멀티테넌시");
    const hiddenForm = alias(a, "MT");
    const shownForm = alias(a, "다중 임차");
    setStatusForTest(db, "fact", hiddenForm, "verified");
    setStatusForTest(db, "fact", shownForm, "verified");
    quoted(hiddenForm, secret);
    quoted(shownForm, open);
    const registry = createProductRegistry({ policy: hidingSecret });
    // the item's own lineage holds the secret source too, so the item is hidden as well; see the next case
    // for the item alone: here the form row is the only thing under test, so the item has no other lineage
    expect(findCandidates(db, "MT", registry)).toEqual([]);
    expect(hidingSecret.asked).toContain("search");
    db.run("DELETE FROM evidence WHERE fact_id = ?", [hiddenForm]);
    const clean = item("지연 평가");
    const cleanForm = alias(clean, "다중 평가");
    setStatusForTest(db, "fact", cleanForm, "verified");
    quoted(cleanForm, open);
    expect(findCandidates(db, "다중 평가", registry)).toEqual([clean]);
  });

  it("judges the form's own row apart from its item: a policy that shows the item's whole lineage but not the form's part hides the form", () => {
    const open = sourceIn("open", "제목 공개", ["team"]);
    const secret = sourceIn("secret", "제목 비공개", ["secret"]);
    const a = item("멀티테넌시");
    quoted(
      saveFact(db, { itemId: a, kind: "target_date", value: "2026-12-01", ...attrs }).id,
      open,
    );
    const f = alias(a, "MT");
    setStatusForTest(db, "fact", f, "verified");
    quoted(f, secret);
    // shows a set of scopes unless it is the one scope `secret` alone (the form's lineage); the item's is {team, secret}
    const onlySecret: ScopePolicy = {
      ...defaultScopePolicy,
      allows: (scopes) => !(scopes.length === 1 && JSON.stringify(scopes[0]) === '["secret"]'),
    };
    expect(findCandidates(db, "MT", createProductRegistry({ policy: onlySecret }))).toEqual([]);
    expect(findCandidates(db, "MT", createProductRegistry({ policy: defaultScopePolicy }))).toEqual(
      [a],
    );
  });

  it("does not use a form of an item the policy hides, even when the form's own row is open", () => {
    const open = sourceIn("open", "제목", ["team"]);
    const secret = sourceIn("secret", "제목", ["secret"]);
    const a = item("멀티테넌시");
    const openForm = alias(a, "MT");
    setStatusForTest(db, "fact", openForm, "verified");
    quoted(openForm, open);
    const registry = createProductRegistry({ policy: hidingSecret });
    expect(findCandidates(db, "MT", registry)).toEqual([a]);
    // another fact of the item comes from the secret source: the item (its lineage) is hidden
    quoted(
      saveFact(db, { itemId: a, kind: "target_date", value: "2026-12-05", ...attrs }).id,
      secret,
    );
    expect(findCandidates(db, "MT", registry)).toEqual([]);
  });
});

describe("linking.verified-forms: through the extract handler and the Broker", () => {
  let requests: BrokerRequest[];
  let egressAsked: EgressInput[];
  let provider: FakeProvider;

  function kit(policy: ScopePolicy = defaultScopePolicy) {
    const registry = createProductRegistry({ policy });
    provider = new FakeProvider({
      answer: () => ({ items: [], facts: [], relations: [], terms: [], definitions: [] }),
    });
    const broker = createBroker({
      db,
      provider: () => provider,
      userActions: createUserActionLedger().redeemer,
      candidates: knowledgeCandidates(db, registry),
      egress: {
        decide: (input) => {
          egressAsked.push(input);
          return { allowed: true, destination: "fake", policyVersion: "pv" };
        },
      },
      execution: { decide: () => ({ run: true }) },
      recorder: {
        record: () => undefined,
        begin: () => () => undefined,
        attemptTimes: () => [],
        interruptStarted: () => 0,
      },
      clock: { now: () => 0, sleep: async () => undefined },
    });
    const handler = createExtractHandler({ db, registry, now: () => T0 });
    const scope = createCommitScope({ policy: registry.policy, now: () => T0.toISOString() });
    const recording = {
      call: (raw: unknown) => {
        requests.push(structuredClone(raw) as BrokerRequest);
        return broker.call(raw);
      },
    };
    return async (s: { sourceId: number; version: number }) => {
      registerJob(db, {
        kind: "extract",
        target: "",
        sourceId: s.sourceId,
        fenceVersion: s.version,
        at: T0,
      });
      const job = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 }) as StoredJob;
      const result = await handler(job, { broker: recording });
      if (result.status !== "succeeded") throw new Error(`handler ${result.status}`);
      closeJob(db, job, result, T0, scope);
    };
  }
  beforeEach(() => {
    requests = [];
    egressAsked = [];
  });

  /** An item whose name fact is quoted by `nameFrom` and whose verified form is quoted by `formFrom`. */
  function knownItem(
    name: string,
    form: string,
    nameFrom: { row: number },
    formFrom: { row: number },
  ) {
    const id = item(name);
    quoted(
      saveFact(db, { itemId: id, kind: "target_date", value: "2026-12-01", ...attrs }).id,
      nameFrom,
    );
    const f = alias(id, form);
    setStatusForTest(db, "fact", f, "verified");
    quoted(f, formFrom);
    return id;
  }

  /** The synthetic fixtures (listed in the manifest) and their text: the wiki names "연동 테스트" and no item. */
  const fixture = (file: string) =>
    JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../fixtures", file), "utf8").split(
        "\n",
      )[0] as string,
    ) as {
      id: string;
      title: string;
      content: string;
    };
  const stored = (line: { id: string; title: string; content: string }, instance = "fixtures") => {
    const saved = saveSourceRecord(db, instance, {
      externalId: line.id,
      title: line.title,
      body: line.content,
    });
    if (saved.status !== "created") throw new Error(saved.status);
    return { ...saved, row: db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number };
  };

  it("offers an item named by a form only, sending just the item's id and name, and grades the call by the item's whole lineage", async () => {
    const mail = stored(fixture("v02-mail.jsonl"));
    const general = sourceIn("gen", "제목 일반", ["team"]);
    const id = knownItem("검증 모듈", "연동 테스트", mail, general);
    const run = kit();
    await run(stored(fixture("v02-wiki.jsonl"))); // a synthetic document that names the item by its form only
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[String(id)]]);
    expect(provider.requests.map((r) => r.input.candidates)).toEqual([
      [{ id: String(id), name: "검증 모듈" }],
    ]);
    // the form's source is in the item's lineage: a general source raises the grade of a synthetic document's call
    expect(egressAsked.at(-1)?.classification).toBe("general");
  });

  it("keeps the call synthetic when every source of the item and its form is synthetic", async () => {
    const id = knownItem(
      "검증 모듈",
      "연동 테스트",
      stored(fixture("v02-mail.jsonl")),
      stored(fixture("v02-messenger.jsonl")),
    );
    const run = kit();
    await run(stored(fixture("v02-wiki.jsonl")));
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[String(id)]]);
    expect(egressAsked.at(-1)?.classification).toBe("synthetic");
  });

  it("offers no item when its form comes from a source the policy cannot put together with this document", async () => {
    const a = sourceIn("a", "제목 가", ["team-a"]);
    const b = sourceIn("b", "제목 나", ["team-b"]);
    knownItem("멀티테넌시", "MT", a, b); // lineage {a, b}: not combinable under this policy at all
    const run = kit(sameScopeOnly);
    await run(sourceIn("doc", "MT 일정 메모", ["team-a"]));
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[]]);
  });

  /** A user-created item has an empty lineage (S01-R22): a form extraction attached to it brings its own source. */
  function userItemWithExtractedForm(from: { row: number }) {
    const added = userDecisions.add(db, { kind: "item", type: "Concept", name: "사용자항목" });
    if (added.status !== "applied") throw new Error("add");
    const f = alias(added.ref.id, "ZQXF");
    quoted(f, from);
    expect(userDecisions.decide(db, ref(f), "approve").status).toBe("applied");
    return added.ref.id;
  }

  it("does not offer a user-created item through a form from a source the policy cannot put together with this one (I04-R14)", async () => {
    sourceIn("a0", "제목 가", ["team-a"]);
    userItemWithExtractedForm(sourceIn("b", "제목 나", ["team-b"]));
    const run = kit(sameScopeOnly);
    await run(sourceIn("doc", "ZQXF 일정 메모", ["team-a"]));
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[]]);
  });

  it("controls: the same form on a regular item is offered when the sources may be put together", async () => {
    const id = item("일반항목");
    quoted(
      saveFact(db, { itemId: id, kind: "target_date", value: "2026-12-01", ...attrs }).id,
      sourceIn("n", "제목 이름", ["team-a"]),
    );
    const f = alias(id, "ZQXF");
    quoted(f, sourceIn("b", "제목 나", ["team-a"]));
    userDecisions.decide(db, ref(f), "approve");
    const run = kit(sameScopeOnly);
    await run(sourceIn("doc", "ZQXF 일정 메모", ["team-a"]));
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[String(id)]]);
  });

  it("controls: a form the user added to a user-created item (empty lineage on both) is offered", async () => {
    const id = userItemWithExtractedForm(sourceIn("b", "제목 나", ["team-a"]));
    expect(
      userDecisions.add(db, {
        kind: "fact",
        itemId: id,
        factKind: "alias.synonym",
        value: "사용자별칭",
      }).status,
    ).toBe("applied");
    const run = kit(sameScopeOnly);
    await run(sourceIn("doc", "사용자별칭 일정 메모", ["team-a"]));
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[String(id)]]);
  });

  /** A representative named "검증 모듈" from `repFrom`, and its member named "연동 테스트" (the wiki fixture's wording) from `memberFrom`. */
  function group(repFrom: { row: number }, memberFrom: { row: number }) {
    const rep = item("검증 모듈");
    quoted(
      saveFact(db, { itemId: rep, kind: "target_date", value: "2026-12-01", ...attrs }).id,
      repFrom,
    );
    const member = item("연동 테스트");
    quoted(
      saveFact(db, { itemId: member, kind: "target_date", value: "2026-12-02", ...attrs }).id,
      memberFrom,
    );
    line(member, rep);
    return { rep, member };
  }

  it("resolution.group-reads: offers the representative's id and name to the Provider as the only candidate, never the member's", async () => {
    const { rep } = group(
      stored(fixture("v02-mail.jsonl")),
      stored(fixture("v02-messenger.jsonl")),
    );
    const run = kit();
    await run(stored(fixture("v02-wiki.jsonl"))); // the text names the member
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[String(rep)]]);
    expect(provider.requests.map((r) => r.input.candidates)).toEqual([
      [{ id: String(rep), name: "검증 모듈" }],
    ]);
  });

  it("resolution.group-reads: grades the call by the whole group's lineage, not the representative's own", async () => {
    // the representative's sources are synthetic; the member's is a general one
    group(stored(fixture("v02-mail.jsonl")), sourceIn("gen", "제목 일반", ["team"]));
    const run = kit();
    await run(stored(fixture("v02-wiki.jsonl")));
    expect(egressAsked.at(-1)?.classification).toBe("general");
  });

  it("resolution.group-reads: keeps the call synthetic when every member's source is synthetic (control)", async () => {
    group(stored(fixture("v02-mail.jsonl")), stored(fixture("v02-messenger.jsonl")));
    const run = kit();
    await run(stored(fixture("v02-wiki.jsonl")));
    expect(egressAsked.at(-1)?.classification).toBe("synthetic");
  });

  it("egress.type-names: a user-made representative's name is never graded by its members' sources alone", async () => {
    const added = userDecisions.add(db, { kind: "item", type: "Concept", name: "검증 모듈" });
    if (added.status !== "applied") throw new Error("add");
    const rep = Number(added.ref.id); // the name is the user's own text: no lineage of its own
    const member = item("연동 테스트");
    quoted(
      saveFact(db, { itemId: member, kind: "target_date", value: "2026-12-02", ...attrs }).id,
      stored(fixture("v02-messenger.jsonl")),
    );
    line(member, rep);
    const run = kit();
    await run(stored(fixture("v02-wiki.jsonl")));
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[String(rep)]]);
    expect(egressAsked.at(-1)?.classification).toBe("general");
  });

  it("resolution.group-reads: offers no representative when a member's source cannot be put together with this document", async () => {
    const rep = item("멀티테넌시");
    quoted(
      saveFact(db, { itemId: rep, kind: "target_date", value: "2026-12-01", ...attrs }).id,
      sourceIn("a", "제목 가", ["team-a"]),
    );
    const member = item("다중 임차");
    quoted(
      saveFact(db, { itemId: member, kind: "target_date", value: "2026-12-02", ...attrs }).id,
      sourceIn("b", "제목 나", ["team-b"]),
    );
    line(member, rep);
    const run = kit(sameScopeOnly);
    await run(sourceIn("doc", "다중 임차 일정 메모", ["team-a"]));
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[]]);
  });

  it("passes the extraction's own registry to the search: a form the policy hides is not offered to the Provider", async () => {
    const open = sourceIn("open", "제목 공개", ["team"]);
    const secret = sourceIn("secret", "제목 비공개", ["secret"]);
    const id = item("검증 모듈");
    quoted(
      saveFact(db, { itemId: id, kind: "target_date", value: "2026-12-01", ...attrs }).id,
      open,
    );
    const f = alias(id, "연동 테스트");
    setStatusForTest(db, "fact", f, "verified");
    quoted(f, secret);
    const run = kit(hidingSecret);
    await run(sourceIn("doc", "연동 테스트를 시작한다", ["team"]));
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[]]);
  });

  it("does not offer a candidate-status form's item, and a verified form added after offers it next time", async () => {
    const s = sourceIn("s", "제목", ["team"]);
    const id = item("멀티테넌시");
    quoted(saveFact(db, { itemId: id, kind: "target_date", value: "2026-12-01", ...attrs }).id, s);
    const f = alias(id, "MT");
    quoted(f, s);
    const run = kit();
    await run(sourceIn("d1", "MT 일정 메모 하나", ["team"]));
    userDecisions.decide(db, ref(f), "approve");
    await run(sourceIn("d2", "MT 일정 메모 둘", ["team"]));
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[], [String(id)]]);
  });
});
