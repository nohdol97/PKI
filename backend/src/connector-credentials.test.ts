// I06-C1 ① `connector-credentials.name` (I06-R3): the stored name of one credential slot.
import { isConnectorCredentialSecret, SecretNameSchema } from "@pki/contracts";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connectorCredentialName } from "./connector-credentials.ts";

describe("connectorCredentialName", () => {
  it("is connector.<first 32 hex of sha256(kind + newline + id)>.<slot>", () => {
    const hex = createHash("sha256").update("synthetic-kind\ninst-1").digest("hex").slice(0, 32);
    expect(connectorCredentialName("synthetic-kind", "inst-1", "token")).toBe(
      `connector.${hex}.token`,
    );
  });

  it("passes the name schema and the predicate, at the longest kind, ID and slot", () => {
    for (const [kind, id, slot] of [
      ["a-kind", "inst-1", "token"],
      ["k".repeat(64), "i".repeat(128), "s".repeat(16)],
      ["k", "ID with spaces / and ünïcode ✓", "a1-b2"],
    ] as const) {
      const name = connectorCredentialName(kind, id, slot);
      expect(SecretNameSchema.safeParse(name).success).toBe(true);
      expect(isConnectorCredentialSecret(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(64);
    }
  });

  it("differs when any one of kind, ID or slot differs", () => {
    const base = connectorCredentialName("kind-a", "inst-1", "token");
    expect(connectorCredentialName("kind-b", "inst-1", "token")).not.toBe(base);
    expect(connectorCredentialName("kind-a", "inst-2", "token")).not.toBe(base);
    expect(connectorCredentialName("kind-a", "inst-1", "other")).not.toBe(base);
    // the newline joins kind and ID so a boundary shift is a different name
    expect(connectorCredentialName("kind-a", "b", "token")).not.toBe(
      connectorCredentialName("kind-", "ab", "token"),
    );
    expect(connectorCredentialName("kind-a", "inst-1", "token")).toBe(base); // deterministic
  });

  it.each(["", "Token", "1token", "-token", "to.ken", "a".repeat(17), "to ken", "token\n"])(
    "refuses the slot %j rather than build a name the shell would not answer",
    (slot) => {
      expect(() => connectorCredentialName("kind-a", "inst-1", slot)).toThrow(RangeError);
    },
  );
});
