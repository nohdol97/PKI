// Placeholders for the deployment fork's collectors (V01-R18, ownership.md).
// Every call fails with the follow-up notice; the fork registers its real
// implementation under the same kind.
import {
  CONNECTOR_NOT_IMPLEMENTED,
  CONNECTOR_SDK_VERSION,
  ConnectorNotImplementedError,
  type Connector,
} from "@pki/contracts";

export const SITE_CONNECTOR_KINDS = ["site-mail", "site-messenger", "site-wiki"] as const;

export function createSiteConnector(type: (typeof SITE_CONNECTOR_KINDS)[number]): Connector {
  const fail = () => Promise.reject(new ConnectorNotImplementedError());
  return {
    manifest: {
      type,
      schemaVersion: CONNECTOR_SDK_VERSION,
      capabilities: {
        incremental: false,
        deletes: false,
        accessScope: false,
        fullRescan: false,
        deletionsOnRescan: false,
      },
    },
    initialize: fail,
    healthCheck: async () => ({ state: "unavailable", reason: CONNECTOR_NOT_IMPLEMENTED }),
    getChanges: fail,
    getDocument: fail,
  };
}
