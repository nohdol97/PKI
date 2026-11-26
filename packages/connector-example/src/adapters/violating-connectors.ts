// Deliberately broken variants of the example (I01-R27, I06-R23): each wraps it
// and breaks the specification in one place, to show what checkConnector reports.
// Not exported by the package entry; never a model to copy.
import {
  ConnectorCredentialError,
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type HealthStatus,
  type SourceRecord,
} from "@pki/contracts";
import { createCredentialedConnector } from "./credentialed-connector.ts";
import { createExampleConnector } from "./example-connector.ts";
import {
  createRotatingSessionConnector,
  SESSION_SLOT,
  sessionTokenOf,
  type RotatingConfig,
} from "./rotating-session-connector.ts";

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

// Five variants of the credentialed example, each breaking one credential rule
// (I06-R21). They keep the token they read at initialize, as a real Connector must
// not, to put it where the rule says it may not go.
function keepingToken() {
  const credentialed = createCredentialedConnector();
  let token = "";
  return {
    credentialed,
    token: () => token,
    async initialize(config: unknown, context?: ConnectorContext) {
      await credentialed.initialize(config, context);
      token = (await context?.credentials.read("token")) ?? "";
    },
  };
}

/** `credential-in-record`: it puts the token into every record's metadata. */
export function createRecordLeakingConnector(): Connector {
  const { credentialed, token, initialize } = keepingToken();
  const echo = (record: SourceRecord): SourceRecord => ({
    ...record,
    metadata: { session: token() },
  });
  return {
    ...credentialed,
    initialize,
    async getChanges(cursor, opts) {
      const page = await credentialed.getChanges(cursor, opts);
      return {
        ...page,
        changes: page.changes.map((c) =>
          c.kind === "upsert" ? { ...c, record: echo(c.record) } : c,
        ),
      };
    },
    async getDocument(ref) {
      const doc = await credentialed.getDocument(ref);
      return doc && echo(doc);
    },
  };
}

/** `credential-in-health`: it answers `ok` and adds the token as a note. */
export function createHealthLeakingConnector(): Connector {
  const { credentialed, token, initialize } = keepingToken();
  return {
    ...credentialed,
    initialize,
    async healthCheck() {
      return { state: "ok", note: token() } as HealthStatus;
    },
  };
}

/** `credential-in-error`: a call with an already cancelled signal fails with the token in its message. */
export function createErrorLeakingConnector(): Connector {
  const { credentialed, token, initialize } = keepingToken();
  return {
    ...credentialed,
    initialize,
    async getChanges(cursor, opts) {
      if (opts.signal.aborted) throw new Error(`cancelled while using ${token()}`);
      return credentialed.getChanges(cursor, opts);
    },
  };
}

/** `credential-in-log`: it writes the token to the console when it initializes. */
export function createLogLeakingConnector(): Connector {
  const { credentialed, token, initialize } = keepingToken();
  return {
    ...credentialed,
    async initialize(config, context) {
      await initialize(config, context);
      console.log("connected with", token());
    },
  };
}

/** `credential-rejection-unsignalled`: a refused token ends in a plain ConnectorError, not ConnectorCredentialError. */
export function createUnsignalledRejectionConnector(): Connector {
  const credentialed = createCredentialedConnector();
  const plain = async <T>(call: () => Promise<T>) => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ConnectorCredentialError) {
        throw new ConnectorError("origin refused the token", { retryable: false });
      }
      throw error;
    }
  };
  return {
    ...credentialed,
    initialize: (config, context) => plain(() => credentialed.initialize(config, context)),
    getChanges: (cursor, opts) => plain(() => credentialed.getChanges(cursor, opts)),
  };
}

// Two variants of the session example (I06S-R13), each breaking one session rule.

/**
 * `session-not-persisted`: it keeps the rotated token in memory and never writes it back, so it runs on
 * until the process ends and a new object, which reads the stored session, is refused.
 */
export function createUnwrittenSessionConnector(): Connector {
  const notes = createExampleConnector();
  let origin: RotatingConfig["origin"] | undefined;
  let held = "";
  const request = () => {
    const next = origin?.request(held);
    if (next === undefined) throw new ConnectorCredentialError();
    held = next;
  };
  return {
    ...notes,
    async initialize(config, context) {
      const { origin: given, ...rest } = config as RotatingConfig;
      origin = given;
      held = sessionTokenOf((await context?.credentials.read(SESSION_SLOT)) ?? "");
      request();
      await notes.initialize(rest);
    },
    async getChanges(cursor, opts) {
      request();
      return notes.getChanges(cursor, opts);
    },
  };
}

/** `rotated-credential-leaked`: after each request it writes the rotated session to the console. */
export function createRotatedLeakingConnector(): Connector {
  const rotating = createRotatingSessionConnector();
  let context: ConnectorContext | undefined;
  const show = async () =>
    console.log("session now", await context?.credentials.read(SESSION_SLOT));
  return {
    ...rotating,
    async initialize(config, given) {
      context = given;
      await rotating.initialize(config, given);
      await show();
    },
    async getChanges(cursor, opts) {
      const page = await rotating.getChanges(cursor, opts);
      await show();
      return page;
    },
  };
}
