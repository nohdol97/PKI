// `pnpm --filter @pki/backend site-check <kind>` (V01-R18): initializes one
// Connector kind and reports the outcome. The public repository's site kinds
// fail with the follow-up notice and exit 1; an unknown kind exits 2.
import { connectorKinds } from "./composition.ts";

const kind = process.argv[2] ?? "";
if (!Object.hasOwn(connectorKinds, kind)) {
  process.stderr.write(`usage: site-check <${Object.keys(connectorKinds).join("|")}>\n`);
  process.exit(2);
}
try {
  await connectorKinds[kind as keyof typeof connectorKinds]().initialize({});
  process.stdout.write(`${kind}: ok\n`);
} catch (error) {
  process.stderr.write(`${kind}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
