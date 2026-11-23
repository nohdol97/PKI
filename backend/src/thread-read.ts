// The source screen's "same thread" read (I02B-R55). Each message is judged by the read gate (purpose `display`)
// before order and participants are built, so a hidden message is in neither, and the version asked for must be
// shown itself: a hidden version, a version without a thread and a thread with nothing shown are the one answer of
// a number nothing is stored under (undefined, the server's `not-found`).
import type { RouteResponse } from "@pki/contracts";
import { readThread, threadOfVersion, type SqlDriver } from "@pki/storage";
import type { ReadGate } from "./read-gate.ts";

export function readSourceThread(
  db: SqlDriver,
  gate: ReadGate,
  versionId: number,
): RouteResponse<"sourceThread"> | undefined {
  const of = threadOfVersion(db, versionId);
  if (!of || !gate.sourceShown(versionId)) return undefined;
  const thread = readThread(db, of.connectorInstanceId, of.threadId, (m) =>
    gate.sourceShown(m.versionId),
  );
  if (thread.messages.length === 0) return undefined;
  return {
    messages: thread.messages.map((m) => ({
      versionId: m.versionId,
      title: m.title,
      ...(m.author === undefined ? {} : { author: m.author }),
      ...(m.createdAt === undefined ? {} : { createdAt: m.createdAt }),
    })),
    participants: thread.participants,
  };
}
