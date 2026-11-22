// I06-C1 ① `connector-credentials.name` (I06-R3): the stored name of one credential slot.
import {
  ConnectorCredentialError,
  isConnectorCredentialError,
  isConnectorCredentialSecret,
  SecretNameSchema,
} from "@pki/contracts";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  connectorCredentialName,
  createCredentialAccess,
  credentialSlotsValid,
  declareCredentials,
  CREDENTIAL_CHECK_TIMEOUT_MS,
  MAX_CREDENTIAL_SLOTS,
  reasonOfPresence,
} from "./connector-credentials.ts";
import { INITIALIZE_TIMEOUT_MS } from "./connectors.ts";
import { DEFAULT_HEARTBEAT_MS, DEFAULT_LEASE_MS } from "./job-runner.ts";

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

describe("connectorCredentialName: the kind (I06-R3, I05-R7)", () => {
  it("refuses a kind with a newline: the joined text would read two ways", () => {
    expect(() => connectorCredentialName("kind\nx", "inst", "token")).toThrow(RangeError);
  });
});

describe("credential declarations (I06-R2)", () => {
  it("credentialSlotsValid: the shape, distinct, at most MAX_CREDENTIAL_SLOTS", () => {
    expect(MAX_CREDENTIAL_SLOTS).toBe(8);
    expect(credentialSlotsValid(["a", "b-1", "c".repeat(16)])).toBe(true);
    expect(credentialSlotsValid(Array.from({ length: 8 }, (_, i) => `s${i}`))).toBe(true);
    expect(credentialSlotsValid(Array.from({ length: 9 }, (_, i) => `s${i}`))).toBe(false);
    expect(credentialSlotsValid(["a", "a"])).toBe(false);
    expect(credentialSlotsValid(["A"])).toBe(false);
    expect(credentialSlotsValid("a")).toBe(false);
  });

  it("declareCredentials checks the slots before it builds a name: a bad slot is invalid, never a throw", () => {
    expect(declareCredentials("k", "i", undefined)).toEqual([]);
    expect(declareCredentials("k", "i", ["Bad Slot"])).toBe("invalid");
    expect(declareCredentials("k", "i", ["a", "a"])).toBe("invalid");
    expect(
      declareCredentials(
        "k",
        "i",
        Array.from({ length: 9 }, (_, i) => `s${i}`),
      ),
    ).toBe("invalid");
    expect(declareCredentials("k\nk", "i", ["token"])).toBe("invalid");
    expect(declareCredentials("k", "i", ["token"])).toEqual([
      { slot: "token", name: connectorCredentialName("k", "i", "token") },
    ]);
  });

  it("reasonOfPresence: a store that cannot answer outranks a missing value", () => {
    expect(reasonOfPresence(["present", "missing", "unavailable"])).toBe(
      "credential-store-unavailable",
    );
    expect(reasonOfPresence(["present", "missing"])).toBe("credential-missing");
    expect(reasonOfPresence(["present"])).toBeUndefined();
  });
});

describe("the accessor's refusals and the reason it judges (I06-R7, R9)", () => {
  const declaration = declareCredentials("k", "i", ["token"]) as { slot: string; name: string }[];
  const present = {
    read: async () => ({ state: "present" as const, value: "synthetic-value-1" }),
    has: async () => "present" as const,
  };

  it("a read of a value of the wrong shape or an answer that throws is refused and marks the slot unreadable", async () => {
    const wrongShape = createCredentialAccess(declaration, {
      read: async () => ({ state: "present", value: "" }) as never,
      has: async () => "present",
    });
    await expect(wrongShape.credentials.read("token")).rejects.toBeInstanceOf(
      ConnectorCredentialError,
    );
    expect(await wrongShape.judge()).toBe("credential-unreadable");
    const throwing = createCredentialAccess(declaration, {
      read: async () => Promise.reject(new Error("synthetic-secret-text")),
      has: async () => "present",
    });
    await expect(throwing.credentials.read("token")).rejects.toThrow(
      "connector credential unusable",
    );
  });

  it("a revoked accessor refuses without asking the store, and a read cut while it waited returns no value", async () => {
    const read = vi.fn(present.read);
    const access = createCredentialAccess(declaration, { read, has: present.has });
    access.revoke();
    await expect(access.credentials.read("token")).rejects.toBeInstanceOf(ConnectorCredentialError);
    expect(read).not.toHaveBeenCalled();
    let answer!: (v: unknown) => void;
    const slow = createCredentialAccess(declaration, {
      read: () => new Promise((r) => (answer = r)) as never,
      has: present.has,
    });
    const pending = slow.credentials.read("token");
    await new Promise<void>((r) => setImmediate(r)); // the read has asked the store
    slow.revoke();
    answer({ state: "present", value: "synthetic-value-1" });
    await expect(pending).rejects.toBeInstanceOf(ConnectorCredentialError);
  });

  it("the judge: no declaration or an undeclared read is none; a store that cannot answer comes before a missing mark; rejected only when nothing else explains it", async () => {
    expect(await createCredentialAccess([], present).judge()).toBeUndefined();
    const undeclared = createCredentialAccess(declaration, present);
    await undeclared.credentials.read("other").catch(() => undefined);
    expect(await undeclared.judge()).toBeUndefined();
    const clean = createCredentialAccess(declaration, present);
    await clean.credentials.read("token");
    expect(await clean.judge()).toBe("credential-rejected");
    let storeUp = true;
    const flaky = createCredentialAccess(declaration, {
      read: async () => ({ state: "missing" }),
      has: async () => (storeUp ? "present" : "unavailable"),
    });
    await flaky.credentials.read("token").catch(() => undefined);
    expect(await flaky.judge()).toBe("credential-missing");
    storeUp = false;
    expect(await flaky.judge()).toBe("credential-store-unavailable");
  });

  it("the refusal is the contract's error and is recognised by instanceof and by its fixed name and message", async () => {
    const access = createCredentialAccess(declaration, present);
    const error = await access.credentials.read("nope").catch((e: unknown) => e);
    expect(isConnectorCredentialError(error)).toBe(true);
    const copy = Object.assign(new Error("connector credential unusable"), {
      name: "ConnectorCredentialError",
    });
    expect(isConnectorCredentialError(copy)).toBe(true);
    expect(
      isConnectorCredentialError(
        Object.assign(new Error("other"), { name: "ConnectorCredentialError" }),
      ),
    ).toBe(false);
    expect(isConnectorCredentialError(new Error("connector credential unusable"))).toBe(false);
    expect(isConnectorCredentialError("connector credential unusable")).toBe(false);
  });
});

describe("the wait for a judgement fits the job's lease (I06-R10)", () => {
  it("one presence check is shorter than the instance's initialize limit and than a heartbeat of the job lease", () => {
    expect(CREDENTIAL_CHECK_TIMEOUT_MS).toBeLessThan(INITIALIZE_TIMEOUT_MS);
    // the judge asks the store once (one limit) while the heartbeat keeps the lease
    expect(CREDENTIAL_CHECK_TIMEOUT_MS).toBeLessThan(DEFAULT_HEARTBEAT_MS);
    expect(CREDENTIAL_CHECK_TIMEOUT_MS).toBeLessThan(DEFAULT_LEASE_MS);
  });
});
