// P02-T3 `docs.notifications`: the setting keys the docs name are the code's, and the docs the spec lists carry what
// they must: the site-setup item S44 (once, with the keys and the Windows points left unverified), ARCHITECTURE's
// storage row for the notification table, the I04 registry row of the kind `notification` (layer and place), and the
// docs index row for the spec. A separate file from the other site-setup tests.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const keys = [
  ...read("storage/src/notifications.ts").matchAll(/^\s+\w+: "(notifications\.\w+)",$/gm),
].map((m) => m[1]);

describe("docs.notifications (P02-T3)", () => {
  it("names the three setting keys the code reads in the site-setup table, and carries item S44 once with the Windows points", () => {
    expect(keys).toEqual(["notifications.os", "notifications.quietHours", "notifications.snoozeUntil"]);
    const site = read("docs/site-setup.md");
    for (const key of keys) expect(site).toContain(`| \`${key}\` |`);
    const items = [...site.matchAll(/^- \[[ x]\] \*\*S44 .*$/gm)];
    expect(items).toHaveLength(1);
    for (const point of ["AppUserModelID", "집중 지원", "트레이", "`notify`"]) {
      expect(items[0]?.[0]).toContain(point);
    }
  });

  it("ARCHITECTURE has the storage row, I04 the registry row, and the docs index the spec", () => {
    expect(read("docs/ARCHITECTURE.md")).toMatch(/^\| 알림 줄\(`notifications`\)과 알림 변경 순번\(`notify_state`/m);
    expect(read("docs/specs/2026-11-21-I04-invalidation.md")).toMatch(
      /^\| 알림 줄, digest 줄\(`notification`\) \| delivery \| canonical \|/m,
    );
    expect(read("docs/README.md")).toContain(
      "[specs/2026-11-23-P02-notifications-digest-timeline.md]",
    );
  });
});
