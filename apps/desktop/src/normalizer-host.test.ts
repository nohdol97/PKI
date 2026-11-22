// The shell's broker for the backend's normalizer host (I02B-R22, I02B-C50): it starts the bundled host
// on a request from the backend, hands out the two ends of a port, keeps one host per backend, and
// takes nothing from a request but a number. The real processes are in artifact.normalizer.e2e.ts.
import { describe, expect, it, vi } from "vitest";
import {
  createNormalizerHostBroker,
  startNormalizerHostProcess,
  type HostProcess,
  type UtilityLike,
} from "./normalizer-host.ts";

class FakeHost implements HostProcess {
  pid = 100;
  readonly sent: { message: unknown; transfer: readonly unknown[] | undefined }[] = [];
  killed = false;
  forced = false;
  private onExit: (() => void)[] = [];
  private readonly ignoresKill: boolean;
  /** `ignoresKill`: stays up until forced, like a process that ignored SIGTERM. */
  constructor(ignoresKill = false) {
    this.ignoresKill = ignoresKill;
  }
  postMessage(message: unknown, transfer?: readonly unknown[]) {
    this.sent.push({ message, transfer });
  }
  once(_event: "exit", listener: () => void) {
    this.onExit.push(listener);
  }
  kill() {
    this.killed = true;
    if (!this.ignoresKill) this.exit();
    return true;
  }
  forceKill() {
    this.forced = true;
    this.exit();
  }
  exit() {
    for (const l of this.onExit.splice(0)) l();
  }
}

function setup(options: { ignoresKill?: boolean } = {}) {
  const hosts: FakeHost[] = [];
  const toBackend: { message: unknown; transfer: readonly unknown[] | undefined }[] = [];
  let channels = 0;
  const broker = createNormalizerHostBroker({
    forkHost: () => {
      const host = new FakeHost(options.ignoresKill);
      hosts.push(host);
      return host;
    },
    newChannel: () => ({ port1: `host-port-${++channels}`, port2: `backend-port-${channels}` }),
    backend: { postMessage: (message, transfer) => toBackend.push({ message, transfer }) },
    killTimeoutMs: 50,
  });
  return { broker, hosts, toBackend };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("normalizer host broker", () => {
  it("on a request starts one host, hands the host one end of a port and the backend the other", async () => {
    const { broker, hosts, toBackend } = setup();
    broker.start(7);
    await tick();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.sent).toEqual([{ message: { type: "port" }, transfer: ["host-port-1"] }]);
    expect(toBackend).toEqual([
      { message: { type: "normalizer-host", id: 7 }, transfer: ["backend-port-1"] },
    ]);
  });

  it("ends the previous host before it starts the next: never two alive", async () => {
    const { broker, hosts } = setup();
    broker.start(1);
    await tick();
    broker.start(2);
    await tick();
    await tick();
    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.killed).toBe(true);
    // the first was gone before the second was started
    expect(hosts[0]?.sent).toHaveLength(1);
  });

  it("a host that ignores kill is forced, and the next one starts after it is gone", async () => {
    const { broker, hosts } = setup({ ignoresKill: true });
    broker.start(1);
    await tick();
    broker.start(2);
    await new Promise((r) => setTimeout(r, 120));
    expect(hosts[0]?.forced).toBe(true);
    expect(hosts).toHaveLength(2);
  });

  it("while one start is in progress only the newest waiting request is kept; the others are told it failed", async () => {
    const { broker, hosts, toBackend } = setup();
    for (let id = 1; id <= 100; id++) broker.start(id);
    await new Promise((r) => setTimeout(r, 50));
    const failed = toBackend.filter(
      (m) => (m.message as { type: string }).type === "normalizer-host-failed",
    );
    const started = toBackend.filter(
      (m) => (m.message as { type: string }).type === "normalizer-host",
    );
    expect(started.map((m) => (m.message as { id: number }).id)).toEqual([1, 100]);
    expect(failed).toHaveLength(98);
    expect(hosts).toHaveLength(2);
    // never more than one host alive at once: each earlier one was killed
    expect(hosts.slice(0, -1).every((h) => h.killed)).toBe(true);
  });

  it("tells the backend which host went when its process exits", async () => {
    const { broker, hosts, toBackend } = setup();
    broker.start(3);
    await tick();
    hosts[0]?.exit();
    expect(toBackend.at(-1)?.message).toEqual({ type: "normalizer-host-gone", id: 3 });
  });

  it("end() ends the host that request named, and no other", async () => {
    const { broker, hosts } = setup();
    broker.start(3);
    await tick();
    broker.end(99);
    expect(hosts[0]?.killed).toBe(false);
    broker.end(3);
    expect(hosts[0]?.killed).toBe(true);
  });

  it("stop() ends the host and starts no more; a request after it starts nothing", async () => {
    const { broker, hosts } = setup();
    broker.start(1);
    await tick();
    broker.stop();
    expect(hosts[0]?.killed).toBe(true);
    broker.start(2);
    await tick();
    expect(hosts).toHaveLength(1);
  });

  it("a host that cannot be started is a `failed` answer, not a throw", async () => {
    const toBackend: unknown[] = [];
    const broker = createNormalizerHostBroker({
      forkHost: () => {
        throw new Error("fork failed");
      },
      newChannel: () => ({ port1: 1, port2: 2 }),
      backend: { postMessage: (m) => toBackend.push(m) },
    });
    broker.start(5);
    await tick();
    expect(toBackend).toEqual([{ type: "normalizer-host-failed", id: 5 }]);
  });
});

describe("startNormalizerHostProcess", () => {
  it("forks the entry it is given with the arguments it is given, an empty environment and no streams", () => {
    const calls: unknown[][] = [];
    const child: UtilityLike = {
      pid: 5,
      postMessage: vi.fn(),
      once: vi.fn(),
      kill: () => true,
    };
    startNormalizerHostProcess((entry, args, options) => {
      calls.push([entry, args, options]);
      return child;
    }, "/app/backend/host.js");
    expect(calls).toEqual([
      ["/app/backend/host.js", [], { env: {}, serviceName: "PKI normalizer", stdio: "ignore" }],
    ]);
  });
});
