// I06S-C5 (`connector-example.session.contract`): the session example passes the contract under the login
// and rejected scenarios, rotates the stored session on every request, ends a refused session in
// ConnectorCredentialError. Its two variants are in connector-example.violations.
import { ConnectorCredentialError, type ConnectorContext } from "@pki/contracts";
import { checkConnector, connectorContract, type ConnectorScenario } from "@pki/testkit";
import { describe, expect, it } from "vitest";
import {
  createRotatingSessionConnector,
  SESSION_SLOT,
  sessionTokenOf,
} from "./rotating-session-connector.ts";
import { rotatingSession } from "./synthetic-notes.ts";

/** A fresh origin and scenario per check: the sign-in state is the origin's own. */
function scenario(): ConnectorScenario {
  const { earlier, later, first, wrong } = rotatingSession();
  return {
    config: earlier,
    later,
    credentials: { [SESSION_SLOT]: first },
    login: SESSION_SLOT,
    rejected: { config: earlier, credentials: { [SESSION_SLOT]: wrong } },
  };
}

connectorContract(
  "connector-example (rotating session)",
  createRotatingSessionConnector,
  scenario(),
);

const signal = () => new AbortController().signal;
/** A store of one slot with a write: what the product's accessor is over. */
function slot(initial: string) {
  const held = { value: initial, writes: 0 };
  const context: ConnectorContext = {
    credentials: {
      async read(name) {
        if (name !== SESSION_SLOT) throw new ConnectorCredentialError();
        return held.value;
      },
      async write(name, value) {
        if (name !== SESSION_SLOT) throw new ConnectorCredentialError();
        held.value = value;
        held.writes++;
      },
    },
  };
  return { held, context };
}

describe("connector-example.session.contract", () => {
  it("has no violation under the login and the rejected scenario", async () => {
    expect(await checkConnector(createRotatingSessionConnector, scenario())).toEqual([]);
  });

  it("writes the rotated token back on every request, so the stored session is always the valid one", async () => {
    const { earlier, first, origin } = rotatingSession();
    const { held, context } = slot(first);
    const connector = createRotatingSessionConnector();
    await connector.initialize(earlier, context);
    expect(held.writes).toBe(1);
    const afterInit = sessionTokenOf(held.value);
    await connector.getChanges(null, { limit: 10, signal: signal() });
    expect(held.writes).toBe(2);
    expect(sessionTokenOf(held.value)).not.toBe(afterInit);
    // the first token is no longer valid; the stored one is
    expect(origin.request(sessionTokenOf(first))).toBeUndefined();
    expect(origin.request(sessionTokenOf(held.value))).toBeDefined();
  });

  it("ends a session the origin refuses, and a context without write, in ConnectorCredentialError", async () => {
    const { earlier, wrong } = rotatingSession();
    const refused = slot(wrong);
    await expect(
      createRotatingSessionConnector().initialize(earlier, refused.context),
    ).rejects.toBeInstanceOf(ConnectorCredentialError);
    expect(refused.held.writes).toBe(0);
    const readOnly: ConnectorContext = { credentials: { read: async () => wrong } };
    await expect(
      createRotatingSessionConnector().initialize(earlier, readOnly),
    ).rejects.toBeInstanceOf(ConnectorCredentialError);
    await expect(createRotatingSessionConnector().initialize(earlier)).rejects.toBeInstanceOf(
      ConnectorCredentialError,
    );
  });
});
