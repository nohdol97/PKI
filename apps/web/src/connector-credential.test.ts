// I06-C11 (I06-R14, R17): the screen's credential path with doubles for the preload (records `setSecret` and
// `deleteSecret`) and for `fetch` (records every request). The value goes to the shell's store and nowhere else:
// no request, no result and no text carries it. Every value is made up.
import { CREDENTIAL_RETRY_MIN_MS, SecretValueSchema, type RouteResponse } from "@pki/contracts";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api.ts";
import {
  changeCredential,
  checkCredentialValue,
  credentialOutcomeText,
  MAX_CREDENTIAL_LENGTH,
  rereadDelaysMs,
  type CredentialOutcome,
} from "./connector-credential.ts";

const CANARY = "synthetic-canary-value-0001";
const NAME = `connector.${"a".repeat(32)}.token`;

type Answer = RouteResponse<"credentialsChanged">;
const answer = (rebuild: Answer["rebuild"]): Answer => ({
  summary: {
    id: "mail-1",
    kind: "k",
    state: "ready",
    credentials: [{ slot: "token", name: NAME, state: "present" }],
  },
  rebuild,
});

function harness(rebuild: Answer["rebuild"] = "done") {
  const requests: { url: string; body: string | undefined }[] = [];
  const fetchDouble = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body as string | undefined });
    return new Response(JSON.stringify(answer(rebuild)), { status: 200 });
  });
  const bridge = {
    setSecret: vi.fn<(name: string, value: string) => Promise<unknown>>(async () => ({ ok: true })),
    deleteSecret: vi.fn<(name: string) => Promise<unknown>>(async () => ({ ok: true })),
  };
  const api = createApiClient(
    { baseUrl: "http://127.0.0.1:1", token: "t".repeat(43) },
    fetchDouble as unknown as typeof fetch,
  );
  return { requests, fetchDouble, bridge, deps: { bridge, api } };
}

