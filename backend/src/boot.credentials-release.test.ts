// I06-R12 on the real bootBackend: a rebuild that turns a rejected instance ready puts its held job back through
// the manager's `onReady` that boot.ts wires, without the hourly pass. Everything is made up.
import {
  CONNECTOR_SDK_VERSION,
  ConnectorCredentialError,
  type Connector,
  type ConnectorContext,
  type SecretRead,
} from "@pki/contracts";
import { readJob, registerJob } from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { connectorCredentialName } from "./connector-credentials.ts";
import { CONNECTOR_SYNC_KIND } from "./connector-sync-job.ts";

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-boot-release-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
};

describe("boot.credentials-release (I06-R12)", () => {
  it("a rebuild that turns the rejected instance ready runs its held job without the hourly pass", async () => {
    const name = connectorCredentialName("fork", "a", "token");
    const secrets = {
      read: async (): Promise<SecretRead> => ({ state: "present", value: "synthetic-value-a" }),
      has: async () => "present" as const,
      deleteOthers: async () => "done" as const,
    };
    let made = 0;
    const factory = (): Connector => {
      const first = made++ === 0;
      return {
        manifest: {
          type: "fork",
          schemaVersion: CONNECTOR_SDK_VERSION,
          capabilities: {
            incremental: true,
            deletes: true,
            accessScope: false,
            fullRescan: true,
            deletionsOnRescan: false,
          },
        },
        initialize: async (_config: unknown, context?: ConnectorContext) => {
          await (context as ConnectorContext).credentials.read("token");
          if (first) throw new ConnectorCredentialError();
        },
        healthCheck: async () => ({ state: "ok" as const }),
        getChanges: async () => ({ changes: [], nextCursor: "1", hasMore: false }),
        getDocument: async () => null,
      } as unknown as Connector;
    };
    booted = await bootBackend({
      dataDir: join(dir, "data"),
      token: "u".repeat(43),
      allowedOrigins: [],
      secrets,
      providers: [],
      site: {
        connectorKinds: { fork: factory },
        connectorInstances: [{ id: "a", kind: "fork", config: {}, credentials: ["token"] }],
      },
    });
    expect(name).toMatch(/^connector\./);
    expect(booted.connectors.list().find((c) => c.id === "a")?.reason).toBe("credential-rejected");
    const queued = registerJob(booted.db, { kind: CONNECTOR_SYNC_KIND, target: "a" });
    if (!queued.registered) throw new Error("expected a new job");
    await booted.runner.wake();
    await flush();
    expect(readJob(booted.db, queued.job.id)).toMatchObject({
      status: "held",
      reason: "credential-rejected",
    });
    expect((await booted.connectors.rebuild("a"))?.rebuild).toBe("done");
    await flush();
    expect(readJob(booted.db, queued.job.id)?.status).toBe("succeeded");
  });
});
