// Build kind (V01-R10, ARCHITECTURE 3.1): the one value the bundler writes into the
// code when it builds (`define` of `import.meta.PKI_BUILD_KIND`, replaced by a
// string literal), and this is the only module that names it (lint
// `pki/gate-inputs`). The test runner builds as "test" (vitest.config.ts). A
// missing or unknown value is a production build: the strict side.
//
// The value lives on `import.meta`, not on a global: `import.meta` is this
// module's own object, so without a bundler (dev.ts and the shell's backend run
// the source as it is) no other code in the process — a global, a preload
// through NODE_OPTIONS, an environment variable — can supply it, and the build
// is production. Rewriting this module's source (a loader hook) is out of reach
// of any check here; it is code execution in the process.
export type BuildKind = "production" | "development" | "test";

declare global {
  interface ImportMeta {
    /** Written by the bundler only; absent when the source runs as it is. */
    readonly PKI_BUILD_KIND?: string;
  }
}

// Compared with string literals only: once the bundler has written the value, this
// is a constant expression, so a bundle sees a literal and drops the branches of
// the other kinds (the production build checks it: apps/desktop/build, V01-T15).
export const BUILD_KIND: BuildKind =
  import.meta.PKI_BUILD_KIND === "test"
    ? "test"
    : import.meta.PKI_BUILD_KIND === "development"
      ? "development"
      : "production";

/** `http` to a loopback OpenAI-compatible endpoint (V01-R11): development and test builds only. */
export function loopbackHttpAllowed(kind: BuildKind): boolean {
  return kind !== "production";
}
