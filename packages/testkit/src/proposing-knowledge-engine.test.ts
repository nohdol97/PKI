// The proposing test double keeps a source's proposals only while it holds that
// version: removal and rebuild drop them, so no removed source's quote is proposed.
import type { KnowledgeCandidate } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { ProposingKnowledgeEngine } from "./proposing-knowledge-engine.ts";

const engine = () =>
  new ProposingKnowledgeEngine(({ ref, body }): KnowledgeCandidate[] => [
    {
      kind: "fact",
      ref,
      item: { type: "Project", name: "alpha", existingItemId: null },
      factKind: "target_date",
      value: "2026-12-05",
      epistemic: "explicit",
      quote: body,
    },
  ]);
const ref = (version: number) => ({ sourceId: "a", version });
const input = (version: number) => ({ ref: ref(version), title: "a", body: `jwxquote ${version}` });

describe("ProposingKnowledgeEngine", () => {
  it("proposes for the version it holds only", async () => {
    const e = engine();
    await e.upsertSource(input(1), { version: 1 }, 1);
    expect((await e.proposeKnowledge(ref(1))).map((c) => c.quote)).toEqual(["jwxquote 1"]);
    expect(await e.proposeKnowledge(ref(2))).toEqual([]);
  });

  it("drops a removed source's proposals", async () => {
    const e = engine();
    await e.upsertSource(input(1), { version: 1 }, 1);
    await e.removeSource(ref(1), { version: 1 }, 2);
    expect(await e.proposeKnowledge(ref(1))).toEqual([]);
  });

  it("keeps the newer version's proposals when an older one is removed", async () => {
    const e = engine();
    await e.upsertSource(input(2), { version: 2 }, 1);
    await e.removeSource(ref(1), { version: 2 }, 1);
    expect(await e.proposeKnowledge(ref(2))).toHaveLength(1);
  });

  it("rebuilds its proposals from the sources given", async () => {
    const e = engine();
    await e.upsertSource(input(1), { version: 1 }, 1);
    async function* none() {}
    await e.rebuild(none(), 2);
    expect(await e.proposeKnowledge(ref(1))).toEqual([]);
  });
});
