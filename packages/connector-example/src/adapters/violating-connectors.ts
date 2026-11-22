// Three deliberately broken variants of the example (I01-R27): each wraps it and
// breaks the specification in one place, to show what checkConnector reports.
// Not exported by the package entry; never a model to copy.
import type { Connector } from "@pki/contracts";
import { createExampleConnector } from "./example-connector.ts";

/** `no-progress`: it hands back the cursor it was given and says there is more. */
export function createStuckCursorConnector(): Connector {
  const example = createExampleConnector();
  return {
    ...example,
    async getChanges(cursor, opts) {
      const page = await example.getChanges(cursor, opts);
      return { ...page, nextCursor: cursor ?? "seq:0", hasMore: true };
    },
  };
}

/** `capability-deletes`: it declares no deletion events and still emits them. */
export function createUndeclaredDeletesConnector(): Connector {
  const example = createExampleConnector();
  const { manifest } = example;
  return {
    ...example,
    manifest: {
      ...manifest,
      capabilities: { ...manifest.capabilities, deletes: false, deletionsOnRescan: false },
    },
  };
}

/** `responds-before-init`: asked before initialize, it answers with an empty page. */
export function createEarlyAnswerConnector(): Connector {
  const example = createExampleConnector();
  return {
    ...example,
    async getChanges(cursor, opts) {
      const { state } = await example.healthCheck();
      if (state !== "ok") return { changes: [], nextCursor: "seq:0", hasMore: false };
      return example.getChanges(cursor, opts);
    },
  };
}
