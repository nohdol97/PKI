// X02F-C6 (helper half): `createLatest` answers whether a request is still the newest; `createBusy` starts no
// second job while one is out, and starts one again once the first has ended, failed or not.
import { describe, expect, it } from "vitest";
import { createBusy, createLatest } from "./latest.ts";

describe("latest", () => {
  it("is current only until a later request begins", () => {
    const latest = createLatest();
    const first = latest.begin();
    expect(first()).toBe(true);
    const second = latest.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});

describe("busy", () => {
  it("does not start a second job while one is out, and starts one after it ends", async () => {
    const busy = createBusy();
    let release: () => void = () => undefined;
    let started = 0;
    const job = () => {
      started += 1;
      return new Promise<number>((resolve) => (release = () => resolve(started)));
    };
    const first = busy(job);
    expect(busy(job)).toBeUndefined();
    expect(started).toBe(1);
    release();
    await first;
    const third = busy(job);
    expect(third).toBeDefined();
    expect(started).toBe(2);
    release();
    await third;
  });

  it("is released when the job rejects", async () => {
    const busy = createBusy();
    await expect(busy(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(busy(async () => 1)).toBeDefined();
  });
});
