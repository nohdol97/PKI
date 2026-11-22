// I01-R27 / C4 (`connector-example.contract`): the third-party example passes the
// Connector contract in its own tests, as a fork's Connector under
// site/connectors/ would, and depends on the two public entries only.
import { ConnectorError, type Change, type Connector } from "@pki/contracts";
import { connectorContract } from "@pki/testkit";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createExampleConnector } from "./example-connector.ts";
import { EARLIER, LATER } from "./synthetic-notes.ts";

connectorContract("connector-example", createExampleConnector, { config: EARLIER, later: LATER });

const signal = () => new AbortController().signal;
const started = async (config: unknown) => {
  const connector = createExampleConnector();
  await connector.initialize(config);
  return connector;
};
const identity = (change: Change) =>
  `${change.kind} ${change.kind === "upsert" ? change.record.externalId : change.externalId}`;
async function readAll(connector: Connector, cursor: string | null, limit: number) {
  const changes: Change[] = [];
  // Bounded: a Connector that never ends its read fails the test instead of hanging it.
  for (let pages = 0; pages < 20; pages++) {
    const page = await connector.getChanges(cursor, { limit, signal: signal() });
    changes.push(...(page.changes as Change[]));
    cursor = page.nextCursor;
    if (!page.hasMore) return { changes, cursor };
  }
  throw new Error("the read did not end within 20 pages");
}

describe("connector-example.contract", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const manifestOf = (dir: string) =>
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  const declared = (manifest: Record<string, unknown>) =>
    ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
      (field) => Object.keys((manifest[field] as object | undefined) ?? {}),
    );

  it("depends on @pki/contracts and @pki/testkit only, and is private", () => {
    const own = manifestOf(resolve(import.meta.dirname, "../.."));
    expect(declared(own).sort()).toEqual(["@pki/contracts", "@pki/testkit"]);
    expect(own.private).toBe(true);
  });

  it("is not a dependency of any workspace package (not in the product)", () => {
    const dirs = [
      root,
      ...readdirSync(root).map((d) => join(root, d)),
      ...["apps", "packages"].flatMap((p) =>
        readdirSync(join(root, p)).map((d) => join(root, p, d)),
      ),
    ].filter((dir) => existsSync(join(dir, "package.json")));
    expect(dirs.length).toBeGreaterThan(5);
    const dependents = dirs.filter((dir) =>
      declared(manifestOf(dir)).includes("@pki/connector-example"),
    );
    expect(dependents).toEqual([]);
  });
});

describe("connector-example", () => {
  it("delivers the origin's present state once per note, in change order", async () => {
    const { changes, cursor } = await readAll(await started(EARLIER), null, 2);
    expect(changes.map(identity)).toEqual([
      "upsert note-1",
      "upsert note-2",
      "delete note-3",
      "upsert note-4",
    ]);
    expect(cursor).toBe("seq:4");
  });

  it("delivers only what changed after a cursor", async () => {
    const { changes, cursor } = await readAll(await started(LATER), "seq:4", 100);
    expect(changes.map(identity)).toEqual(["upsert note-2", "delete note-4", "upsert note-5"]);
    expect(changes[0]).toMatchObject({ record: { revision: 4 } });
    expect(cursor).toBe("seq:7");
  });

  it.each(["4", "seq:", "seq:-1", "seq:8"])(
    "reports the cursor %j as expired so the caller rescans",
    async (cursor) => {
      const page = await (await started(LATER)).getChanges(cursor, { limit: 10, signal: signal() });
      expect(page).toMatchObject({ changes: [], hasMore: false, cursorExpired: true });
    },
  );

  it("takes back the cursor of the largest sequence number it accepts", async () => {
    const [note] = EARLIER.notes;
    const config = { namespace: "n", notes: [{ ...note, seq: Number.MAX_SAFE_INTEGER }] };
    const connector = await started(config);
    const { changes, cursor } = await readAll(connector, null, 10);
    expect(changes).toHaveLength(1);
    expect(cursor).toBe(`seq:${Number.MAX_SAFE_INTEGER}`);
    expect(await connector.getChanges(cursor, { limit: 10, signal: signal() })).toEqual({
      changes: [],
      nextCursor: cursor,
      hasMore: false,
    });
  });

  it("refuses a limit below 1 instead of returning the cursor it was given", async () => {
    const connector = await started(EARLIER);
    await expect(connector.getChanges(null, { limit: 0, signal: signal() })).rejects.toThrow(
      ConnectorError,
    );
  });

  it("answers getDocument with the live note of its namespace only", async () => {
    const connector = await started(LATER);
    const ref = { namespace: LATER.namespace, externalId: "note-5" };
    expect(await connector.getDocument(ref)).toMatchObject({ title: "Recipe", revision: 1 });
    expect(await connector.getDocument({ ...ref, externalId: "note-4" })).toBeNull();
    expect(await connector.getDocument({ ...ref, namespace: "" })).toBeNull();
  });

  it("is unavailable, and fails its reads, before it is initialized", async () => {
    const connector = createExampleConnector();
    expect(await connector.healthCheck()).toEqual({
      state: "unavailable",
      reason: "not initialized",
    });
    await expect(connector.getChanges(null, { limit: 1, signal: signal() })).rejects.toThrow(
      ConnectorError,
    );
    await expect(connector.getDocument({ namespace: "", externalId: "note-1" })).rejects.toThrow(
      ConnectorError,
    );
  });

  const [first, second] = EARLIER.notes;
  it.each([
    ["no config", undefined],
    ["no namespace", { notes: [] }],
    ["notes that are not a list", { namespace: "n", notes: "note-1" }],
    ["a note that is not an object", { namespace: "n", notes: [null] }],
    ["a note without a revision", { namespace: "n", notes: [{ ...first, revision: undefined }] }],
    [
      "a timestamp without an offset",
      { namespace: "n", notes: [{ ...first, updatedAt: "2026-01-05" }] },
    ],
    ["a sequence number below 1", { namespace: "n", notes: [{ ...first, seq: 0 }] }],
    ["a fractional sequence number", { namespace: "n", notes: [{ ...first, seq: 1.5 }] }],
    ["two notes with one id", { namespace: "n", notes: [first, { ...second, id: "note-1" }] }],
    [
      "two notes with one sequence number",
      { namespace: "n", notes: [first, { ...second, seq: 1 }] },
    ],
  ])("fails to initialize with %s, as not retryable", async (_name, config) => {
    const failure = await createExampleConnector()
      .initialize(config)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ConnectorError);
    expect(failure).toMatchObject({ retryable: false });
  });
});
