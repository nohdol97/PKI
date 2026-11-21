// The default Provider (V01-R9, V01-C4 "두 CLI가 모두 있으면 사용자가 기본 Provider를
// 고른다"; T10 handoff 8): the Broker calls the Provider the user chose, and none
// when nothing or an unbound name is chosen — never one picked on the user's behalf.
import { FakeProvider } from "@pki/testkit";
import { migrate, writeSetting } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_SETTING,
  readDefaultProvider,
  selectProvider,
  writeDefaultProvider,
} from "./provider-selection.ts";

const claude = new FakeProvider({ id: "claude-code", transport: "cli" });
const codex = new FakeProvider({ id: "codex", transport: "cli" });

function db() {
  const d = openBetterSqlite3(":memory:");
  migrate(d);
  return d;
}

describe("default Provider", () => {
  it("is unset at first, then what the user wrote", () => {
    const d = db();
    expect(readDefaultProvider(d)).toBeUndefined();
    writeDefaultProvider(d, "codex");
    expect(readDefaultProvider(d)).toBe("codex");
    writeDefaultProvider(d, "claude-code");
    expect(readDefaultProvider(d)).toBe("claude-code");
  });

  it("reads a value that names no Provider as unset", () => {
    const d = db();
    for (const value of ["", "bogus", "Codex", "codex ", "constructor"]) {
      writeSetting(d, DEFAULT_PROVIDER_SETTING, value);
      expect(readDefaultProvider(d), value).toBeUndefined();
    }
  });

  it("selects the chosen Provider among the bound ones", () => {
    expect(selectProvider([claude, codex], "codex")).toBe(codex);
    expect(selectProvider([claude, codex], "claude-code")).toBe(claude);
  });

  it("selects none without a choice, even when only one is bound", () => {
    expect(selectProvider([claude, codex], undefined)).toBeUndefined();
    expect(selectProvider([claude], undefined)).toBeUndefined();
  });

  it("selects none when the choice is not bound (no fallback to another)", () => {
    expect(selectProvider([claude, codex], "openai-compatible")).toBeUndefined();
    expect(selectProvider([], "codex")).toBeUndefined();
  });
});
