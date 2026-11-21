// Single schema source for the local HTTP API (V01-R2). The UI and the backend
// both import these; TypeScript types come from z.infer, JSON Schema from z.toJSONSchema.
import { z } from "zod";

// Parts that later V01 tasks build report "not-implemented" until then, never a guessed state.
export const ComponentStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready") }),
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
  ]),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const routes = {
  status: { method: "GET", path: "/api/status", response: StatusResponseSchema },
} as const;
export type RouteName = keyof typeof routes;
export type RouteResponse<Name extends RouteName> = z.infer<(typeof routes)[Name]["response"]>;
