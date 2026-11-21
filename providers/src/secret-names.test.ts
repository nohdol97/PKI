import { isBackendReadableSecret, SecretNameSchema } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { openaiKeySecretName } from "./secret-names.ts";

describe("openaiKeySecretName", () => {
  it("names a key per host, within the store's name rules and the shell's allowlist", () => {
    const a = openaiKeySecretName("api.synthetic.example");
    expect(a).toMatch(/^openai-compatible\.api-key\.[0-9a-f]{32}$/);
    expect(SecretNameSchema.safeParse(a).success).toBe(true);
    expect(isBackendReadableSecret(a)).toBe(true);
    expect(openaiKeySecretName("api.synthetic.example")).toBe(a);
    expect(openaiKeySecretName("api.synthetic.example:8443")).not.toBe(a);
    expect(openaiKeySecretName("evil.example")).not.toBe(a);
  });

  it("is the only shape the shell hands to the backend", () => {
    for (const name of ["openai-compatible.api-key", "other", "openai-compatible.api-key.xyz"]) {
      expect(isBackendReadableSecret(name)).toBe(false);
    }
  });
});
