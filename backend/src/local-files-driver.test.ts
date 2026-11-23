// I02B-T04 T7 (I02B-R17~R20; C8, C15): the local file driver. The watch signal carries no content, only
// "walk soon": debounced into at most one registered sync per `watch.maxWaitMs`; one at the start when a
// location is read; a location that cannot be watched is shown unwatched. Whatever the signals do, the
// final full walk gives the same sources (C8). Fake clock, fake timers, a fake watcher.
import {
  closeLocation,
  insertLocation,
  listLocations,
  newLocalId,
  type LocalLocation,
} from "@pki/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalFilesDriver } from "./local-files-driver.ts";
import { deletes, upserts, world, type World } from "./local-files-connector.test-support.ts";
import { readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Change } from "@pki/contracts";

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});
const make = () => {
  const w = world();
  worlds.push(w);
  return w;
};

/** Fake timers on a fake clock: `advance` fires what is due, in order. */
function fakeTime() {
  let now = 0;
  const due: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => now,
    timers: {
      set(fn: () => void, ms: number) {
        const id = next++;
        due.push({ at: now + ms, fn, id });
        return id;
      },
      clear(handle: unknown) {
        const at = due.findIndex((d) => d.id === handle);
        if (at >= 0) due.splice(at, 1);
      },
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        due.sort((a, b) => a.at - b.at);
        const first = due[0];
        if (!first || first.at > end) break;
        due.shift();
        now = first.at;
        first.fn();
      }
      now = end;
    },
  };
}

/** A watcher factory: one handle per watched path, `emit` is the OS signal; a path in `refuse` cannot be watched. */
function fakeWatch(refuse: Set<string> = new Set()) {
  const signals = new Map<string, () => void>();
  return {
    signals,
    watch(path: string, onSignal: () => void) {
      if (refuse.has(path)) throw new Error("cannot watch");
      signals.set(path, onSignal);
      return { close: () => void signals.delete(path) };
    },
  };
}

function driverOver(w: World, over: { refuse?: Set<string>; revoked?: () => void } = {}) {
  const time = fakeTime();
  const watcher = fakeWatch(over.refuse);
  const registered: number[] = [];
  const driver = createLocalFilesDriver({
    db: w.db,
    registerSync: () => void registered.push(time.now()),
    revoke: { resume: over.revoked ?? (() => undefined) },
    watch: watcher.watch,
    timers: time.timers,
    now: time.now,
    limits: () => ({ quietMs: 2_000, maxWaitMs: 30_000 }),
  });
  return { driver, time, watcher, registered };
}
const stateOf = (w: World, id = w.locationId) =>
  listLocations(w.db).find((l) => l.id === id) as LocalLocation;

describe("C15 the driver", () => {
  it("100 signals closer than quietMs register at most one sync per maxWaitMs", () => {
    const w = make();
    const { driver, time, watcher, registered } = driverOver(w);
    driver.start(false);
    registered.length = 0; // the start's own registration is the next case
    const signal = watcher.signals.get(w.root) as () => void;
    for (let i = 0; i < 100; i++) {
      signal();
      time.advance(1_000);
    }
    time.advance(5_000);
    expect(registered.length).toBeGreaterThanOrEqual(1);
    expect(registered.length).toBeLessThanOrEqual(Math.ceil(100_000 / 30_000));
    for (let i = 1; i < registered.length; i++) {
      expect((registered[i] as number) - (registered[i - 1] as number)).toBeGreaterThanOrEqual(
        30_000,
      );
    }
  });

  it("starts one sync with a read location and none without; a location that cannot be watched is unwatched", () => {
    const w = make();
    const refused = driverOver(w, { refuse: new Set([w.root]) });
    refused.driver.start(false);
    expect(refused.registered).toHaveLength(1);
    expect(refused.driver.watching(w.locationId)).toBe(false);

    const none = make();
    closeLocation(none.db, none.locationId, "paused", null);
    const idle = driverOver(none);
    idle.driver.start(false);
    expect(idle.registered).toHaveLength(0);
    expect(idle.driver.watching(none.locationId)).toBe(false);

    const watched = make();
    const ok = driverOver(watched);
    ok.driver.start(false);
    expect(ok.driver.watching(watched.locationId)).toBe(true);
    ok.driver.stop();
    expect(ok.driver.watching(watched.locationId)).toBe(false);
  });
});

