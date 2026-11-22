// The stored name of a Connector credential slot (I06-R3). The value lives only in
// the shell's secret store; this is the one place that derives its name.
import { isConnectorCredentialSecret } from "@pki/contracts";
import { createHash } from "node:crypto";

/**
 * `connector.<first 32 hex of sha256(kind + "\n" + instanceId)>.<slot>`. The kind in
 * the hash keeps a reused instance ID from handing an old kind's value to a new one;
 * the name does not bind the origin system's address (I06-R3).
 */
export function connectorCredentialName(kind: string, instanceId: string, slot: string): string {
  const hex = createHash("sha256").update(`${kind}\n${instanceId}`).digest("hex").slice(0, 32);
  const name = `connector.${hex}.${slot}`;
  if (!isConnectorCredentialSecret(name)) throw new RangeError("invalid credential slot");
  return name;
}
