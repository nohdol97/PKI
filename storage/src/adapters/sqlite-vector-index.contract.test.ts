// H01C3-C1: the SQLite-backed VectorIndex runs the shared `vector-index.contract`, and keeps what the
// contract cannot see from outside: the file survives a reopen, an unfinished build does not, the
// previous generation's rows are gone after a switch, and a file of another schema starts empty.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingSpace } from "@pki/contracts";
import { vectorIndexContract } from "@pki/testkit";
import { afterAll, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./better-sqlite3-driver.ts";
import { SqliteVectorIndex } from "./sqlite-vector-index.ts";

const root = mkdtempSync(join(tmpdir(), "pki-vector-index-"));
let counter = 0;
const freshPath = () => join(root, `${counter++}`, "vectors", "index.sqlite");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const open = (path: string) => new SqliteVectorIndex(path, openBetterSqlite3);

vectorIndexContract("sqlite", () => open(freshPath()));

const SPACE: EmbeddingSpace = { modelId: "m", revision: "r1", dimension: 2 };
const v = (...xs: number[]) => Float32Array.from(xs);

describe("SqliteVectorIndex file", () => {
  it("answers from the active generation after a reopen and drops an unfinished build", async () => {
    const path = freshPath();
    const first = open(path);
    const done = await first.beginRebuild(SPACE);
    await done.upsert([{ ref: "a", vector: v(1, 0) }], 4);
    await done.activate(["a"], 4);
    const unfinished = await first.beginRebuild({ ...SPACE, revision: "r2" });
    await unfinished.upsert([{ ref: "b", vector: v(0, 1) }], 5);
    first.close();

    const second = open(path);
    expect(await second.status()).toBe("ready");
    expect(await second.embeddingSpace()).toEqual(SPACE);
    expect(await second.appliedChangeSeq()).toBe(4);
    expect((await second.search(v(1, 0), 5)).map((hit) => hit.ref)).toEqual(["a"]);
    expect(await (await second.beginRebuild(SPACE)).refs()).toEqual([]);
    second.close();
  });

  it("holds one generation row and its vectors only once the previous one is switched out", async () => {
    const path = freshPath();
    const index = open(path);
    for (const [ref, seq] of [
      ["old", 1],
      ["new", 2],
    ] as const) {
      const build = await index.beginRebuild(SPACE);
      await build.upsert([{ ref, vector: v(1, 0) }], seq);
      await build.activate([ref], seq);
    }
    index.close();
    const db = openBetterSqlite3(path);
    expect(db.all("SELECT state FROM generations").map((row) => row.state)).toEqual(["active"]);
    expect(db.all("SELECT ref FROM vectors").map((row) => row.ref)).toEqual(["new"]);
    expect(db.all("SELECT ref FROM marks").map((row) => row.ref)).toEqual(["new"]);
    db.close();
  });

  it("starts empty over a file of another schema or one that is no database (H01C3-R1)", async () => {
    const path = freshPath();
    mkdirSync(join(path, ".."), { recursive: true });
    const foreign = openBetterSqlite3(path);
    foreign.exec("CREATE TABLE generations (unexpected TEXT); PRAGMA user_version = 99;");
    foreign.close();
    const rebuilt = open(path);
    expect(await rebuilt.status()).toEqual({ unavailable: expect.any(String) });
    const build = await rebuilt.beginRebuild(SPACE);
    await build.upsert([{ ref: "a", vector: v(1, 0) }], 1);
    await build.activate(["a"], 1);
    rebuilt.close();

    // RVF-R4: the same `user_version` as this build's over tables that are not the ones it reads
    const sameVersion = freshPath();
    open(sameVersion).close();
    const odd = openBetterSqlite3(sameVersion);
    odd.exec(
      "DROP TABLE vectors; DROP TABLE marks; DROP TABLE generations; CREATE TABLE generations (unexpected TEXT);",
    );
    odd.close();
    const mended = open(sameVersion);
    expect(await mended.status()).toEqual({ unavailable: expect.any(String) });
    const second = await mended.beginRebuild(SPACE);
    await second.upsert([{ ref: "b", vector: v(1, 0) }], 1);
    await second.activate(["b"], 1);
    expect(await mended.status()).toBe("ready");
    mended.close();

    const garbage = freshPath();
    mkdirSync(join(garbage, ".."), { recursive: true });
    writeFileSync(garbage, "not a database");
    const recovered = open(garbage);
    expect(await recovered.embeddingSpace()).toBeNull();
    recovered.close();
  });
});