describe("C41 the start after a restore (M8)", () => {
  it("pauses every read or returning location as restored before any sync, continues a revocation, and an ordinary start leaves states", () => {
    const w = make();
    const other = newLocalId();
    insertLocation(w.db, {
      id: other,
      type: "folder",
      displayPath: "/o",
      realPath: "/o",
      rootDev: "1",
      rootIno: "2",
      createdAt: "2026-11-23T00:00:00.000Z",
    });
    closeLocation(w.db, other, "unavailable", "root-missing");
    let resumed = 0;
    const ordinary = driverOver(w, { revoked: () => void (resumed += 1) });
    ordinary.driver.start(false);
    expect([stateOf(w).state, stateOf(w, other).state]).toEqual(["active", "unavailable"]);
    ordinary.driver.stop();

    const restored = driverOver(w, { revoked: () => void (resumed += 1) });
    restored.driver.start(true);
    expect(stateOf(w)).toMatchObject({ state: "paused", stateReason: "restored" });
    // an unplugged disk comes back by itself at the next pass, so a restored start stops it too (R34)
    expect(stateOf(w, other)).toMatchObject({ state: "paused", stateReason: "restored" });
    expect(restored.registered).toHaveLength(0);
    expect(resumed).toBe(2);
  });
});

describe("C8 the signals never change the result", () => {
  /** A fixed-seed sequence of 60 changes on the folder; the same for every mode. */
  function script(seed: number) {
    let s = seed;
    const rnd = (n: number) => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s % n);
    const ops: { kind: string; a: string; b: string }[] = [];
    const names = Array.from({ length: 8 }, (_, i) => `n${i}.md`);
    for (let i = 0; i < 60; i++) {
      ops.push({
        kind: ["create", "edit", "rename", "move", "delete", "recreate"][rnd(6)] as string,
        a: names[rnd(names.length)] as string,
        b: names[rnd(names.length)] as string,
      });
    }
    return ops;
  }

  async function run(
    mode: "none" | "half" | "all",
  ): Promise<{ sources: [string, string][]; disk: [string, string][] }> {
    const w = make();
    const { driver, time, watcher } = driverOver(w);
    driver.start(false);
    const signal = watcher.signals.get(w.root) as () => void;
    const sources = new Map<string, { path: string; body: string }>();
    const apply = (changes: readonly Change[]) => {
      for (const r of upserts(changes)) {
        sources.set(r.externalId, {
          path: (r.metadata as { relativePath: string }).relativePath,
          body: r.body,
        });
      }
      for (const d of deletes(changes)) if (d.kind === "delete") sources.delete(d.externalId);
    };
    const onDisk = (name: string) => join(w.root, name);
    const exists = (name: string) => {
      try {
        readFileSync(onDisk(name));
        return true;
      } catch {
        return false;
      }
    };
    let version = 0;
    let n = 0;
    for (const op of script(7)) {
      version += 1;
      if (op.kind === "create" || op.kind === "recreate") {
        w.write(op.a, `# ${op.a}\n\nbody ${op.a} v${version}\n`);
      } else if (op.kind === "edit" && exists(op.a)) {
        w.write(op.a, `# ${op.a}\n\nbody ${op.a} v${version}\n`);
      } else if ((op.kind === "rename" || op.kind === "move") && exists(op.a) && !exists(op.b)) {
        renameSync(onDisk(op.a), onDisk(op.b));
      } else if (op.kind === "delete" && exists(op.a)) {
        unlinkSync(onDisk(op.a));
      }
      n += 1;
      const delivered = mode === "all" || (mode === "half" && n % 2 === 0);
      if (delivered) {
        signal();
        time.advance(2_000);
        apply(await w.sync());
      }
    }
    // the end: a full walk and its sync, settled
    apply(await w.sync({ cursor: null }));
    apply(await w.sync({ cursor: null }));
    apply(await w.sync({ cursor: null }));
    const disk = readdirSync(w.root)
      .filter((name) => name.endsWith(".md"))
      .map((name) => [name, readFileSync(onDisk(name), "utf8")] as [string, string])
      .sort();
    return {
      sources: [...sources.values()].map((s) => [s.path, s.body] as [string, string]).sort(),
      disk,
    };
  }

  it("with no signal, half of them or all of them the sources are the same and are the folder's files", async () => {
    const none = await run("none");
    const half = await run("half");
    const all = await run("all");
    expect(half.sources).toEqual(none.sources);
    expect(all.sources).toEqual(none.sources);
    // and they are the folder's files, each with its current content (I02B-R18)
    expect(none.sources.length).toBeGreaterThan(0);
    expect(none.sources.map(([path]) => path)).toEqual(none.disk.map(([path]) => path));
    for (const [i, [, body]] of none.sources.entries()) {
      const marker = /body (\S+) (v\d+)/.exec(none.disk[i]?.[1] ?? "");
      expect(body).toContain(`${marker?.[1]} ${marker?.[2]}`);
    }
  });
});
