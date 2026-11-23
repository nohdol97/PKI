// API client for the screens (V01-R3). Browser and Electron share it; they differ
// only in where the Session comes from (loadSession: the shell's preload, else the
// dev server).
import {
  ErrorResponseSchema,
  routes,
  SessionSchema,
  type RouteName,
  type RouteRequest,
  type RouteResponse,
  type Session,
} from "@pki/contracts";

/** Served by the Vite dev server only (dev/dev-server.ts), never by the backend. */
export const DEV_SESSION_PATH = "/__pki/session";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** An approval's refusal reason (the body's `code`), which the error schema does not name (I02B-R5). */
  readonly detail: string | undefined;
  constructor(code: string, status: number, detail?: string) {
    super(`API ${status}: ${code}`);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export type ApiClient = <Name extends RouteName>(
  name: Name,
  ...input: RouteRequest<Name> extends undefined ? [] : [RouteRequest<Name>]
) => Promise<RouteResponse<Name>>;

/** What a stream reader needs of a client made by `createApiClient`: the routes table answers JSON only (X01-R10). */
export interface ApiConnection {
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
}
const connections = new WeakMap<ApiClient, ApiConnection>();
export const connectionOf = (api: ApiClient): ApiConnection | undefined => connections.get(api);

export function createApiClient(session: Session, fetchImpl: typeof fetch = fetch): ApiClient {
  const client: ApiClient = async (name, ...[input]) => {
    const route = routes[name];
    const authorization = `Bearer ${session.token}`;
    const res = await fetchImpl(
      `${session.baseUrl}${route.path}`,
      input === undefined
        ? { method: route.method, headers: { authorization } }
        : {
            method: route.method,
            headers: { authorization, "content-type": "application/json" },
            body: JSON.stringify(input),
          },
    );
    const body: unknown = await res.json();
    if (!res.ok) {
      const parsed = ErrorResponseSchema.safeParse(body);
      const detail = (body as { code?: unknown } | null)?.code;
      throw new ApiError(
        parsed.success ? parsed.data.error : "internal-error",
        res.status,
        parsed.success && parsed.data.error === "approval-rejected" && typeof detail === "string"
          ? detail
          : undefined,
      );
    }
    return route.response.parse(body) as RouteResponse<typeof name>;
  };
  connections.set(client, { baseUrl: session.baseUrl, token: session.token, fetchImpl });
  return client;
}

export async function fetchDevSession(fetchImpl: typeof fetch = fetch): Promise<Session> {
  const res = await fetchImpl(DEV_SESSION_PATH);
  if (!res.ok) throw new Error(`dev session unavailable (${res.status})`);
  return SessionSchema.parse(await res.json());
}

/** The part of the Electron preload's `window.pki` the screens use (apps/desktop bridge). */
export interface SessionBridge {
  getSession(): Promise<unknown>;
}

/** The shell's session when the preload is there (Electron), the dev server's otherwise. */
export async function loadSession(
  bridge: SessionBridge | undefined = (globalThis as { pki?: SessionBridge }).pki,
  fetchImpl: typeof fetch = fetch,
): Promise<Session> {
  return bridge ? SessionSchema.parse(await bridge.getSession()) : fetchDevSession(fetchImpl);
}
