// Test-build-only preload (V02-T11): `node --import <this file> dev.ts` (the browser
// E2E's dev backend), or the first import of v02-shell.e2e.ts (the Electron one).
// From here on, whoever imports composition.ts gets the product module with
// `productProviders` taken from v02-double.e2e.ts (the per-fixture Provider double).
// The product module itself is loaded once, under a query, so none of its state is
// doubled. A run that binds the double says so on stderr, once per process.
import { registerHooks } from "node:module";

const composition = new URL("./composition.ts", import.meta.url).href;
const double = new URL("./v02-double.e2e.ts", import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    if (url !== composition) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: [
        `export * from ${JSON.stringify(`${composition}?product`)};`,
        `export { productProviders } from ${JSON.stringify(double)};`,
      ].join("\n"),
    };
  },
});
process.stderr.write("PKI E2E: Provider double bound (kind test-double)\n");
