// I06-C1 `secrets.connector-names` (I06-R3, R4): the name shape of a Connector
// credential and the two separate predicates the shell gates on.
import { describe, expect, it } from "vitest";
import {
  isBackendReadableSecret,
  isConnectorCredentialSecret,
  SecretNameSchema,
} from "./secrets.ts";

const HEX = "0123456789abcdef".repeat(2);
const PROVIDER_KEY = `openai-compatible.api-key.${HEX}`;
const CONNECTOR = `connector.${HEX}.token`;

describe("isConnectorCredentialSecret", () => {
  it.each([
    ["a plain slot", CONNECTOR],
    ["a one-letter slot", `connector.${HEX}.a`],
    ["a 16-char slot with digits and hyphens", `connector.${HEX}.a1-b2-c3-d4-e5-f`],
  ])("accepts %s, and the name is a valid secret name", (_label, name) => {
    expect(isConnectorCredentialSecret(name)).toBe(true);
    expect(SecretNameSchema.safeParse(name).success).toBe(true);
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it.each([
    ["Provider-key shape", PROVIDER_KEY],
    ["wrong prefix", `connectors.${HEX}.token`],
    ["prefix with a leading character", `xconnector.${HEX}.token`],
    ["uppercase hex", `connector.${HEX.toUpperCase()}.token`],
    ["31 hex digits", `connector.${HEX.slice(1)}.token`],
    ["33 hex digits", `connector.${HEX}0.token`],
    ["uppercase slot", `connector.${HEX}.Token`],
    ["17-char slot", `connector.${HEX}.${"a".repeat(17)}`],
    ["slot starting with a digit", `connector.${HEX}.1token`],
    ["slot starting with a hyphen", `connector.${HEX}.-token`],
    ["empty slot", `connector.${HEX}.`],
    ["extra dot in the slot", `connector.${HEX}.to.ken`],
    ["extra trailing segment", `${CONNECTOR}.more`],
    ["a path-like name", `connector.${HEX}.../etc`],
    ["a trailing newline", `${CONNECTOR}\n`],
    ["a leading newline", `\n${CONNECTOR}`],
    ["the prefix alone", "connector."],
    ["the empty string", ""],
  ])("rejects %s", (_label, name) => {
    expect(isConnectorCredentialSecret(name)).toBe(false);
  });
});

describe("the two predicates are disjoint", () => {
  it("a Connector credential is never a Provider key and the reverse", () => {
    expect(isBackendReadableSecret(CONNECTOR)).toBe(false);
    expect(isConnectorCredentialSecret(PROVIDER_KEY)).toBe(false);
    expect(isBackendReadableSecret(PROVIDER_KEY)).toBe(true);
    expect(isConnectorCredentialSecret(CONNECTOR)).toBe(true);
  });
});
