// The open screens' refresh (P02-R16, D14, V02-T11's handover): one poll of `GET /api/changes`, three sequence
// numbers and the unread count, no text. While the window is visible it reads every few seconds (and once more
// when it becomes visible again); `key` changes when any number does, and a screen that lists `key` among its
// effect's inputs reads its own data again. A failed read leaves the last numbers: the screens show their own errors.
import type { RouteResponse } from "@pki/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "./api.ts";

/** Provisional (P02-D14). */
export const CHANGES_POLL_MS = 5_000;

type Changes = RouteResponse<"changes">;

export const changesKey = (c: Changes): string => `${c.sources}.${c.knowledge}.${c.notifications}`;

export function useChanges(api: ApiClient, intervalMs: number = CHANGES_POLL_MS) {
  const [changes, setChanges] = useState<Changes>();
  useEffect(() => {
    let stopped = false;
    const read = () =>
      api("changes").then(
        (next) => {
          if (!stopped) setChanges(next);
        },
        () => undefined,
      );
    void read();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void read();
    }, intervalMs);
    const visible = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [api, intervalMs]);
  return { key: changes ? changesKey(changes) : "", unread: changes?.unread ?? 0 };
}
