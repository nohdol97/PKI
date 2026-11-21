// API client for the screens (V01-R3). Browser and Electron share it; they differ
// only in where the Session comes from (fetchDevSession here, the preload in T06).
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
  constructor(code: string, status: number) {
    super(`API ${status}: ${code}`);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export type ApiClient = <Name extends RouteName>(
  name: Name,
  ...input: RouteRequest<Name> extends undefined ? [] : [RouteRequest<Name>]
) => Promise<RouteResponse<Name>>;

export function createApiClient(session: Session, fetchImpl: typeof fetch = fetch): ApiClient {
  return async (name, ...[input]) => {
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
      throw new ApiError(parsed.success ? parsed.data.error : "internal-error", res.status);
    }
    return route.response.parse(body) as RouteResponse<typeof name>;
  };
}

export async function fetchDevSession(fetchImpl: typeof fetch = fetch): Promise<Session> {
  const res = await fetchImpl(DEV_SESSION_PATH);
  if (!res.ok) throw new Error(`dev session unavailable (${res.status})`);
  return SessionSchema.parse(await res.json());
}
