// The shell's broker for the backend's normalizer host (I02B-R22, I02B-C50): it starts the bundled host
// on a request from the backend, hands out the two ends of a port, keeps one host per backend, and
// takes nothing from a request but a number. The real processes are in artifact.normalizer.e2e.ts.
import { describe, expect, it, vi } from "vitest";
import { NORMALIZER_HOST_ENTRY } from "./layout.production.ts";
import {
  createNormalizerHostBroker,
  createProductNormalizerHostBroker,
  startNormalizerHostProcess,
  type HostProcess,
  type UtilityLike,
} from "./normalizer-host.ts";

/** How a fake host ends: at once, after a delay, or never. */
type Exits = "at-once" | number | "never";

class FakeHost implements HostProcess {
  pid: number | undefined = 100;
  readonly sent: { message: unknown; transfer: readonly unknown[] | undefined }[] = [];
  killed = false;
  forced = false;
  alive = true;
  private onExit: (() => void)[] = [];
  private readonly afterKill: Exits;
  private readonly afterForce: Exits;
  /** `afterKill`: stays up when `"never"`, like a process that ignored SIGTERM. `afterForce`: likewise. */
  constructor(afterKill: Exits = "at-once", afterForce: Exits = "at-once") {
    this.afterKill = afterKill;
    this.afterForce = afterForce;
  }
  postMessage(message: unknown, transfer?: readonly unknown[]) {
    this.sent.push({ message, transfer });
  }
  once(_event: "exit", listener: () => void) {
    this.onExit.push(listener);
  }
  private endAfter(how: Exits) {
    if (how === "never") return;
    if (how === "at-once") this.exit();
    else setTimeout(() => this.exit(), how);
  }
  /** Set: kill() only works from this call on (a host that ignores the first SIGTERM). */
  workingKillFrom = 1;
  kills = 0;
  kill() {
    this.killed = true;
    this.kills++;
    if (this.kills >= this.workingKillFrom) this.endAfter(this.afterKill);
    return true;
  }
  forceKill() {
    this.forced = true;
    this.endAfter(this.afterForce);
  }
  exit() {
    this.alive = false;
    for (const l of this.onExit.splice(0)) l();
  }
}

