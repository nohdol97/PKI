// Single schema source for the local HTTP API (V01-R2). The UI and the backend
// both import these; TypeScript types come from z.infer, JSON Schema from z.toJSONSchema.
import { z } from "zod";

export * from "./adapter-errors.ts";
export type * from "./knowledge-engine.ts";
export type * from "./vector-index.ts";
export * from "./connector.ts";

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

export const routes = {
  status: { method: "GET", path: "/api/status", response: StatusResponseSchema },
  connectors: { method: "GET", path: "/api/connectors", response: ConnectorListResponseSchema },
  syncConnector: {
    method: "POST",
    path: "/api/connectors/sync",
    request: SyncRequestSchema,
    response: SyncResponseSchema,
  },
} as const;
export type RouteName = keyof typeof routes;
export type RouteResponse<Name extends RouteName> = z.infer<(typeof routes)[Name]["response"]>;
export type RouteRequest<Name extends RouteName> = (typeof routes)[Name] extends {
  request: z.ZodType<infer Request>;
}
  ? Request
  : undefined;
