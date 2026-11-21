// Build kind (V01-R10, ARCHITECTURE 3.1): the one value the bundler writes into the
// code when it builds (`define`), and this is the only module that reads it (lint
// `pki/gate-inputs`). The test runner builds as "test" (vitest.config.ts). A run
// of the source without a bundler, a missing value or an unknown one is a
// production build: the strict side. Nothing at run time — an environment
// variable, a setting, an "is this installed" check — can change it.
export type BuildKind = "production" | "development" | "test";

declare const __PKI_BUILD_KIND__: string | undefined;

export function parseBuildKind(raw: string | undefined): BuildKind {
  return raw === "development" || raw === "test" ? raw : "production";
}

export const BUILD_KIND: BuildKind = parseBuildKind(
  typeof __PKI_BUILD_KIND__ === "string" ? __PKI_BUILD_KIND__ : undefined,
);

/** `http` to a loopback OpenAI-compatible endpoint (V01-R11): development and test builds only. */
export function loopbackHttpAllowed(kind: BuildKind): boolean {
  return kind !== "production";
}
