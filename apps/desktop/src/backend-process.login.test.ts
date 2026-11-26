// I06S-R3: the shell asks the backend for an instance's login description over the parent channel, by
// request id, and takes only a well-formed answer: the description with a stored name, or `none`.
import { describe, expect, it } from "vitest";
import { startBackendProcess, type BackendChild, type ForkBackend } from "./backend-process.ts";

const NAME = `connector.${"0123456789abcdef".repeat(2)}.session`;
const DESCRIPTION = {
  name: NAME,
  startUrl: "https://idp.example.test/login",
  doneUrlPrefix: "https://app.example.test/home",
  cookies: ["sid"],
};

function fakeChild() {
  const posted: unknown[] = [];
  let onMessage: (message: unknown) => void = () => undefined;
  const child: BackendChild = {
    pid: 1,
    postMessage(message) {
      posted.push(message);
      if ((message as { type?: string }).type === "start") {
        queueMicrotask(() => onMessage({ type: "ready", port: 4000 }));
      }
    },
    on: (_event, listener) => void (onMessage = listener),
    once: () => undefined,
    kill: () => true,
  };
  const fork: ForkBackend = () => child;
  return { fork, posted, send: (m: unknown) => onMessage(m) };
}
const start = (child: ReturnType<typeof fakeChild>, loginTimeoutMs?: number) =>
  startBackendProcess({
    fork: child.fork,
    entry: "x",
    origin: "app://pki",
    userData: "/u",
    scopePolicy: undefined,
    loginTimeoutMs,
  });
const requestOf = (child: ReturnType<typeof fakeChild>) =>
  child.posted.find((m) => (m as { type?: string }).type === "login-request") as {
    id: number;
    connectorId: string;
  };

describe("the shell's login request to the backend (I06S-R3)", () => {
  it("asks by connector id and gets the description back by request id", async () => {
    const child = fakeChild();
    const backend = await start(child);
    const asked = backend.loginSettings("inst-1");
    const request = requestOf(child);
    expect(request).toMatchObject({ type: "login-request", connectorId: "inst-1" });
    child.send({ type: "login", id: request.id + 1, ...DESCRIPTION, name: "wrong" });
    child.send({ type: "login", id: request.id, ...DESCRIPTION });
    expect(await asked).toEqual(DESCRIPTION);
  });

  it("none, a malformed answer and a silent backend all give undefined", async () => {
    const child = fakeChild();
    const backend = await start(child, 20);
    const none = backend.loginSettings("a");
    child.send({ type: "login", id: requestOf(child).id, none: true });
    expect(await none).toBeUndefined();

    // a plain-http address outside the loopback does not parse: the request times out
    const bad = backend.loginSettings("b");
    const second = child.posted.filter(
      (m) => (m as { type?: string }).type === "login-request",
    )[1] as {
      id: number;
    };
    child.send({ type: "login", id: second.id, ...DESCRIPTION, startUrl: "http://example.com/x" });
    expect(await bad).toBeUndefined();
  });
});
