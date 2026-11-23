// Where a local source is now (I02B-R39): the relative path and whether the file can be found, for the
// evidence screen; and the absolute path of its folder entry, for the shell only. The screen holds a source
// version id, so both are keyed by it. The absolute path is returned by `revealPathOf` and travels only on the
// parent-child channel to the shell's main process (`shell-main.ts`), never in an HTTP answer (P6, I02B-R36).
// The answers come from the index, not from the disk: a stat here would make a screen read a file system.
import type { LocalSourceInfo } from "@pki/contracts";
import {
  LOCAL_FILES_INSTANCE_ID,
  readLocation,
  type LocalLocation,
  type SqlDriver,
} from "@pki/storage";
import { isAbsolute, join, relative } from "node:path";

interface Located {
  location: LocalLocation;
  relativePath: string;
  pendingDelete: number;
}

/** The index entry of the source version, or undefined when it is not a local file's or the entry holds no path. */
function locate(db: SqlDriver, sourceVersionId: number): Located | undefined {
  const row = db.all(
    `SELECT s.namespace AS namespace, e.relative_path AS path, e.pending_delete AS pending
       FROM source_versions v
       JOIN sources s ON s.id = v.source_id
       JOIN local_file_entries e ON e.external_id = s.external_id AND e.location_id = s.namespace
      WHERE v.id = ? AND s.connector_instance_id = ? AND s.identity_hashed = 0`,
    [sourceVersionId, LOCAL_FILES_INSTANCE_ID],
  )[0];
  if (!row || typeof row.path !== "string") return undefined;
  const location = readLocation(db, String(row.namespace));
  if (!location) return undefined;
  return { location, relativePath: row.path, pendingDelete: Number(row.pending) };
}

export function sourceInfoOf(db: SqlDriver, sourceVersionId: number): LocalSourceInfo {
  const at = locate(db, sourceVersionId);
  if (!at) return { local: false, relativePath: null, state: null, notFound: false };
  const { state } = at.location;
  // a paused location is not read: its files are shown as they were (I02B-R10); unavailable or a held or
  // confirmed deletion says the file is not there (I02B-R39)
  return {
    local: true,
    relativePath: at.relativePath,
    state,
    notFound: state === "unavailable" || at.pendingDelete !== 0,
  };
}

/** The file's absolute path for the shell to show in its folder; undefined when the source is not a local file's or not findable. */
export function revealPathOf(db: SqlDriver, sourceVersionId: number): string | undefined {
  const at = locate(db, sourceVersionId);
  if (!at || at.location.state === "unavailable" || at.pendingDelete !== 0) return undefined;
  const path = join(at.location.realPath, at.relativePath);
  const inside = relative(at.location.realPath, path);
  // a path out of the folder is never revealed, whatever the index says
  return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? undefined : path;
}

/** The shell's request over the parent channel: exactly a request id and a version id, nothing a page could shape (P6). */
export function revealRequest(data: unknown): { id: number; sourceVersionId: number } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (Object.keys(data).sort().join(",") !== "id,sourceVersionId,type") return undefined;
  const { type, id, sourceVersionId } = data as Record<string, unknown>;
  const whole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
  if (type !== "reveal-request" || !whole(id) || !whole(sourceVersionId)) return undefined;
  return { id, sourceVersionId };
}