describe("connector-credential (I06-C11)", () => {
  it("① a save hands the shell the listed name and the value once, then notices once, and the result holds no value", async () => {
    const { bridge, requests, deps } = harness();
    const outcome = await changeCredential(deps, "mail-1", NAME, { kind: "save", value: CANARY });
    expect(bridge.setSecret).toHaveBeenCalledTimes(1);
    expect(bridge.setSecret).toHaveBeenCalledWith(NAME, CANARY);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:1/api/connectors/credentials-changed");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ connectorId: "mail-1" });
    expect(outcome).toMatchObject({ status: "notified", rebuild: "done" });
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
  });

  it("② a delete asks the shell to delete the listed name and then notices", async () => {
    const { bridge, requests, deps } = harness();
    const outcome = await changeCredential(deps, "mail-1", NAME, { kind: "delete" });
    expect(bridge.deleteSecret).toHaveBeenCalledTimes(1);
    expect(bridge.deleteSecret).toHaveBeenCalledWith(NAME);
    expect(bridge.setSecret).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "notified" });
  });

  it("③ a save the shell cannot store says so and gives no notice", async () => {
    const { bridge, requests, deps } = harness();
    bridge.setSecret.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    const outcome = await changeCredential(deps, "mail-1", NAME, { kind: "save", value: CANARY });
    expect(outcome).toEqual({ status: "store-unavailable" });
    expect(credentialOutcomeText(outcome)).toContain("저장할 수 없습니다");
    expect(requests).toEqual([]);
  });

  it("⑦ a delete the shell cannot do says it was not deleted and gives no notice", async () => {
    const { bridge, requests, deps } = harness();
    bridge.deleteSecret.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    const outcome = await changeCredential(deps, "mail-1", NAME, { kind: "delete" });
    expect(outcome).toEqual({ status: "delete-failed" });
    expect(credentialOutcomeText(outcome)).toContain("지우지 못했습니다");
    expect(requests).toEqual([]);
  });

  it("a notice the backend refuses is told apart from a failed store: the value is stored, the notice is not", async () => {
    const { bridge, deps, fetchDouble } = harness();
    fetchDouble.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal-error" }), { status: 500 }),
    );
    const outcome = await changeCredential(deps, "mail-1", NAME, { kind: "save", value: CANARY });
    expect(bridge.setSecret).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: "notify-failed" });
    expect(credentialOutcomeText(outcome)).toContain("다시 시작");
  });

  it("⑥ no request's address or body holds the value, in any of its shapes, on any path", async () => {
    const shapes = [CANARY, Buffer.from(CANARY).toString("base64"), encodeURIComponent(CANARY)];
    for (const rebuild of ["done", "queued", "skipped"] as const) {
      const { requests, deps } = harness(rebuild);
      const saved = await changeCredential(deps, "mail-1", NAME, { kind: "save", value: CANARY });
      const deleted = await changeCredential(deps, "mail-1", NAME, { kind: "delete" });
      const seen = JSON.stringify([requests, saved, deleted, credentialOutcomeText(saved)]);
      for (const shape of shapes) expect(seen).not.toContain(shape);
      expect(requests.length).toBe(2);
    }
  });

  it("⑧ a queued notice and a skipped one are different words, and neither is the done one's", () => {
    const done = credentialOutcomeText(outcomeOf("done"));
    const queued = credentialOutcomeText(outcomeOf("queued"));
    const skipped = credentialOutcomeText(outcomeOf("skipped"));
    expect(new Set([done, queued, skipped]).size).toBe(3);
    expect(queued).toContain("곧 반영");
    expect(skipped).toContain("앱을 다시 시작");
  });

  it("a queued notice has the list read at once and again after the gap; the others once; a failure none", () => {
    expect(rereadDelaysMs(outcomeOf("queued"))).toEqual([0, CREDENTIAL_RETRY_MIN_MS]);
    expect(rereadDelaysMs(outcomeOf("done"))).toEqual([0]);
    expect(rereadDelaysMs(outcomeOf("skipped"))).toEqual([0]);
    for (const status of ["store-unavailable", "delete-failed", "notify-failed"] as const) {
      expect(rereadDelaysMs({ status })).toEqual([]);
    }
    expect(rereadDelaysMs({ status: "refused", reason: "line-break" })).toEqual([]);
  });

  it("F3 the limit is the shell's: a value of exactly that many characters is stored whole, one more is refused, never cut", async () => {
    expect(SecretValueSchema.safeParse("x".repeat(MAX_CREDENTIAL_LENGTH)).success).toBe(true);
    expect(SecretValueSchema.safeParse("x".repeat(MAX_CREDENTIAL_LENGTH + 1)).success).toBe(false);
    const whole = "x".repeat(MAX_CREDENTIAL_LENGTH);
    const ok = harness();
    await changeCredential(ok.deps, "mail-1", NAME, { kind: "save", value: whole });
    expect(ok.bridge.setSecret).toHaveBeenCalledWith(NAME, whole);
    const refused = harness();
    const outcome = await changeCredential(refused.deps, "mail-1", NAME, {
      kind: "save",
      value: whole + "x",
    });
    expect(outcome).toEqual({ status: "refused", reason: "too-long" });
    expect(refused.bridge.setSecret).not.toHaveBeenCalled();
    expect(refused.requests).toEqual([]);
    expect(credentialOutcomeText(outcome)).toContain(String(MAX_CREDENTIAL_LENGTH));
    expect(checkCredentialValue(whole)).toBeUndefined();
  });

  it("F3 a value with a line break is refused whatever its kind of break: nothing stored, no notice, fixed words", async () => {
    for (const value of ["a\nb", "a\r\nb", "a\rb", `-----BEGIN-----\n${CANARY}\n-----END-----`]) {
      const { bridge, requests, deps } = harness();
      const outcome = await changeCredential(deps, "mail-1", NAME, { kind: "save", value });
      expect(outcome).toEqual({ status: "refused", reason: "line-break" });
      expect(bridge.setSecret).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      expect(credentialOutcomeText(outcome)).toContain("한 줄 값만 넣을 수 있습니다");
      expect(credentialOutcomeText(outcome)).not.toContain(CANARY);
    }
  });

  it("F3 a paste the screen refused is an action too: its words, no store, no notice", async () => {
    const { bridge, requests, deps } = harness();
    const outcome = await changeCredential(deps, "mail-1", NAME, {
      kind: "refused",
      reason: "line-break",
    });
    expect(credentialOutcomeText(outcome)).toContain("한 줄 값만 넣을 수 있습니다");
    expect(bridge.setSecret).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});

function outcomeOf(rebuild: Answer["rebuild"]): CredentialOutcome {
  return { status: "notified", ...answer(rebuild) };
}
