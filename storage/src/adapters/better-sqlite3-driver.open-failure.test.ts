// RVS-C5: a connection whose setting step throws is closed before the error leaves `openBetterSqlite3`.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBetterSqlite3 } from "./better-sqlite3-driver.ts";

afterEach(() => vi.restoreAllMocks());

describe("better-sqlite3 driver open failure", () => {
  it("closes the connection once and rethrows when a pragma throws", () => {
    const failure = new Error("pragma failed");
    vi.spyOn(Database.prototype, "pragma").mockImplementation(() => {
      throw failure;
    });
    const close = vi.spyOn(Database.prototype, "close");
    expect(() => openBetterSqlite3(":memory:")).toThrow(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
