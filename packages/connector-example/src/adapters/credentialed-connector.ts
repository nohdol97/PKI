// Third-party Connector that needs a credential (I06-R23): the example of
// docs/connector-sdk.md chapter 8. Its made-up origin accepts one token, held in
// the config as the origin's own state. The Connector reads the token through the
// accessor the product hands `initialize`, on every call and keeping nothing, and
// tells the origin's refusal as ConnectorCredentialError.
import {
  ConnectorCredentialError,
  ConnectorError,
  HEALTH_REASON_CREDENTIAL_REJECTED,
  type Connector,
  type ConnectorContext,
  type ConnectorCredentials,
} from "@pki/contracts";
import { createExampleConnector, type ExampleConfig } from "./example-connector.ts";

/** The slot the instance declares (`credentials: ["token"]` in the registration). */
const SLOT = "token";

/** The origin's notes, and the one token its API accepts. */
export interface CredentialedConfig extends ExampleConfig {
  acceptedToken: string;
}

export function createCredentialedConnector(): Connector {
  const notes = createExampleConnector();
  let credentials: ConnectorCredentials | undefined;
  let acceptedToken: string | undefined;

  /** Asks the origin whether it accepts the token now; the value is read here and let go. */
  async function authenticate() {
    if (!credentials || acceptedToken === undefined) {
      throw new ConnectorError("not initialized", { retryable: false });
    }
    if ((await credentials.read(SLOT)) !== acceptedToken) throw new ConnectorCredentialError();
  }

  return {
    ...notes,
    async initialize(config: unknown, context?: ConnectorContext) {
      // A product from before credentials hands no context: the token cannot be read.
      if (!context) throw new ConnectorCredentialError();
      credentials = context.credentials;
      const { acceptedToken: accepted, ...origin } = config as CredentialedConfig;
      acceptedToken = accepted;
      await authenticate();
      await notes.initialize(origin);
    },
    async healthCheck() {
      try {
        await authenticate();
      } catch (error) {
        if (error instanceof ConnectorCredentialError) {
          return { state: "unavailable", reason: HEALTH_REASON_CREDENTIAL_REJECTED };
        }
        return { state: "unavailable", reason: "not initialized" };
      }
      return notes.healthCheck();
    },
    async getChanges(cursor, opts) {
      opts.signal.throwIfAborted();
      await authenticate();
      return notes.getChanges(cursor, opts);
    },
  };
}
