// I06S-R3: the shell's login request is exactly an id and a connector id, and the answer is the
// description with the stored name or `none`.
import { describe, expect, it } from "vitest";
import { loginAnswer, loginRequest } from "./login-request.ts";

describe("loginRequest / loginAnswer (I06S-R3)", () => {
  it("takes exactly type, id and connectorId", () => {
    expect(loginRequest({ type: "login-request", id: 3, connectorId: "inst-1" })).toEqual({
      id: 3,
      connectorId: "inst-1",
    });
    for (const bad of [
      { type: "login-request", id: 3, connectorId: "inst-1", url: "https://x.test" },
      { type: "login-request", id: 0, connectorId: "inst-1" },
      { type: "login-request", id: 3, connectorId: "" },
      { type: "reveal-request", id: 3, connectorId: "inst-1" },
      null,
      "login-request",
    ]) {
      expect(loginRequest(bad)).toBeUndefined();
    }
  });

  it("answers the description with its stored name, or none", () => {
    const login = {
      name: `connector.${"0".repeat(32)}.session`,
      startUrl: "https://idp.example.test/login",
      doneUrlPrefix: "https://app.example.test/home",
      cookies: ["sid"],
    };
    expect(loginAnswer(3, login)).toEqual({ type: "login", id: 3, ...login });
    expect(loginAnswer(3, undefined)).toEqual({ type: "login", id: 3, none: true });
  });
});
