import type { ApiClient } from "./api.ts";

/** Writes the interpret switch with the `autoVerify` read just now, so a value changed elsewhere is not undone. */
export const writeInsightInterpret = async (api: ApiClient, insightInterpret: boolean) => {
  const { autoVerify } = await api("semanticSettings");
  return api("setSemanticSettings", { autoVerify, insightInterpret });
};
