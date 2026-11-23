// The instances of approved JSONL file locations (I02B-R41): each `jsonl-file` row of `local_locations` is one
// `jsonl-import` instance (the public prefix and the location's id) with the configuration `{ path, locationId }`. They are made
// at the start from the rows and while the backend runs when a location is approved, through the Connector
// manager's one way to open a Connector. The prefix of the id is the public one (public-kinds.ts, I02B-R51).
import { JSONL_IMPORT_KIND } from "@pki/connector-sdk";
import type { ConnectorSummary } from "@pki/contracts";
import { listLocations, type LocalLocation, type SqlDriver } from "@pki/storage";
import { CONNECTOR_SYNC_KIND, ensureDefaultSchedules } from "./connector-sync-job.ts";
import type {
  ConnectorInstanceConfig,
  ConnectorInstances,
  ConnectorConfigs,
} from "./connectors.ts";
import type { JobActions } from "./job-actions.ts";
import { JSONL_FILE_INSTANCE_PREFIX } from "./public-kinds.ts";
import type { Scheduler } from "./scheduler.ts";

/** The id of the instance a JSONL file location makes. */
export const jsonlFileInstanceId = (locationId: string): string =>
  `${JSONL_FILE_INSTANCE_PREFIX}${locationId}`;

/** The instance a JSONL file location is, as the manager takes it: the file's path, and which location holds its approval. */
export function jsonlFileInstance(
  location: Pick<LocalLocation, "id" | "realPath">,
): ConnectorInstanceConfig {
  return {
    id: jsonlFileInstanceId(location.id),
    kind: JSONL_IMPORT_KIND,
    config: { path: location.realPath, locationId: location.id },
  };
}

/** The instances of the rows of the database, for the start; a location being revoked has none. */
export function jsonlFileInstances(db: SqlDriver): ConnectorInstanceConfig[] {
  return listLocations(db)
    .filter((l) => l.type === "jsonl-file" && l.state !== "revoking")
    .map(jsonlFileInstance);
}

/** What the location API and the revocation ask of the running instances (the composition point binds them). */
export interface JsonlFileHooks {
  /** A JSONL file location was approved: its instance runs now, with its default period. */
  approved(location: LocalLocation): Promise<void>;
  /** Its last source is gone: the instance stops and its period is off. */
  revoked(location: LocalLocation): void;
}

/**
 * The hooks over the running backend. A location approved while it runs gets its instance opened, its default
 * period and a first sync now; a location whose revocation ended loses the instance, its period (turned off) and
 * the jobs still open for it (a job that ran after the instance left would end as a dead letter). The parts the
 * composition point makes after the location API are read when a hook runs.
 */
export function createJsonlFileHooks(parts: {
  db: SqlDriver;
  manager: () =>
    (ConnectorInstances & ConnectorConfigs & { list(): ConnectorSummary[] }) | undefined;
  scheduler: () => Scheduler | undefined;
  actions: () => Pick<JobActions, "cancel"> | undefined;
  wake: () => void;
}): JsonlFileHooks {
  return {
    async approved(location) {
      const manager = parts.manager();
      const scheduler = parts.scheduler();
      if (!manager || !scheduler) return; // the start makes it from the row
      const summary = await manager.addInstance(jsonlFileInstance(location));
      ensureDefaultSchedules(scheduler, [summary], (id) => manager.configOf(id));
      const period = scheduler
        .list()
        .find((s) => s.kind === CONNECTOR_SYNC_KIND && s.target === summary.id);
      if (period) scheduler.runNow(period.id);
      parts.wake();
    },
    revoked(location) {
      const id = jsonlFileInstanceId(location.id);
      parts.manager()?.removeInstance(id);
      const scheduler = parts.scheduler();
      for (const period of scheduler?.list() ?? []) {
        if (period.kind === CONNECTOR_SYNC_KIND && period.target === id)
          scheduler?.disable(period.id);
      }
      for (const row of parts.db.all(
        "SELECT id FROM jobs WHERE kind = ? AND target = ? AND status IN ('queued', 'retry', 'held', 'running')",
        [CONNECTOR_SYNC_KIND, id],
      )) {
        parts.actions()?.cancel(row.id as number);
      }
    },
  };
}
