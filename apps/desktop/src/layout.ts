// Where the shell finds the screens and the backend, and the switches it takes, in
// a source run (`pnpm --filter @pki/desktop start`, E2E): the repository's paths,
// the backend run from its TypeScript source, and the development and test
// switches --pki-data-dir (the canonical DB folder) and --pki-fixtures (the test
// Connector's synthetic JSONL). The production build bundles layout.production.ts
// in place of this module (apps/desktop/build/bundle.ts, V01-T15).
import { fileURLToPath } from "node:url";

export const WEB_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));
export const BACKEND_ENTRY = fileURLToPath(
  new URL("../../../backend/src/shell.ts", import.meta.url),
);

export interface Switches {
  dataDir?: string | undefined;
  fixtures?: string | undefined;
}

export function switches(read: (name: string) => string | undefined): Switches {
  return { dataDir: read("pki-data-dir"), fixtures: read("pki-fixtures") };
}
