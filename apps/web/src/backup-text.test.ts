// H01-R16: every refusal code the backup routes can answer has one text, the key sets are the contract's
// lists, and the warnings the screen owes the user before a restore are all there.
import { BACKUP_FOLDER_REFUSALS, BACKUP_REFUSALS, RESTORE_REFUSALS } from "@pki/contracts";
import { expect, it } from "vitest";
import {
  BACKUP_FOLDER_REFUSAL_TEXT,
  BACKUP_REFUSAL_TEXT,
  BACKUP_WARNINGS,
  RESTORE_REFUSAL_TEXT,
  failureNotice,
  restoreResultText,
} from "./backup-text.ts";

it("has one text per refusal code of the three answers", () => {
  expect(Object.keys(BACKUP_FOLDER_REFUSAL_TEXT).sort()).toEqual(
    [...BACKUP_FOLDER_REFUSALS].sort(),
  );
  expect(Object.keys(BACKUP_REFUSAL_TEXT).sort()).toEqual([...BACKUP_REFUSALS].sort());
  expect(Object.keys(RESTORE_REFUSAL_TEXT).sort()).toEqual([...RESTORE_REFUSALS].sort());
});

it("owes the user the five warnings of R16", () => {
  const all = BACKUP_WARNINGS.join("\n");
  for (const part of ["암호구를 잃으면", "비밀 값", "다시 시작", "이전 version", "먼저 백업"]) {
    expect(all).toContain(part);
  }
});

it("reports what the restore did in its own numbers", () => {
  const text = restoreResultText({
    backupId: "b",
    stagedAt: "2026-11-23T00:00:00.000Z",
    appliedAt: "2026-11-23T00:01:00.000Z",
    backupCreatedAt: "2026-11-22T00:00:00.000Z",
    reapplied: 3,
    pausedLocations: 2,
    clearedConsents: 1,
    embeddingSpaceDiffers: true,
  });
  expect(text).toContain("삭제 3건");
  expect(text).toContain("폴더 2곳");
  expect(text).toContain("동의 1건");
  expect(text).toContain("임베딩");
});

it("H01F-C2: a previous-data copy is warned about and cannot be dismissed; a rolled-back start says so only for the codes that rolled back", () => {
  const copy = failureNotice("restore-marker-unreadable", true);
  expect(copy?.closable).toBe(false);
  expect(copy?.text).toContain("이전 데이터 사본");
  expect(copy?.text).not.toContain("이전 데이터로 되돌렸습니다");
  expect(failureNotice(null, true)?.closable).toBe(false);
  expect(failureNotice("start-failed", false)).toMatchObject({ closable: true });
  expect(failureNotice("start-failed", false)?.text).toContain("이전 데이터로 되돌렸습니다");
  expect(failureNotice("staged-missing", false)?.text).not.toContain("이전 데이터로 되돌렸습니다");
  expect(failureNotice(null, false)).toBeNull();
});
