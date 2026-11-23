// P01-R17 (#257 F2): the interpret checkbox writes the `autoVerify` the store holds now, not the one read when the page opened.
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api.ts";
import { writeInsightInterpret } from "./insight-settings.ts";

describe("writeInsightInterpret", () => {
  it("re-reads the settings and sends their current autoVerify with the new switch", async () => {
    const sent: unknown[] = [];
    const api = ((route: string, body?: unknown) => {
      if (route === "semanticSettings") return Promise.resolve({ autoVerify: true });
      sent.push(body);
      return Promise.resolve({});
    }) as unknown as ApiClient;
    await writeInsightInterpret(api, true);
    expect(sent).toEqual([{ autoVerify: true, insightInterpret: true }]);
  });
});
