// A thread in time order (I02B-R29). The order comes from stored values only, so the order in
// which the messages arrived does not show: the instant `createdAt` names, then the identity
// `(namespace, externalId)` by code point, with the messages that carry no instant last.
import type { SqlDriver } from "./sql-driver.ts";

export interface ThreadMessage {
  sourceId: number;
  /** The row ID of the latest version, the one the read gate judges. */
  versionId: number;
  namespace: string;
  externalId: string;
  title: string;
  body: string;
  author?: string;
  createdAt?: string;
}

export interface Thread {
  messages: ThreadMessage[];
  /** `author` and `participants` in order of first appearance along `messages`. */
  participants: string[];
}

const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** The instant as nanoseconds since the epoch (an offset is applied, not compared as text); undefined if unreadable. */
function instantNs(value: string | undefined): bigint | undefined {
  const match = value === undefined ? null : ISO.exec(value);
  if (!match) return undefined;
  const ms = Date.parse(`${match[1]}${match[3]}`);
  if (Number.isNaN(ms)) return undefined;
  return BigInt(ms) * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(9, "0").slice(0, 9));
}

/** Code point order, which `<` on a JavaScript string is not for characters outside the BMP. */
function byCodePoints(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * The latest versions of the instance's sources with this `threadId`, oldest first (I02B-R29).
 * A source a tombstone covers is left out. The caller passes the result through the read gate.
 */
export function readThread(
  db: SqlDriver,
  connectorInstanceId: string,
  threadId: string,
  /** The read gate's verdict on one message; a message it refuses is dropped before order and participants are built. */
  shown: (message: ThreadMessage) => boolean = () => true,
): Thread {
  const rows = db.all(
    `SELECT v.id, s.id AS sourceId, s.namespace, s.external_id AS externalId, v.title, v.body, v.meta
       FROM source_versions v JOIN sources s ON s.id = v.source_id
      WHERE s.connector_instance_id = ?
        AND v.id = (SELECT max(id) FROM source_versions WHERE source_id = v.source_id)
        AND json_extract(v.meta, '$.threadId') = ?
        AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.source_id = s.id AND t.covers_version >= v.version)`,
    [connectorInstanceId, threadId],
  );
  const entries = rows.flatMap((row) => {
    const meta = JSON.parse(row.meta as string) as {
      author?: string;
      participants?: string[];
      createdAt?: string;
    };
    const message: ThreadMessage = {
      sourceId: row.sourceId as number,
      versionId: row.id as number,
      namespace: row.namespace as string,
      externalId: row.externalId as string,
      title: row.title as string,
      body: row.body as string,
      ...(meta.author === undefined ? {} : { author: meta.author }),
      ...(meta.createdAt === undefined ? {} : { createdAt: meta.createdAt }),
    };
    return shown(message)
      ? [
          {
            message,
            at: instantNs(meta.createdAt),
            people: [meta.author, ...(meta.participants ?? [])],
          },
        ]
      : [];
  });
  entries.sort((a, b) => {
    if (a.at !== undefined && b.at !== undefined && a.at !== b.at) return a.at < b.at ? -1 : 1;
    if ((a.at === undefined) !== (b.at === undefined)) return a.at === undefined ? 1 : -1;
    return (
      byCodePoints(a.message.namespace, b.message.namespace) ||
      byCodePoints(a.message.externalId, b.message.externalId)
    );
  });
  const participants: string[] = [];
  for (const { people } of entries) {
    for (const person of people) {
      if (typeof person === "string" && !participants.includes(person)) participants.push(person);
    }
  }
  return { messages: entries.map((e) => e.message), participants };
}

/** The instance and thread a source version belongs to; undefined when the version is absent or has no thread. */
export function threadOfVersion(
  db: SqlDriver,
  versionId: number,
): { connectorInstanceId: string; threadId: string } | undefined {
  const row = db.all(
    `SELECT s.connector_instance_id AS instance, json_extract(v.meta, '$.threadId') AS thread
       FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE v.id = ?`,
    [versionId],
  )[0];
  return typeof row?.thread === "string"
    ? { connectorInstanceId: row.instance as string, threadId: row.thread }
    : undefined;
}
