// I06-C18 (`connector-example.credentialed.contract`): the example that reads its
// token through the accessor passes the contract under both credential scenarios,
// refuses a wrong token with ConnectorCredentialError, and keeps nothing in the
// package that looks like a real credential.
import {
  ConnectorCredentialError,
  HEALTH_REASON_CREDENTIAL_REJECTED,
  type Connector,
  type ConnectorContext,
} from "@pki/contracts";
import { checkConnector, connectorContract, type ConnectorScenario } from "@pki/testkit";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createCredentialedConnector } from "./credentialed-connector.ts";
import {
  CREDENTIALED_EARLIER,
  CREDENTIALED_LATER,
  SYNTHETIC_TOKEN,
  SYNTHETIC_WRONG_TOKEN,
} from "./synthetic-notes.ts";

const scenario: ConnectorScenario = {
  config: CREDENTIALED_EARLIER,
  later: CREDENTIALED_LATER,
  credentials: { token: SYNTHETIC_TOKEN },
  rejected: { config: CREDENTIALED_EARLIER, credentials: { token: SYNTHETIC_WRONG_TOKEN } },
};

connectorContract("connector-example (credentialed)", createCredentialedConnector, scenario);

const signal = () => new AbortController().signal;
/** An accessor whose value the test can change: the origin's token expiring later. */
const accessor = (initial: string) => {
  const current = { token: initial };
  const context: ConnectorContext = {
    credentials: {
      async read(slot) {
        if (slot !== "token") throw new ConnectorCredentialError();
        return current.token;
      },
    },
  };
  return { current, context };
};
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("connector-example.credentialed.contract", () => {
  it("has no violation under the credentials and the rejected scenario", async () => {
    expect(await checkConnector(createCredentialedConnector, scenario)).toEqual([]);
  });

  it("refuses a wrong token at initialize with ConnectorCredentialError", async () => {
    const { context } = accessor(SYNTHETIC_WRONG_TOKEN);
    const error = await failure(
      createCredentialedConnector().initialize(CREDENTIALED_EARLIER, context),
    );
    expect(error).toBeInstanceOf(ConnectorCredentialError);
  });

  it("ends with ConnectorCredentialError when the product handed no context", async () => {
    const error = await failure(createCredentialedConnector().initialize(CREDENTIALED_EARLIER));
    expect(error).toBeInstanceOf(ConnectorCredentialError);
  });

  it("reads the token on every call: a token that expires later stops the next read and the health check", async () => {
    const { current, context } = accessor(SYNTHETIC_TOKEN);
    const connector: Connector = createCredentialedConnector();
    await connector.initialize(CREDENTIALED_EARLIER, context);
    expect(await connector.healthCheck()).toEqual({ state: "ok" });
    expect(
      (await connector.getChanges(null, { limit: 10, signal: signal() })).changes,
    ).toHaveLength(4);
    current.token = SYNTHETIC_WRONG_TOKEN;
    expect(await connector.healthCheck()).toEqual({
      state: "unavailable",
      reason: HEALTH_REASON_CREDENTIAL_REJECTED,
    });
    const error = await failure(connector.getChanges(null, { limit: 10, signal: signal() }));
    expect(error).toBeInstanceOf(ConnectorCredentialError);
  });

  it("passes on what the accessor refuses", async () => {
    const context: ConnectorContext = {
      credentials: {
        read: async () => {
          throw new ConnectorCredentialError();
        },
      },
    };
    const error = await failure(
      createCredentialedConnector().initialize(CREDENTIALED_EARLIER, context),
    );
    expect(error).toBeInstanceOf(ConnectorCredentialError);
  });

  it("keeps only made-up tokens in the package: every token value starts with synthetic-", () => {
    const dir = resolve(import.meta.dirname, "../..");
    const files = (path: string): string[] =>
      readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() && entry.name !== "node_modules"
          ? files(join(path, entry.name))
          : entry.name.endsWith(".ts")
            ? [join(path, entry.name)]
            : [],
      );
    const values = files(dir).flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(/\b\w*[Tt][Oo][Kk][Ee][Nn]\w*\s*[:=]\s*"([^"]*)"/g),
      ].map((m) => m[1] as string),
    );
    // An empty string is a variable not yet set, not a value.
    const set = values.filter((value) => value !== "");
    expect(set.length).toBeGreaterThanOrEqual(2);
    for (const value of set) expect(value.startsWith("synthetic-")).toBe(true);
  });
});
