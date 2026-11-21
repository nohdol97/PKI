// V01-C6 `embedding.contract`, egress leg (V01-R14, ARCHITECTURE 5.2, ADR 0014):
// an embedder whose egress is not 'local' is not called unless the embedding egress
// policy allows it, asked before every call; a local one never asks.
import { FakeEmbedder } from "@pki/testkit";
import { describe, expect, it } from "vitest";
import {
  denyExternalEmbedding,
  embedWithinPolicy,
  EmbeddingEgressDeniedError,
  type EmbeddingEgressPolicy,
} from "./embedding.ts";

const pack = { kind: "local-pack", path: "/synthetic/pack" } as const;

async function ready(fake: FakeEmbedder) {
  await fake.prepare(pack, new AbortController().signal);
  return fake;
}

function recordingPolicy(answer: ReturnType<EmbeddingEgressPolicy["decide"]>) {
  const asked: Parameters<EmbeddingEgressPolicy["decide"]>[0][] = [];
  const policy: EmbeddingEgressPolicy = {
    decide: (input) => {
      asked.push(input);
      return answer;
    },
  };
  return { asked, policy };
}

describe("embedWithinPolicy", () => {
  it("calls a local embedder without asking the policy", async () => {
    const fake = await ready(new FakeEmbedder());
    const { asked, policy } = recordingPolicy({ allowed: false, reason: "never" });
    const vectors = await embedWithinPolicy(fake, policy, ["합성 문장"], "document");
    expect(vectors).toHaveLength(1);
    expect(asked).toEqual([]);
    expect(fake.calls.embed).toHaveLength(1);
  });

  it("does not call an external embedder the policy denies", async () => {
    const fake = await ready(new FakeEmbedder({ egress: "external", modelId: "remote-embed" }));
    const { asked, policy } = recordingPolicy({ allowed: false, reason: "no-consent" });
    const error = await embedWithinPolicy(fake, policy, ["합성 문장"], "query").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EmbeddingEgressDeniedError);
    expect((error as EmbeddingEgressDeniedError).reason).toBe("no-consent");
    expect(fake.calls.embed).toEqual([]);
    // Texts carry no provenance here, so they are graded general (closed side, V01-R8).
    expect(asked).toEqual([{ modelId: "remote-embed", classification: "general" }]);
  });

  it("calls an external embedder the policy allows, asking again on every call", async () => {
    const fake = await ready(new FakeEmbedder({ egress: "external" }));
    const { asked, policy } = recordingPolicy({ allowed: true });
    await embedWithinPolicy(fake, policy, ["가"], "document");
    await embedWithinPolicy(fake, policy, ["나"], "document");
    expect(asked).toHaveLength(2);
    expect(fake.calls.embed).toHaveLength(2);
  });

  it("treats an egress other than exactly 'local' as external", async () => {
    const fake = await ready(new FakeEmbedder());
    const odd = Object.assign(fake, {
      describe: () => ({ ...new FakeEmbedder().describe(), egress: "Local" as never }),
    });
    await expect(
      embedWithinPolicy(odd, denyExternalEmbedding, ["합성"], "document"),
    ).rejects.toBeInstanceOf(EmbeddingEgressDeniedError);
    expect(fake.calls.embed).toEqual([]);
  });

  it("refuses an answer that is not exactly an allowance", async () => {
    const fake = await ready(new FakeEmbedder({ egress: "external" }));
    const { policy } = recordingPolicy({ allowed: "yes" } as never);
    await expect(embedWithinPolicy(fake, policy, ["합성"], "document")).rejects.toBeInstanceOf(
      EmbeddingEgressDeniedError,
    );
    expect(fake.calls.embed).toEqual([]);
  });

  it("denies every external embedding by default (no consent path for embedding yet)", async () => {
    const fake = await ready(new FakeEmbedder({ egress: "external" }));
    await expect(
      embedWithinPolicy(fake, denyExternalEmbedding, ["합성"], "document"),
    ).rejects.toBeInstanceOf(EmbeddingEgressDeniedError);
    expect(fake.calls.embed).toEqual([]);
  });
});
