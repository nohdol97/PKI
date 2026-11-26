// Third-party Connector whose origin signs in on the web (I06S-R13): the example of
// docs/connector-sdk.md chapter 8, "세션형 자격 증명". Its made-up origin gives no fixed value: `login()` issues
// a session token, every response carries the next token and the old one is refused from the next request on.
// The Connector reads the session slot's one-line JSON `{"cookies":{"sid":"<token>"}}` on every call, and writes
// the rotated token back before its next request. Without a `write` (a product from before sessions) it ends
// in ConnectorCredentialError, like a missing context.
import {
  ConnectorCredentialError,
  ConnectorError,
  HEALTH_REASON_CREDENTIAL_REJECTED,
  type Connector,
  type ConnectorContext,
  type ConnectorCredentials,
} from "@pki/contracts";
import { createExampleConnector, type ExampleConfig } from "./example-connector.ts";

/** The slot the instance declares as its session slot (`login.slot` in the registration). */
export const SESSION_SLOT = "session";
/** The cookie the made-up origin's session lives in (`login.cookies` in the registration). */
export const SESSION_COOKIE = "sid";

/** The made-up origin's sign-in state: one valid token at a time. */
export interface RotatingOrigin {
  /** The user signs in: a new session token, the only one valid now. */
  login(): string;
  /** One request with `token`: the next token when it is the valid one, else undefined (refused). */
  request(token: string): string | undefined;
}

export function createRotatingOrigin(): RotatingOrigin {
  let issued = 0;
  let valid: string | undefined;
  const issue = () => (valid = `synthetic-session-${++issued}-0123456789`);
  return {
    login: issue,
    request: (token) => (token === valid ? issue() : undefined),
  };
}

/** The notes, and the origin that holds the sign-in state (the origin's own state, as in the other examples). */
export interface RotatingConfig extends ExampleConfig {
  origin: RotatingOrigin;
}

/** The session slot's value for `token`: one line, as the product stores it (I06S-D5). */
export const sessionValueOf = (token: string): string =>
  JSON.stringify({ cookies: { [SESSION_COOKIE]: token } });

/** The token inside a session slot's value; a value of another shape is a session that cannot be used. */
export function sessionTokenOf(value: string): string {
  let token: unknown;
  try {
    token = (JSON.parse(value) as { cookies?: Record<string, unknown> }).cookies?.[SESSION_COOKIE];
  } catch {
    throw new ConnectorCredentialError();
  }
  if (typeof token !== "string" || token === "") throw new ConnectorCredentialError();
  return token;
}

export function createRotatingSessionConnector(): Connector {
  const notes = createExampleConnector();
  let credentials: ConnectorCredentials | undefined;
  let origin: RotatingOrigin | undefined;

  /** One request to the origin: the stored session is read now, and the next one is stored before this returns. */
  async function request() {
    if (!credentials || !origin) throw new ConnectorError("not initialized", { retryable: false });
    if (!credentials.write) throw new ConnectorCredentialError();
    const next = origin.request(sessionTokenOf(await credentials.read(SESSION_SLOT)));
    if (next === undefined) throw new ConnectorCredentialError(); // the origin refused it: expired or signed out
    await credentials.write(SESSION_SLOT, sessionValueOf(next));
  }

  return {
    ...notes,
    async initialize(config: unknown, context?: ConnectorContext) {
      if (!context?.credentials.write) throw new ConnectorCredentialError();
      credentials = context.credentials;
      const { origin: held, ...rest } = config as RotatingConfig;
      origin = held;
      await request();
      await notes.initialize(rest);
    },
    async healthCheck() {
      try {
        // reads the session without a request: a request would spend the token
        sessionTokenOf((await credentials?.read(SESSION_SLOT)) ?? "");
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
      await request();
      return notes.getChanges(cursor, opts);
    },
  };
}
