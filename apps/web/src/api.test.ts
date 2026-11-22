// The screens' API client (V01-R3): it calls the shared @pki/contracts routes with the
// session token and accepts only responses that match the shared schemas.
import { describe, expect, it } from "vitest";
import {
  ApiError,
  createApiClient,
  fetchDevSession,
  loadSession,
  DEV_SESSION_PATH,
} from "./api.ts";

const TOKEN = "k".repeat(43);

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, impl: impl as typeof fetch };
}

describe("createApiClient: a deletion the ledger cannot record", () => {
  it("throws an ApiError with the fixed code on 409", async () => {
    const api = createApiClient(
      { baseUrl: "", token: TOKEN },
      fakeFetch(409, { error: "ledger-unwritable" }).impl,
    );
    const error = await api("deleteSource", {
      connectorId: "c",
      namespace: "n",
      externalId: "e",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "ledger-unwritable", status: 409 });
  });
});

describe("createApiClient", () => {
  it("sends the session token to the route's method and path", async () => {
    const fake = fakeFetch(200, { connectors: [] });
    const api = createApiClient({ baseUrl: "http://127.0.0.1:9", token: TOKEN }, fake.impl);
    expect(await api("connectors")).toEqual({ connectors: [] });
    expect(fake.calls).toEqual([
      {
        url: "http://127.0.0.1:9/api/connectors",
        init: { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
      },
    ]);
  });

  it("sends a request body as JSON", async () => {
    const fake = fakeFetch(200, { sources: [] });
    const api = createApiClient({ baseUrl: "", token: TOKEN }, fake.impl);
    await api("searchSources", { query: "등대" });
    expect(fake.calls[0]).toEqual({
      url: "/api/sources/search",
      init: {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ query: "등대" }),
      },
    });
  });

  it("rejects a response that does not match the shared schema", async () => {
    const api = createApiClient({ baseUrl: "", token: TOKEN }, fakeFetch(200, { sources: 1 }).impl);
    await expect(api("sources")).rejects.toThrow();
  });

  it("turns an error response into an ApiError", async () => {
    const fake = fakeFetch(401, { error: "unauthorized" });
    const api = createApiClient({ baseUrl: "", token: TOKEN }, fake.impl);
    const error = await api("status").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "unauthorized", status: 401 });
  });
});

describe("fetchDevSession", () => {
  it("reads the session the dev server hands out", async () => {
    const fake = fakeFetch(200, { baseUrl: "", token: TOKEN });
    expect(await fetchDevSession(fake.impl)).toEqual({ baseUrl: "", token: TOKEN });
    expect(fake.calls[0]?.url).toBe(DEV_SESSION_PATH);
  });

  it.each([
    [200, { baseUrl: "", token: "short" }],
    [200, { token: TOKEN }],
    [403, { baseUrl: "", token: TOKEN }],
  ])("refuses status %i with %j", async (status, body) => {
    await expect(fetchDevSession(fakeFetch(status, body).impl)).rejects.toThrow();
  });
});

// Electron (T06) hands the session over the preload; the browser asks the dev server.
// That source is the only difference between the two (V01-R3).
describe("loadSession", () => {
  it("takes the preload's session when the shell provides one, without fetching", async () => {
    const fake = fakeFetch(200, { baseUrl: "", token: "d".repeat(43) });
    const bridge = { getSession: async () => ({ baseUrl: "", token: TOKEN }) };
    expect(await loadSession(bridge, fake.impl)).toEqual({ baseUrl: "", token: TOKEN });
    expect(fake.calls).toEqual([]);
  });

  it("checks the preload's session against the shared schema", async () => {
    const bridge = { getSession: async () => ({ baseUrl: "", token: "short" }) };
    await expect(loadSession(bridge, fakeFetch(200, {}).impl)).rejects.toThrow();
  });

  it("falls back to the dev server outside the shell", async () => {
    const fake = fakeFetch(200, { baseUrl: "", token: TOKEN });
    expect(await loadSession(undefined, fake.impl)).toEqual({ baseUrl: "", token: TOKEN });
    expect(fake.calls[0]?.url).toBe(DEV_SESSION_PATH);
  });
});
