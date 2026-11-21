// The dev entry hands its per-run token to the parent over stdout, never argv or env.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { send } from "@pki/testkit";

it("prints a fresh session on stdout and serves the status API with it", async () => {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "dev.ts")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const sessions: { url: string; token: string }[] = [];
    for await (const line of createInterface({ input: child.stdout })) {
      sessions.push(JSON.parse(line));
      break;
    }
    const session = sessions[0];
    expect(session?.token).toMatch(/^[\w-]{43}$/);
    const { host, port } = new URL(session?.url ?? "");
    const res = await send(Number(port), "/api/status", {
      host,
      authorization: `Bearer ${session?.token}`,
    });
    expect(res.status).toBe(200);
  } finally {
    child.kill();
  }
});
