// Single schema source for the local HTTP API (V01-R2). The UI and the backend
// both import these; TypeScript types come from z.infer, JSON Schema from z.toJSONSchema.
import { z } from "zod";

export * from "./adapter-errors.ts";
export type * from "./knowledge-engine.ts";
export type * from "./vector-index.ts";
export * from "./connector.ts";
export * from "./provider.ts";

// Parts that later V01 tasks build report "not-implemented" until then, never a guessed state.
// "unavailable" names why, so the UI can show what does not work (V01-R5).
export const ComponentStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready") }),
  z.object({ state: z.literal("rebuilding") }),
  z.object({ state: z.literal("unavailable"), reason: z.string().min(1) }),
  z.object({ state: z.literal("not-implemented") }),
]);
export type ComponentStatus = z.infer<typeof ComponentStatusSchema>;

export const StatusResponseSchema = z.object({
  backend: ComponentStatusSchema,
  provider: ComponentStatusSchema,
  embedding: ComponentStatusSchema,
  vectorIndex: ComponentStatusSchema,
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.enum([
    "bad-request",
    "unauthorized",
    "forbidden-host",
    "forbidden-origin",
    "not-found",
    "method-not-allowed",
    "connector-unavailable",
    "internal-error",
  ]),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// "not-implemented" is a site Connector placeholder (V01-R18); "unavailable" failed to initialize.
export const ConnectorListResponseSchema = z.object({
  connectors: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      state: z.enum(["ready", "not-implemented", "unavailable"]),
    }),
  ),
});
export type ConnectorSummary = z.infer<typeof ConnectorListResponseSchema>["connectors"][number];

export const SyncRequestSchema = z.strictObject({ connectorId: z.string().min(1) });

/** `received` counts changes read; `created` the new source versions (same content makes none). */
export const SyncResponseSchema = z.object({
  connectorId: z.string(),
  received: z.int().nonnegative(),
  created: z.int().nonnegative(),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

// Screen reads (V01-R3). `id` is the source version shown: always the source's latest.
const SourceSummarySchema = z.object({
  id: z.int(),
  connectorId: z.string(),
  externalId: z.string(),
  title: z.string(),
});
export const SourceListResponseSchema = z.object({ sources: z.array(SourceSummarySchema) });
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

export const SourceSearchRequestSchema = z.strictObject({ query: z.string().min(1).max(200) });

/** One provider call attempt (ADR 0014: no body, prompt, response or secret). */
const ProviderCallSchema = z.object({
  requestId: z.string(),
  attempt: z.int().positive(),
  provider: z.string(),
  destination: z.string(),
  taskKind: z.string(),
  classification: z.string(),
  policyVersion: z.string(),
  outcome: z.string(),
  durationMs: z.int().nonnegative().nullable(),
  createdAt: z.string(),
});
export const ActivityResponseSchema = z.object({ calls: z.array(ProviderCallSchema) });
export type ProviderCall = z.infer<typeof ProviderCallSchema>;

/** Read-only for now; the settings the user can change arrive with T08–T10. */
export const SettingsResponseSchema = z.object({
  dataDirectory: z.string(),
  schemaVersion: z.int().nonnegative(),
});

/**
 * Where the screens get the backend address and token: the dev server in the browser,
 * the preload in Electron (V01-R3). An empty `baseUrl` means the page's own origin.
 */
export const SessionSchema = z.object({ baseUrl: z.string(), token: z.string().min(32) });
export type Session = z.infer<typeof SessionSchema>;

export const routes = {
  status: { method: "GET", path: "/api/status", response: StatusResponseSchema },
  connectors: { method: "GET", path: "/api/connectors", response: ConnectorListResponseSchema },
  syncConnector: {
    method: "POST",
    path: "/api/connectors/sync",
    request: SyncRequestSchema,
    response: SyncResponseSchema,
  },
  sources: { method: "GET", path: "/api/sources", response: SourceListResponseSchema },
  searchSources: {
    method: "POST",
    path: "/api/sources/search",
    request: SourceSearchRequestSchema,
    response: SourceListResponseSchema,
  },
  activity: { method: "GET", path: "/api/activity", response: ActivityResponseSchema },
  settings: { method: "GET", path: "/api/settings", response: SettingsResponseSchema },
} as const;
export type RouteName = keyof typeof routes;
export type RouteResponse<Name extends RouteName> = z.infer<(typeof routes)[Name]["response"]>;
export type RouteRequest<Name extends RouteName> = (typeof routes)[Name] extends {
  request: z.ZodType<infer Request>;
}
  ? Request
  : undefined;
