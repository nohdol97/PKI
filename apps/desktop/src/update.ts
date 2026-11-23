// Update verification (H02A-R3..R5, spec 2026-11-24-H02-common). Only the check and the
// order of steps live here: the channel (where a manifest and a file come from, how an
// install starts) is the deployment's (D3), and nothing in the shell calls this yet.
// The signature is a layer beside Authenticode, never a replacement for it (ADR 0007).
import { createHash, verify, type KeyObject } from "node:crypto";
import { createReadStream, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** The reason every call on the shared channel fails with. */
export const UNAVAILABLE = "미구현, 배포처 후속";

export interface UpdateManifest {
  version: string;
  file: string;
  sha512: string;
  size: number;
}
export type UpdateRefusal = "bad-signature" | "malformed" | "not-newer";

export class UpdateError extends Error {
  constructor(readonly reason: UpdateRefusal) {
    super(reason);
  }
}

export interface UpdateChannel {
  /** The manifest's exact bytes and the detached Ed25519 signature over them. */
  fetchManifest(): Promise<{ bytes: Uint8Array; signature: Uint8Array }>;
  download(manifest: UpdateManifest, toFile: string): Promise<void>;
  install(file: string): Promise<void>;
}

export const unavailableUpdateChannel: UpdateChannel = {
  fetchManifest: () => Promise.reject(new Error(`${UNAVAILABLE}: no update channel`)),
  download: () => Promise.reject(new Error(`${UNAVAILABLE}: no update channel`)),
  install: () => Promise.reject(new Error(`${UNAVAILABLE}: no update channel`)),
};

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const parts = (version: string) => VERSION.exec(version)?.slice(1).map(Number);

function isNewer(candidate: number[], current: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (candidate[i] !== current[i]) return (candidate[i] ?? 0) > (current[i] ?? 0);
  }
  return false;
}

/** The manifest when the key's signature holds, its shape is right and it is newer; else an UpdateError. */
export function verifyManifest(input: {
  bytes: Uint8Array;
  signature: Uint8Array;
  publicKey: KeyObject | undefined;
  currentVersion: string;
}): UpdateManifest {
  let genuine = false;
  try {
    genuine =
      input.publicKey !== undefined && verify(null, input.bytes, input.publicKey, input.signature);
  } catch {
    // a signature of the wrong shape is a failed signature
  }
  if (!genuine) throw new UpdateError("bad-signature");
  let raw: Partial<Record<keyof UpdateManifest, unknown>>;
  try {
    raw = JSON.parse(Buffer.from(input.bytes).toString("utf8"));
  } catch {
    throw new UpdateError("malformed");
  }
  const candidate = typeof raw?.version === "string" ? parts(raw.version) : undefined;
  const current = parts(input.currentVersion);
  if (
    candidate === undefined ||
    current === undefined ||
    typeof raw.file !== "string" ||
    !FILE.test(raw.file) ||
    typeof raw.sha512 !== "string" ||
    !/^[0-9a-f]{128}$/i.test(raw.sha512) ||
    !Number.isSafeInteger(raw.size) ||
    (raw.size as number) < 0
  ) {
    throw new UpdateError("malformed");
  }
  if (!isNewer(candidate, current)) throw new UpdateError("not-newer");
  return raw as unknown as UpdateManifest;
}

async function sha512Of(file: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type UpdateResult = { ok: true; version: string } | { ok: false; reason: string };

/** Verify, download, compare size and SHA-512, and only then install. Any failure leaves nothing behind and installs nothing. */
export async function runUpdate(input: {
  channel: UpdateChannel;
  publicKey: KeyObject | undefined;
  currentVersion: string;
  workDir: string;
}): Promise<UpdateResult> {
  let file: string | undefined;
  try {
    const { bytes, signature } = await input.channel.fetchManifest();
    const manifest = verifyManifest({
      bytes,
      signature,
      publicKey: input.publicKey,
      currentVersion: input.currentVersion,
    });
    file = join(input.workDir, manifest.file);
    await input.channel.download(manifest, file);
    if (statSync(file).size !== manifest.size) return failed(file, "size-mismatch");
    if ((await sha512Of(file)).toLowerCase() !== manifest.sha512.toLowerCase()) {
      return failed(file, "hash-mismatch");
    }
    await input.channel.install(file);
    return { ok: true, version: manifest.version };
  } catch (error) {
    return failed(file, error instanceof UpdateError ? error.reason : errorText(error));
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function failed(file: string | undefined, reason: string): UpdateResult {
  if (file !== undefined) rmSync(file, { force: true });
  return { ok: false, reason };
}
