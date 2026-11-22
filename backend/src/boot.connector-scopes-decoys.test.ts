// I07-T02 (I07-R2, I07-C2 ①): where the instance scopes come from cannot be changed from outside the
// registration. A decoy range file is put in every place a reader might look (the old module-relative
// place, the current folder, the data directory and its `site/config/`), and environment variables that
// look like a path to one are set; the booted backend's result is the one the registration gives, and the
// decoy's marker is in no row and in no byte of the canonical DB. If any decoy were read this fails.
import { routes } from "@pki/contracts";
import { send } from "@pki/testkit";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { CANONICAL_DB_FILE } from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import type { SiteRegistration } from "./site-registration.ts";

const TOKEN = "d".repeat(43);
const DECOY = "synthetic-decoy-marker-cccc";
const MAIL = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"), "utf8").split(
    "\n",
  )[0] as string,
) as Record<string, unknown>;
const REPO_DECOY = resolve(import.meta.dirname, "../../site/config/connector-scopes.json");
const DECOY_TEXT = `${JSON.stringify({ "imp-one": [DECOY], "imp-two": [DECOY] })}\n`;

let work: string;
let dataDir: string;
let cwdBefore: string;
let madeRepoDecoy: boolean;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
const ENV_NAMES = [
  "PKI_CONNECTOR_SCOPES",
  "PKI_CONNECTOR_SCOPES_FILE",
  "CONNECTOR_SCOPES",
  "CONNECTOR_SCOPES_FILE",
  "PKI_SCOPES_FILE",
  "PKI_SITE_CONFIG",
  "SITE_CONFIG_DIR",
];

const ENV_CONTENT_NAMES = ["PKI_CONNECTOR_SCOPES", "PKI_SITE_CONNECTOR_SCOPES"];

/**
 * Whether the decoy at `file` is this test's to put and remove: nothing is there, or what is there is
 * exactly this test's decoy (a leftover of a run that was killed before it cleaned up). Any other
 * content is a real file (a fork's) and is never written over or removed.
 */
const ownsDecoy = (file: string): boolean =>
  !existsSync(file) || readFileSync(file, "utf8") === DECOY_TEXT;

/** Removes the decoy this test owns, and its folder if that is left empty; a file that is not ours stays. */
const releaseDecoy = (file: string, owned: boolean): void => {
  if (!owned) return;
  rmSync(file, { force: true });
  try {
    rmdirSync(dirname(file));
  } catch {
    // not empty (or not there): somebody else's files stay
  }
};

const put = (file: string, text: string): void => {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "pki-scopes-decoy-"));
  dataDir = join(work, "data");
  mkdirSync(dataDir);
  const cwdFolder = join(work, "cwd");
  mkdirSync(cwdFolder);
  cwdBefore = process.cwd();
  // the old module-relative place. A fork's checkout may already have a real range file there: that file
  // is then the decoy (it must not be read either) and is neither written nor removed here
  madeRepoDecoy = ownsDecoy(REPO_DECOY);
  if (madeRepoDecoy) put(REPO_DECOY, DECOY_TEXT);
  put(join(cwdFolder, "site/config/connector-scopes.json"), DECOY_TEXT);
  put(join(cwdFolder, "connector-scopes.json"), DECOY_TEXT);
  put(join(dataDir, "connector-scopes.json"), DECOY_TEXT);
  put(join(dataDir, "site/config/connector-scopes.json"), DECOY_TEXT);
  process.chdir(cwdFolder);
  for (const n of ENV_NAMES) {
    vi.stubEnv(
      n,
      n.includes("DIR") ? join(cwdFolder, "site/config") : join(dataDir, "connector-scopes.json"),
    );
  }
  // and two that carry the decoy's CONTENT, for a reader that takes the value from the environment
  for (const n of ENV_CONTENT_NAMES) vi.stubEnv(n, DECOY_TEXT);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  vi.restoreAllMocks();
  process.chdir(cwdBefore);
  vi.unstubAllEnvs();
  releaseDecoy(REPO_DECOY, madeRepoDecoy);
  rmSync(work, { recursive: true, force: true });
});

async function importBoth(site?: SiteRegistration) {
  booted = await bootBackend({
    dataDir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    ...(site ? { site } : {}),
  });
  const { port } = booted.server;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  for (const instanceId of ["imp-one", "imp-two"]) {
    const res = await send(port, routes.imports.path, headers, "POST", {
      instanceId,
      content: JSON.stringify({
        ...MAIL,
        external_id: `e-${instanceId}`,
        connector_instance_id: instanceId,
        access_scope: ["open"],
      }),
    });
    expect(res.status).toBe(200);
  }
  return booted.db.all("SELECT id, configured_scope FROM connector_instances ORDER BY id");
}

/** Whether any file of the data directory's database (journal files included) holds the marker. */
const markerOnDisk = (): boolean =>
  readdirSync(dataDir)
    .filter((f) => f.startsWith(CANONICAL_DB_FILE))
    .some((f) => readFileSync(join(dataDir, f)).includes(DECOY));

describe("I07-C2 ①: a decoy range file is not read", () => {
  it("with no scopes in the registration every instance is NULL and the decoy's marker is nowhere", async () => {
    const rows = await importBoth();
    expect(rows).toEqual([
      { id: "imp-one", configured_scope: null },
      { id: "imp-two", configured_scope: null },
    ]);
    expect(markerOnDisk()).toBe(false);
  });

  it("with scopes in the registration the result is the registration's, the decoy's value for the same ids is not", async () => {
    const rows = await importBoth({ connectorScopes: { "imp-one": ["registered"] } });
    expect(rows).toEqual([
      { id: "imp-one", configured_scope: '["registered"]' },
      { id: "imp-two", configured_scope: null },
    ]);
    expect(markerOnDisk()).toBe(false);
  });

  it("the decoys really were in place for the run (the test is not vacuous)", async () => {
    await importBoth();
    for (const file of [
      ...(madeRepoDecoy ? [REPO_DECOY] : []),
      join(process.cwd(), "site/config/connector-scopes.json"),
      join(dataDir, "connector-scopes.json"),
      join(dataDir, "site/config/connector-scopes.json"),
    ]) {
      expect(readFileSync(file, "utf8")).toContain(DECOY);
    }
    expect(process.env.PKI_CONNECTOR_SCOPES_FILE).toContain("connector-scopes.json");
  });

  it("a content-carrying environment variable is set for the run", async () => {
    await importBoth();
    expect(process.env.PKI_CONNECTOR_SCOPES).toContain(DECOY);
  });
});

describe("the repo-root decoy's ownership (a killed run's leftover)", () => {
  let scratch: string;
  beforeEach(() => void (scratch = mkdtempSync(join(tmpdir(), "pki-decoy-own-"))));
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("takes back its own leftover: planted exactly, it is owned and gone (with its folder) after release", () => {
    const file = join(scratch, "site/config/connector-scopes.json");
    put(file, DECOY_TEXT);
    expect(ownsDecoy(file)).toBe(true);
    releaseDecoy(file, true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dirname(file))).toBe(false);
  });

  it("a file with other content is not owned and is left untouched", () => {
    const file = join(scratch, "site/config/connector-scopes.json");
    put(file, '{"real":["scope"]}\n');
    expect(ownsDecoy(file)).toBe(false);
    releaseDecoy(file, ownsDecoy(file));
    expect(readFileSync(file, "utf8")).toBe('{"real":["scope"]}\n');
  });

  it("nothing there is owned", () => {
    expect(ownsDecoy(join(scratch, "none.json"))).toBe(true);
  });
});
