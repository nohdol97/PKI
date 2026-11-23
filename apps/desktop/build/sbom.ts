// The SBOM the build writes (H02A-R1, R2): `pnpm sbom --prod` (CycloneDX) is the base,
// the build adds Electron (a dev dependency, so not in the base) and marks the packages
// copied into the app folder and those with native code. A copied package the base does
// not list stops the build: an SBOM with a hole is not written.
import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface SbomComponent {
  type: string;
  name: string;
  version?: string;
  group?: string;
  purl?: string;
  licenses?: unknown[];
  properties?: { name: string; value: string }[];
}
export interface Sbom {
  components: SbomComponent[];
  [key: string]: unknown;
}
export interface RuntimeEntry {
  /** npm name, scope included. */
  name: string;
  version: string;
  native: boolean;
}

/** pnpm writes a scoped name's `@` as `%40` in the purl; membership is compared by purl. */
const purl = (name: string, version: string) => `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;

export function completeSbom(
  base: Sbom,
  options: { electronVersion: string; runtime: readonly RuntimeEntry[] },
): Sbom {
  const listed = new Set(base.components.map((c) => c.purl));
  const missing = options.runtime.filter((p) => !listed.has(purl(p.name, p.version)));
  if (missing.length > 0) {
    throw new Error(
      `SBOM lacks runtime packages the app folder holds: ${missing.map((p) => `${p.name}@${p.version}`).join(", ")}`,
    );
  }
  const marks = new Map(options.runtime.map((p) => [purl(p.name, p.version), p]));
  const components = base.components.map((c) => {
    const entry = c.purl === undefined ? undefined : marks.get(c.purl);
    if (entry === undefined) return c;
    const properties = [{ name: "pki:copied", value: "true" }];
    if (entry.native) properties.push({ name: "pki:native", value: "true" });
    return { ...c, properties: [...(c.properties ?? []), ...properties] };
  });
  components.push({
    type: "framework",
    name: "electron",
    version: options.electronVersion,
    purl: purl("electron", options.electronVersion),
    licenses: [{ license: { id: "MIT" } }],
  });
  return { ...base, components };
}

/** Whether the folder holds a compiled Node addon (`.node`) or a native library (`.dll`, `.so`, `.dylib`). */
export function hasNativeCode(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory()
      ? hasNativeCode(join(dir, entry.name))
      : /\.(node|dll|so|dylib)$/.test(entry.name),
  );
}