function setup(options: { afterKill?: Exits; afterForce?: Exits; forkThrows?: boolean } = {}) {
  const hosts: FakeHost[] = [];
  const toBackend: { message: unknown; transfer: readonly unknown[] | undefined }[] = [];
  const closedPorts: string[] = [];
  /** The most hosts alive at the moment one was started (counting the new one). */
  let maxAlive = 0;
  let channels = 0;
  const broker = createNormalizerHostBroker({
    forkHost: () => {
      if (options.forkThrows) throw new Error("fork failed");
      const host = new FakeHost(options.afterKill, options.afterForce);
      hosts.push(host);
      maxAlive = Math.max(maxAlive, hosts.filter((h) => h.alive).length);
      return host;
    },
    newChannel: () => {
      const n = ++channels;
      return {
        port1: { name: `host-port-${n}`, close: () => closedPorts.push(`host-port-${n}`) },
        port2: { name: `backend-port-${n}`, close: () => closedPorts.push(`backend-port-${n}`) },
      };
    },
    backend: { postMessage: (message, transfer) => toBackend.push({ message, transfer }) },
    killTimeoutMs: 50,
  });
  return { broker, hosts, toBackend, closedPorts, maxAlive: () => maxAlive };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("normalizer host broker", () => {
  it("on a request starts one host, hands the host one end of a port and the backend the other", async () => {
    const { broker, hosts, toBackend } = setup();
    broker.start(7);
    await tick();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.sent).toEqual([
      { message: { type: "port" }, transfer: [expect.objectContaining({ name: "host-port-1" })] },
    ]);
    expect(toBackend).toEqual([
      {
        message: { type: "normalizer-host", id: 7 },
        transfer: [expect.objectContaining({ name: "backend-port-1" })],
      },
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

  it("a host that ignores kill and ends only some time after it is forced: the next one starts after it is gone (never two alive)", async () => {
    // exits 30 ms after forceKill(), asynchronously: the wait after forceKill needs a timer of its own
    const { broker, hosts, maxAlive } = setup({ afterKill: "never", afterForce: 30 });
    broker.start(1);
    await tick();
    broker.start(2);
    await new Promise((r) => setTimeout(r, 250));
    expect(hosts[0]?.forced).toBe(true);
    expect(hosts).toHaveLength(2);
    expect(maxAlive()).toBe(1);
  });

  it("a host that stays alive through kill and forceKill: no second host is started, the request is answered `failed`, its ports are closed", async () => {
    const { broker, hosts, toBackend, closedPorts } = setup({
      afterKill: "never",
      afterForce: "never",
    });
    broker.start(1);
    await tick();
    broker.start(2);
    await new Promise((r) => setTimeout(r, 250));
    expect(hosts).toHaveLength(1);
    expect(toBackend.at(-1)?.message).toEqual({ type: "normalizer-host-failed", id: 2 });
    // no port pair was made for request 2, and the first host's ports went to the backend and the host
    expect(closedPorts).toEqual([]);
  });

  it("a host without a pid cannot be forced: the same answer", async () => {
    const { broker, hosts, toBackend } = setup({ afterKill: "never", afterForce: "never" });
    broker.start(1);
    await tick();
    if (hosts[0]) hosts[0].pid = undefined;
    broker.start(2);
    await new Promise((r) => setTimeout(r, 250));
    expect(hosts).toHaveLength(1);
    expect(toBackend.at(-1)?.message).toEqual({ type: "normalizer-host-failed", id: 2 });
  });

  it("a host that cannot be killed stays held: start, start, start never has a second host, and every later start is answered failed", async () => {
    const { broker, hosts, toBackend, maxAlive } = setup({
      afterKill: "never",
      afterForce: "never",
    });
    broker.start(1);
    await tick();
    broker.start(2);
    await new Promise((r) => setTimeout(r, 250));
    broker.start(3);
    await new Promise((r) => setTimeout(r, 250));
    expect(hosts).toHaveLength(1);
    expect(maxAlive()).toBe(1);
    const failed = toBackend.filter(
      (m) => (m.message as { type: string }).type === "normalizer-host-failed",
    );
    expect(failed.map((m) => (m.message as { id: number }).id)).toEqual([2, 3]);
  });

  it("a host without a pid is held the same way across several requests", async () => {
    const { broker, hosts, maxAlive } = setup({ afterKill: "never", afterForce: "never" });
    broker.start(1);
    await tick();
    if (hosts[0]) hosts[0].pid = undefined;
    for (const id of [2, 3, 4]) {
      broker.start(id);
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(hosts).toHaveLength(1);
    expect(maxAlive()).toBe(1);
  });

  it("end then start, with a host that exits late: the new host is told about only after the old one's exit", async () => {
    const { broker, hosts, toBackend, maxAlive } = setup({ afterKill: 40 });
    broker.start(1);
    await tick();
    broker.end(1);
    broker.start(2);
    await new Promise((r) => setTimeout(r, 250));
    const order = toBackend.map(
      (m) => `${(m.message as { type: string }).type}:${(m.message as { id: number }).id}`,
    );
    expect(order).toEqual(["normalizer-host:1", "normalizer-host-gone:1", "normalizer-host:2"]);
    expect(hosts).toHaveLength(2);
    expect(maxAlive()).toBe(1);
  });

  it("end then start, with a host that cannot be killed: no second host, the start is answered failed", async () => {
    const { broker, hosts, toBackend, maxAlive } = setup({
      afterKill: "never",
      afterForce: "never",
    });
    broker.start(1);
    await tick();
    broker.end(1);
    broker.start(2);
    await new Promise((r) => setTimeout(r, 250));
    expect(hosts).toHaveLength(1);
    expect(maxAlive()).toBe(1);
    expect(toBackend.at(-1)?.message).toEqual({ type: "normalizer-host-failed", id: 2 });
  });

  it("a later request tries to end a host that survived the first ending again, and starts the next host once it is gone", async () => {
    const hosts: FakeHost[] = [];
    const toBackend: unknown[] = [];
    const broker = createNormalizerHostBroker({
      forkHost: () => {
        const host = new FakeHost("at-once", "never");
        host.workingKillFrom = 2;
        hosts.push(host);
        return host;
      },
      newChannel: () => ({ port1: {}, port2: {} }),
      backend: { postMessage: (m) => toBackend.push(m) },
      killTimeoutMs: 50,
    });
    broker.start(1);
    await tick();
    broker.start(2);
    await new Promise((r) => setTimeout(r, 200));
    // the first ending failed: the host is still held, the start was answered failed
    expect(hosts).toHaveLength(1);
    broker.start(3);
    await new Promise((r) => setTimeout(r, 200));
    expect(hosts[0]?.kills).toBe(2);
    expect(hosts).toHaveLength(2);
  });

  it("a host that exits after a failed ending lets the next start through", async () => {
    const { broker, hosts, toBackend } = setup({ afterKill: "never", afterForce: 400 });
    broker.start(1);
    await tick();
    broker.start(2);
    // the wait after forceKill (50 ms) ends before the host does (400 ms): failed
    await new Promise((r) => setTimeout(r, 200));
    expect(toBackend.at(-1)?.message).toEqual({ type: "normalizer-host-failed", id: 2 });
    await new Promise((r) => setTimeout(r, 400));
    broker.start(3);
    await new Promise((r) => setTimeout(r, 100));
    expect(hosts).toHaveLength(2);
  });

  it("when the host cannot be forked the port pair that was made is closed", async () => {
    const { broker, toBackend, closedPorts } = setup({ forkThrows: true });
    broker.start(1);
    await tick();
    expect(toBackend.at(-1)?.message).toEqual({ type: "normalizer-host-failed", id: 1 });
    expect(closedPorts.sort()).toEqual(["backend-port-1", "host-port-1"]);
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

describe("the product's broker (what main.ts builds)", () => {
  it("starts the bundled entry with no argument, an empty environment and no streams, whatever the request carried", async () => {
    const calls: unknown[][] = [];
    const child: UtilityLike = { pid: 5, postMessage: vi.fn(), once: vi.fn(), kill: () => true };
    const broker = createProductNormalizerHostBroker({
      fork: (entry, args, options) => {
        calls.push([entry, args, options]);
        return child;
      },
      entry: NORMALIZER_HOST_ENTRY,
      newChannel: () => ({ port1: {}, port2: {} }),
      backend: { postMessage: vi.fn() },
    });
    // the request is a number: there is nothing else to pass on
    broker.start(1);
    await tick();
    expect(calls).toEqual([
      [NORMALIZER_HOST_ENTRY, [], { env: {}, serviceName: "PKI normalizer", stdio: "ignore" }],
    ]);
  });

  it("the production layout's entry is the bundled backend/host.js next to main.js", () => {
    expect(NORMALIZER_HOST_ENTRY.endsWith("/backend/host.js")).toBe(true);
  });
});
