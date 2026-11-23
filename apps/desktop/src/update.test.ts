// H02A-C2, C3: update verification (spec 2026-11-24-H02-common, R3-R5). Keys are generated
// here, per run; nothing is committed. The channel is a fake.
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runUpdate,
  UNAVAILABLE,
  unavailableUpdateChannel,
  verifyManifest,
  type UpdateChannel,
} from "./update.ts";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "pki-update-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const keys = () => generateKeyPairSync("ed25519");
const payload = Buffer.from("synthetic installer bytes");
const manifestFor = (version: string, file = payload) =>
  Buffer.from(
    JSON.stringify({
      version,
      file: "pki-setup.exe",
      sha512: createHash("sha512").update(file).digest("hex"),
      size: file.length,
    }),
  );
const signed = (bytes: Buffer, privateKey: KeyObject) => ({
  bytes,
  signature: sign(null, bytes, privateKey),
});

describe("verifyManifest", () => {
  it("H02A-C2: a manifest signed with the key passes", () => {
    const { publicKey, privateKey } = keys();
    const got = verifyManifest({
      ...signed(manifestFor("1.2.0"), privateKey),
      publicKey,
      currentVersion: "1.1.9",
    });
    expect(got.version).toBe("1.2.0");
  });

  it("H02A-C2: a changed byte or another key is bad-signature; an equal or lower version is not-newer", () => {
    const { publicKey, privateKey } = keys();
    const good = signed(manifestFor("1.2.0"), privateKey);
    const tampered = Buffer.from(good.bytes);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 2) ^ 1, tampered.length - 2);
    const reason = (input: Parameters<typeof verifyManifest>[0]) => {
      try {
        verifyManifest(input);
      } catch (error) {
        return (error as { reason?: string }).reason;
      }
    };
    const current = "1.1.9";
    expect(reason({ ...good, bytes: tampered, publicKey, currentVersion: current })).toBe(
      "bad-signature",
    );
    expect(reason({ ...good, publicKey: keys().publicKey, currentVersion: current })).toBe(
      "bad-signature",
    );
    expect(reason({ ...good, publicKey: undefined, currentVersion: current })).toBe(
      "bad-signature",
    );
    expect(reason({ ...good, publicKey, currentVersion: "1.2.0" })).toBe("not-newer");
    expect(reason({ ...good, publicKey, currentVersion: "2.0.0" })).toBe("not-newer");
    const odd = signed(Buffer.from('{"version":"1.2"}'), privateKey);
    expect(reason({ ...odd, publicKey, currentVersion: current })).toBe("malformed");
  });
});

describe("runUpdate", () => {
  const channelFor = (privateKey: KeyObject, served: Buffer, bytes = manifestFor("1.2.0")) => {
    const install = vi.fn(async () => {});
    const channel: UpdateChannel = {
      fetchManifest: async () => signed(bytes, privateKey),
      download: async (_manifest, toFile) => writeFileSync(toFile, served),
      install,
    };
    return { channel, install };
  };

  it("H02A-C3: a file whose hash differs from the manifest is never installed and is not kept", async () => {
    const { publicKey, privateKey } = keys();
    const { channel, install } = channelFor(privateKey, Buffer.from("synthetic installer BYTES"));
    const result = await runUpdate({ channel, publicKey, currentVersion: "1.0.0", workDir: work });
    expect(result).toMatchObject({ ok: false, reason: "hash-mismatch" });
    expect(install).not.toHaveBeenCalled();
    expect(existsSync(join(work, "pki-setup.exe"))).toBe(false);
  });

  it("H02A-C3: a good file is installed once", async () => {
    const { publicKey, privateKey } = keys();
    const { channel, install } = channelFor(privateKey, payload);
    const result = await runUpdate({ channel, publicKey, currentVersion: "1.0.0", workDir: work });
    expect(result).toEqual({ ok: true, version: "1.2.0" });
    expect(install).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(work, "pki-setup.exe"))).toEqual(payload);
  });

  it("H02A-C3: the shared channel fails with a reason starting 미구현, 배포처 후속", async () => {
    const result = await runUpdate({
      channel: unavailableUpdateChannel,
      publicKey: keys().publicKey,
      currentVersion: "1.0.0",
      workDir: work,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason.startsWith("미구현, 배포처 후속")).toBe(true);
    expect(UNAVAILABLE).toBe("미구현, 배포처 후속");
  });
});
