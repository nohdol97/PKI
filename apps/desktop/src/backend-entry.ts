// Which file starts the backend (I05-R2): the public entry, or the fork's own when the repository has a
// composition package. Only the build (build/build.ts) and a source run (layout.ts) use it; the production
// layout knows the bundled `./backend/shell.js` alone, so the artifact carries no lookup. The repository root
// is an argument (I05-R25): nothing here reads the real checkout by itself.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The backend entry of the tree at `root`; a composition package without its entry fails, naming the path. */
export function backendEntry(root: string): string {
  if (!existsSync(join(root, "site/composition/package.json"))) {
    return join(root, "backend/src/shell.ts");
  }
  const entry = join(root, "site/composition/src/shell.ts");
  if (!existsSync(entry)) {
    throw new Error(`site/composition has a package.json but no backend entry: ${entry}`);
  }
  return entry;
}
