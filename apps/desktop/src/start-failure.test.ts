// I04-R7 (identity.key, T07 handoff via I04-T13): a start refused for the missing
// identity key shows its reason; the backend reports the class only, never a message.
import { describe, expect, it } from "vitest";
import {
  backendEnv,
  startBackendProcess,
  type BackendChild,
  type ForkBackend,
} from "./backend-process.ts";
import { startFailureText } from "./start-failure-text.ts";

function childReporting(report: unknown): BackendChild {
  let onMessage: (message: unknown) => void = () => undefined;
  return {
    pid: 1,
    postMessage: () => queueMicrotask(() => onMessage(report)),
    on: (_event, listener) => void (onMessage = listener),
    once: () => undefined,
    kill: () => true,
  };
}
const start = (report: unknown) =>
  startBackendProcess({
    fork: () => childReporting(report),
    entry: "unused",
    origin: "app://pki",
  });

describe("start.identity-key-text: the start failure text (I04-R7)", () => {
  it("carries the reported class from the backend to the failure text", async () => {
    const error = await start({ type: "failed", reason: "identity-key-missing" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("backend failed to start");
    expect(startFailureText(error)).toContain("식별자 키");
    expect(startFailureText(error)).toContain("가져오기와 동기화를 열지 않");
  });

  it("keeps the generic text for a failure with no known reason", async () => {
    const bare = await start({ type: "failed" }).catch((e: unknown) => e);
    expect(startFailureText(bare)).toBe("앱을 시작하지 못했습니다.");
    expect(startFailureText("anything")).toBe("앱을 시작하지 못했습니다.");
  });

  it("refuses a reason outside the known classes", async () => {
    const error = await start({ type: "failed", reason: "ENOENT /secret/path" }).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe("backend sent an unexpected message");
    expect(startFailureText(error)).toBe("앱을 시작하지 못했습니다.");
  });
});

describe("scope policy start failures reach the dialog (I04-H2 ①, I04-R14)", () => {
  it("shows the 배포처 후속 notice when the backend refuses the site policy", async () => {
    const error = await start({ type: "failed", reason: "scope-policy-not-implemented" }).catch(
      (e: unknown) => e,
    );
    expect(startFailureText(error)).toMatch(/^배포처 후속/);
    expect(startFailureText(error)).toContain("site");
  });

  it("shows its own text when the backend refuses an empty or unknown policy name", async () => {
    const error = await start({ type: "failed", reason: "scope-policy-invalid" }).catch(
      (e: unknown) => e,
    );
    expect(startFailureText(error)).toContain("비어 있거나 알 수 없는");
    expect(startFailureText(error)).not.toBe("앱을 시작하지 못했습니다.");
  });
});

describe("the policy name crosses the process boundary as a switch, not as environment (I04-R14)", () => {
  const spawned = (scopePolicy: string | undefined) => {
    const seen: { args: string[]; env: Record<string, string> }[] = [];
    const fork: ForkBackend = (_entry, args, env) => {
      seen.push({ args, env });
      return childReporting({ type: "ready", port: 1234 });
    };
    return startBackendProcess({
      fork,
      entry: "unused",
      origin: "app://pki",
      scopePolicy,
      env: { PATH: "/bin", PKI_SCOPE_POLICY: "site" },
    }).then(() => seen[0] as { args: string[]; env: Record<string, string> });
  };

  it("passes --scope-policy <name> to the backend, empty name included, and nothing when unset", async () => {
    expect((await spawned("site")).args).toEqual([
      "--origin",
      "app://pki",
      "--scope-policy",
      "site",
    ]);
    expect((await spawned("")).args).toEqual(["--origin", "app://pki", "--scope-policy", ""]);
    expect((await spawned(undefined)).args).toEqual(["--origin", "app://pki"]);
  });

  it("does not widen the environment passthrough", async () => {
    expect((await spawned("site")).env).toEqual({ PATH: "/bin" });
    expect(backendEnv({ PATH: "/bin", PKI_SCOPE_POLICY: "site" })).toEqual({ PATH: "/bin" });
  });
});

describe("an adapter no kind covers refuses the start with its own text (I04-R3)", () => {
  it("shows the unregistered-adapter text, without a path or name", async () => {
    const error = await start({ type: "failed", reason: "adapter-unregistered" }).catch(
      (e: unknown) => e,
    );
    expect(startFailureText(error)).toContain("삭제 규칙에 등록되어 있지 않아");
    expect(startFailureText(error)).not.toBe("앱을 시작하지 못했습니다.");
  });
});
