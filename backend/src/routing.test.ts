// Routes match on path and method together; 405 only when the path exists
// under another method.
import { describe, expect, it } from "vitest";
import { matchRoute } from "./routing.ts";

const table = {
  read: { method: "GET", path: "/api/settings" },
  write: { method: "PUT", path: "/api/settings" },
} as const;

describe("matchRoute", () => {
  it("reaches each of two routes sharing a path", () => {
    expect(matchRoute(table, "GET", "/api/settings")).toBe("read");
    expect(matchRoute(table, "PUT", "/api/settings")).toBe("write");
  });

  it("returns method-not-allowed for a known path with an unknown method", () => {
    expect(matchRoute(table, "POST", "/api/settings")).toEqual({ error: "method-not-allowed" });
  });

  it("returns not-found for an unknown path", () => {
    expect(matchRoute(table, "GET", "/api/nope")).toEqual({ error: "not-found" });
  });
});
