// `pnpm --filter @pki/backend site-check <kind>` (V01-R18, I01-R1): initializes one
// Connector kind and reports the outcome. The public repository's site kinds
// fail with the follow-up notice and exit 1, as does a kind of another Connector
// SDK version (`unsupported-sdk-version`); an unknown kind exits 2.
import { connectorKinds } from "./composition.ts";
import { siteCheck } from "./connectors.ts";

const kind = process.argv[2] ?? "";
if (!Object.hasOwn(connectorKinds, kind)) {
  process.stderr.write(`usage: site-check <${Object.keys(connectorKinds).join("|")}>\n`);
  process.exit(2);
}
const { ok, line } = await siteCheck(kind, connectorKinds[kind as keyof typeof connectorKinds]);
if (ok) process.stdout.write(`${line}\n`);
else {
  process.stderr.write(`${line}\n`);
  process.exitCode = 1;
}
