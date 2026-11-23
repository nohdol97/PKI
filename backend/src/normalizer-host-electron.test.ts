// Spawn adapter ⓑ, the backend's side (I02B-R22, I02B-C50): the request it sends the shell and the way it
// takes the shell's answer and the message port. The shell's side and the real processes are in
// apps/desktop (normalizer-host.test.ts, artifact.normalizer.e2e.ts).
import { describe, expect, it } from "vitest";
import { electronHostChannel, type HostPort } from "./normalizer-host-electron.ts";

class FakePort implements HostPort {
  readonly sent: unknown[] = [];
  started = false;
  private messages: ((event: { data: unknown }) => void)[] = [];
  private closers: (() => void)[] = [];
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: string, listener: (...args: never[]) => void): void {
    if (event === "message") this.messages.push(listener as never);
    else this.closers.push(listener as never);
  }
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  start() {
    this.started = true;
  }
  close() {
    for (const l of this.closers) l();
  }
  receive(data: unknown) {
    for (const l of this.messages) l({ data });
  }
}

function setup() {
  const posted: unknown[] = [];
  const channel = electronHostChannel((message) => posted.push(message));
  return { channel, posted };
}

describe("electronHostChannel", () => {
  it("asks the shell with a number and nothing else", () => {
    const { channel, posted } = setup();
    void channel.spawner.spawn().catch(() => undefined);
    void channel.spawner.spawn().catch(() => undefined);
    expect(posted).toEqual([
      { type: "normalizer-host-start", id: 1 },
      { type: "normalizer-host-start", id: 2 },
    ]);
  });

  it("the shell's answer with a port makes a host handle: the port is started and carries both ways", async () => {
    const { channel } = setup();
    const spawning = channel.spawner.spawn();
    const port = new FakePort();
    expect(channel.deliver({ type: "normalizer-host", id: 1 }, [port])).toBe(true);
    const handle = await spawning;
    expect(port.started).toBe(true);
    handle.post({ hello: 1 });
    expect(port.sent).toEqual([{ hello: 1 }]);
    const heard: unknown[] = [];
    handle.onMessage((m) => heard.push(m));
    port.receive({ type: "ready" });
    expect(heard).toEqual([{ type: "ready" }]);
  });

  it("kill asks the shell to end that host", async () => {
    const { channel, posted } = setup();
    const spawning = channel.spawner.spawn();
    channel.deliver({ type: "normalizer-host", id: 1 }, [new FakePort()]);
    (await spawning).kill();
    expect(posted.at(-1)).toEqual({ type: "normalizer-host-end", id: 1 });
  });

  it("the host is gone when the shell says so or the port closes, and each listener hears it once", async () => {
    const { channel } = setup();
    const first = channel.spawner.spawn();
    const port1 = new FakePort();
    channel.deliver({ type: "normalizer-host", id: 1 }, [port1]);
    const handle1 = await first;
    let heard1 = 0;
    handle1.onGone(() => heard1++);
    channel.deliver({ type: "normalizer-host-gone", id: 1 });
    port1.close();
    expect(heard1).toBe(1);

    const second = channel.spawner.spawn();
    const port2 = new FakePort();
    channel.deliver({ type: "normalizer-host", id: 2 }, [port2]);
    const handle2 = await second;
    let heard2 = 0;
    handle2.onGone(() => heard2++);
    port2.close();
    expect(heard2).toBe(1);
  });

  it("a failed answer, or an answer without a port, rejects the request", async () => {
    const { channel } = setup();
    const failed = channel.spawner.spawn();
    expect(channel.deliver({ type: "normalizer-host-failed", id: 1 })).toBe(true);
    await expect(failed).rejects.toThrow();
    const noPort = channel.spawner.spawn();
    expect(channel.deliver({ type: "normalizer-host", id: 2 }, [])).toBe(true);
    await expect(noPort).rejects.toThrow();
  });

  it.each([
    null,
    "text",
    { type: "secret", id: 1, state: "missing" },
    { type: "normalizer-host", id: "1" },
    { type: "normalizer-host", id: 1, extra: 1 },
    { type: "start", token: "x" },
  ])("does not take %j: it is not the shell's answer about a host", (message) => {
    const { channel } = setup();
    expect(channel.deliver(message, [new FakePort()])).toBe(false);
  });

  it("close ends every live host", async () => {
    const { channel, posted } = setup();
    const spawning = channel.spawner.spawn();
    channel.deliver({ type: "normalizer-host", id: 1 }, [new FakePort()]);
    await spawning;
    channel.close();
    expect(posted.at(-1)).toEqual({ type: "normalizer-host-end", id: 1 });
  });
});
