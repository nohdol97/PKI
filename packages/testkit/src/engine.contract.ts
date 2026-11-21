// V01-C7 `engine.contract` (V01-R16, ARCHITECTURE 5.3): the suite every working
// KnowledgeEngine runs. It observes deletion and rebuild through relatedContext,
// so it requires that capability; the null engine has its own test instead,
// because this suite would pass vacuously against it.
import {
  StaleFenceError,
  UnsupportedCapabilityError,
  type EngineSourceInput,
  type KnowledgeEngine,
} from "@pki/contracts";
import { beforeEach, describe, expect, it } from "vitest";

const src = (sourceId: string, version: number, body: string): EngineSourceInput => ({
  ref: { sourceId, version },
  title: `${sourceId} v${version}`,
  body,
});
const QUERIES = ["alpha", "beta", "gamma", "alpha beta", "delta"];

async function hitSources(engine: KnowledgeEngine, text: string) {
  return (await engine.relatedContext({ text, limit: 10 })).map((hit) => hit.ref);
}

export function knowledgeEngineContract(
  name: string,
  create: () => KnowledgeEngine | Promise<KnowledgeEngine>,
): void {
  describe(`engine.contract: ${name}`, () => {
    let engine: KnowledgeEngine;

    beforeEach(async () => {
      engine = await create();
    });

    it("can observe results (relatedContext) and reports ready", async () => {
      expect(engine.capabilities().relatedContext).toBe(true);
      expect(await engine.health()).toEqual({ state: "ready" });
    });

    it("claims no capability it does not have", async () => {
      const ref = { sourceId: "a", version: 1 };
      await engine.upsertSource(src("a", 1, "alpha"), { version: 1 }, 1);
      const calls = {
        propose: () => engine.proposeKnowledge(ref),
        relatedContext: () => engine.relatedContext({ text: "alpha", limit: 1 }),
      };
      for (const [capability, call] of Object.entries(calls)) {
        if (engine.capabilities()[capability as keyof typeof calls]) {
          expect(Array.isArray(await call())).toBe(true);
        } else {
          await expect(call()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
        }
      }
    });

    it("reports the last applied change sequence", async () => {
      expect(await engine.appliedChangeSeq()).toBeNull();
      await engine.upsertSource(src("a", 1, "alpha"), { version: 1 }, 1);
      await engine.removeSource({ sourceId: "a", version: 1 }, { version: 1 }, 2);
      expect(await engine.appliedChangeSeq()).toBe(2);
    });

    it("never returns a removed source again", async () => {
      await engine.upsertSource(src("a", 1, "alpha shared"), { version: 1 }, 1);
      await engine.upsertSource(src("b", 1, "beta shared"), { version: 1 }, 2);
      await engine.removeSource({ sourceId: "a", version: 1 }, { version: 1 }, 3);
      expect(await hitSources(engine, "alpha")).toEqual([]);
      expect(await hitSources(engine, "shared")).toEqual([{ sourceId: "b", version: 1 }]);
    });

    it("removing a replaced version leaves nothing derived only from it", async () => {
      await engine.upsertSource(src("a", 1, "alpha"), { version: 1 }, 1);
      await engine.upsertSource(src("a", 2, "beta"), { version: 2 }, 2);
      await engine.removeSource({ sourceId: "a", version: 1 }, { version: 2 }, 2);
      expect(await hitSources(engine, "alpha")).toEqual([]);
      expect(await hitSources(engine, "beta")).toEqual([{ sourceId: "a", version: 2 }]);
    });

    it("rejects a stale fence and changes nothing", async () => {
      await engine.upsertSource(src("a", 2, "beta"), { version: 2 }, 2);
      await expect(
        engine.upsertSource(src("a", 1, "alpha"), { version: 1 }, 3),
      ).rejects.toBeInstanceOf(StaleFenceError);
      await expect(
        engine.removeSource({ sourceId: "a", version: 2 }, { version: 1 }, 3),
      ).rejects.toBeInstanceOf(StaleFenceError);
      expect(await hitSources(engine, "alpha")).toEqual([]);
      expect(await hitSources(engine, "beta")).toEqual([{ sourceId: "a", version: 2 }]);
      expect(await engine.appliedChangeSeq()).toBe(2);
    });

    it("does not let a late upsert resurrect a removed version", async () => {
      await engine.upsertSource(src("a", 1, "alpha"), { version: 1 }, 1);
      await engine.removeSource({ sourceId: "a", version: 1 }, { version: 1 }, 2);
      await expect(
        engine.upsertSource(src("a", 1, "alpha"), { version: 1 }, 2),
      ).rejects.toBeInstanceOf(StaleFenceError);
      expect(await hitSources(engine, "alpha")).toEqual([]);
      // The rejected call above must not have recorded its fence either.
      await expect(
        engine.upsertSource(src("a", 1, "alpha"), { version: 3 }, 3),
      ).rejects.toBeInstanceOf(StaleFenceError);
      await engine.upsertSource(src("a", 2, "beta"), { version: 2 }, 3);
      expect(await hitSources(engine, "beta")).toEqual([{ sourceId: "a", version: 2 }]);
    });

    describe("rebuild", () => {
      const b1 = src("b", 1, "gamma beta");
      const finalSources = [src("a", 2, "alpha beta"), b1];

      async function* stream(sources: readonly EngineSourceInput[]) {
        yield* sources;
      }

      async function answers(target: KnowledgeEngine) {
        const out = [];
        for (const text of QUERIES) out.push(await target.relatedContext({ text, limit: 10 }));
        return { out, applied: await target.appliedChangeSeq() };
      }

      beforeEach(async () => {
        await engine.upsertSource(src("a", 1, "alpha"), { version: 1 }, 1);
        await engine.upsertSource(src("b", 1, "gamma beta"), { version: 1 }, 2);
        await engine.upsertSource(src("c", 1, "delta"), { version: 1 }, 3);
        await engine.upsertSource(src("a", 2, "alpha beta"), { version: 2 }, 4);
        await engine.removeSource({ sourceId: "a", version: 1 }, { version: 2 }, 4);
        await engine.removeSource({ sourceId: "c", version: 1 }, { version: 1 }, 5);
      });

      it("from the canonical sources equals the incrementally built engine", async () => {
        const rebuilt = await create();
        await rebuilt.rebuild(stream(finalSources), 5);
        expect(await answers(rebuilt)).toEqual(await answers(engine));
      });

      it("twice gives the same result, and drops what the sources no longer hold", async () => {
        const before = await answers(engine);
        await engine.rebuild(stream(finalSources), 5);
        await engine.rebuild(stream(finalSources), 5);
        expect(await answers(engine)).toEqual(before);
        await engine.rebuild(stream([b1]), 6);
        expect(await hitSources(engine, "alpha")).toEqual([]);
        expect(await engine.appliedChangeSeq()).toBe(6);
      });
    });
  });
}
