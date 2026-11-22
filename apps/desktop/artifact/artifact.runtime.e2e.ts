// The app folder's runtime packages load from the app folder itself (V01-T15,
// review A-F3), under the Electron binary's Node as the backend does: better-sqlite3
// opens a database, Transformers.js, onnxruntime-node and sharp load their native
// code. Each must resolve inside app/node_modules: one found elsewhere on the disk
// (the repository's pnpm store) would hide a package the build did not copy.
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { APP_DIR } from "../build/paths.ts";
import { ELECTRON } from "../e2e/launch.ts";

const PROBE = `
const out = {};
for (const name of ["better-sqlite3", "@huggingface/transformers", "onnxruntime-node", "sharp"]) {
  out[name] = { at: import.meta.resolve(name) };
}
const { default: Database } = await import("better-sqlite3");
const db = new Database(":memory:");
out["better-sqlite3"].loaded = db.prepare("select sqlite_version() as v").get().v;
db.close();
const ort = await import("onnxruntime-node");
out["onnxruntime-node"].loaded = typeof ort.InferenceSession?.create;
const { default: sharp } = await import("sharp");
out["sharp"].loaded = sharp.versions.vips;
const transformers = await import("@huggingface/transformers");
out["@huggingface/transformers"].loaded = typeof transformers.pipeline;
console.log(JSON.stringify(out));
`;

test("each runtime package loads from the app folder", () => {
  test.setTimeout(60_000);
  const run = spawnSync(ELECTRON, ["--input-type=module", "-e", PROBE], {
    cwd: APP_DIR,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });
  expect(run.status, run.stderr).toBe(0);
  const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
    string,
    { at: string; loaded: string }
  >;
  const inside = `${pathToFileURL(APP_DIR).href}/node_modules/`;
  for (const [name, { at, loaded }] of Object.entries(out)) {
    expect(at, name).toContain(inside);
    expect(loaded, name).toMatch(/\S/);
  }
  expect(out["better-sqlite3"]?.loaded).toMatch(/^3\./);
  expect(out["onnxruntime-node"]?.loaded).toBe("function");
  expect(out["@huggingface/transformers"]?.loaded).toBe("function");
});
