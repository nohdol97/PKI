// Pure route lookup: a path may carry several methods (e.g. settings read/write).
type Table = Record<string, { method: string; path: string }>;

export function matchRoute<T extends Table>(
  table: T,
  method: string | undefined,
  path: string,
): (keyof T & string) | { error: "not-found" | "method-not-allowed" } {
  const onPath = Object.entries(table).filter(([, route]) => route.path === path);
  const hit = onPath.find(([, route]) => route.method === method);
  if (hit) return hit[0];
  return { error: onPath.length > 0 ? "method-not-allowed" : "not-found" };
}
