// Composition point: the one place that picks adapter implementations for the
// product (V01-R15). Entry points spread this into ServerOptions.
import { EmptyVectorIndex } from "@pki/storage";
import type { ServerOptions } from "./server.ts";

export function productAdapters(): Pick<ServerOptions, "vectorIndex"> {
  return { vectorIndex: new EmptyVectorIndex() };
}
