# 최종 시나리오 증거 표

> 이 문서는 `eval/final-scenarios.json`에서 `pnpm check:scenarios --write`로 만든다. 손으로 고치지 않는다.
> **대역 통과는 실제 동작의 증거가 아니다.** 아래 "대역·개발 장비 증거"는 개발 장비에서 대역(mock)이나 Provider 없이 돈 시험이고, 설치본과 실제 Provider에서 확인된 것은 "설치본·실제 Provider 증거"뿐이다.
> `provider: none`은 그 시험 자체가 Provider도 대역도 부르지 않는다는 뜻이다. 시험이 읽는 미리 채운 자료는 이전에 대역이 만들었을 수 있다.

상태: 확인됨 0, 대역만 14, 증거 없음 0. 명세: [H03-C3](specs/2026-11-24-H03-C3-final-scenarios.md)

## FS01 설치 파일 설치

- 상태: mock-only
- 책임 작업: R04, H02
- Provider 호출: 안 함
- 대역·개발 장비 증거:
  - `apps/desktop/artifact/artifact.shell.e2e.ts` — "starts its backend on the user's data directory and ignores the switches" (e2e, none, dev)
  - `apps/desktop/artifact/artifact.contents.e2e.ts` — "the app folder is laid out for Electron" (e2e, none, dev)
  - `apps/desktop/e2e/lifecycle.e2e.ts` — "--pki-uninstall-data=delete is refused while PKI runs" (e2e, none, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - windows-installer: 설치 파일이 이 저장소에서 만들어지지 않는다. 증거는 개발 장비에서 띄운 앱 폴더이고, 깨끗한 Windows 11에서의 설치·실행·제거는 돌린 적 없다 ([절차](../verification/r04-windows-installer/RUNBOOK.md))
  - site: 설치 파일 서명과 배포 채널은 배포처의 몫이다(site-setup S12) ([절차](../docs/site-setup.md))

## FS02 기존 CLI 탐색

- 상태: mock-only
- 책임 작업: R02, V01
- Provider 호출: 함
- 대역·개발 장비 증거:
  - `backend/src/providers-api.test.ts` — "checks each Provider with the version and login status queries only" (unit, mock, dev)
  - `apps/web/e2e/connection-test.e2e.ts` — "with both CLIs found, the user picks the default and the next test goes to it" (e2e, mock, dev)
  - `apps/web/e2e/degraded.e2e.ts` — "no CLI, no model, no vector index: Home says so and guides" (e2e, none, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - real-provider: 실제 Claude Code·Codex CLI를 찾고 상태를 묻는 실행은 돌린 적 없다. 증거는 가짜 CLI다 ([절차](../verification/r02-cli-isolation/RUNBOOK.md))
  - windows-installer: Windows 설치본의 PATH 탐색은 확인하지 않았다 ([절차](../verification/r04-windows-installer/RUNBOOK.md))

## FS03 메일/메신저/Wiki형 데이터 import

- 상태: mock-only
- 책임 작업: I01, I02, V02
- Provider 호출: 안 함
- 대역·개발 장비 증거:
  - `backend/src/jsonl-import.test.ts` — "stores the three fixtures under their own instances with one queued extraction job each" (unit, none, dev)
  - `apps/web/e2e/jsonl-import.e2e.ts` — "imports a JSONL file on the Sources screen" (e2e, none, dev)
  - `apps/web/e2e/local-files.e2e.ts` — "local-files.e2e: approve a folder" (e2e, none, dev)
  - `backend/src/adapters/site-connectors.test.ts` — "yields not-implemented from checkConnector" (unit, none, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - site: 실제 메일·메신저·Wiki 수집기는 배포처 후속이다. 공용 저장소는 합성 JSONL과 로컬 파일 가져오기만 증명하고 site-* 수집기는 미구현을 답한다 ([절차](../verification/v02-site-flow/RUNBOOK.md))
  - windows-installer: 설치본에서의 가져오기는 실행한 적 없다 ([절차](../verification/v02-site-flow/RUNBOOK.md))

## FS04 의미 지식 추출

- 상태: mock-only
- 책임 작업: V02, S01
- Provider 호출: 함
- 대역·개발 장비 증거:
  - `knowledge-engine/src/extraction.test.ts` — "makes exactly one Provider call for one source version" (unit, mock, dev)
  - `backend/src/extraction-flow.test.ts` — "links A and B across the three imported sources into one inferred Insight with three evidence" (unit, mock, dev)
  - `apps/web/e2e/v02-flow.e2e.ts` — "v02-flow.e2e: import" (e2e, mock, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - real-provider: 실제 Provider의 추출 결과 형태와 품질은 모른다. 지식 품질 지표(EVALUATION 2.1)는 재지 않았다 ([절차](../verification/v02-site-flow/RUNBOOK.md))
  - windows-installer: 설치본에서의 수직 흐름은 실행한 적 없다 ([절차](../verification/v02-site-flow/RUNBOOK.md))

## FS05 출처 간 관계

- 상태: mock-only
- 책임 작업: V02, S02
- Provider 호출: 함
- 대역·개발 장비 증거:
  - `backend/src/extraction-flow.test.ts` — "links A and B across the three imported sources into one inferred Insight with three evidence" (unit, mock, dev)
  - `apps/web/e2e/explore.e2e.ts` — "explore.e2e: approve a candidate" (e2e, none, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - real-provider: 실제 Provider가 출처 사이의 관계를 만드는지 확인하지 않았다 ([절차](../verification/v02-site-flow/RUNBOOK.md))
  - windows-installer: 설치본에서는 실행한 적 없다 ([절차](../verification/v02-site-flow/RUNBOOK.md))

## FS06 개인 Semantic 자동 구성

- 상태: mock-only
- 책임 작업: S01, S02, S03
- Provider 호출: 함
- 대역·개발 장비 증거:
  - `storage/src/semantic-auto-verify.test.ts` — "moves a candidate to verified by the policy and nothing else" (unit, none, dev)
  - `backend/src/semantic-api.test.ts` — "lists items with their facts and relations, status" (unit, none, dev)
  - `apps/web/e2e/explore-curation.e2e.ts` — "explore-curation.e2e: filter" (e2e, none, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - real-provider: 정책이 올리는 후보는 추출에서 오므로 실제 Provider의 후보로는 확인하지 않았다 ([절차](../verification/v02-site-flow/RUNBOOK.md))
  - windows-installer: 설치본에서는 실행한 적 없다 ([절차](../verification/v02-site-flow/RUNBOOK.md))

## FS07 Graph/Wiki 증분 갱신

- 상태: mock-only
- 책임 작업: S02, K01
- Provider 호출: 함
- 대역·개발 장비 증거:
  - `backend/src/wiki-flow.test.ts` — "builds pages with openable evidence and a backlink" (unit, mock, dev)
  - `knowledge-engine/src/wiki-build-job.test.ts` — "writes only the changed pages and removes the page" (unit, none, dev)
  - `apps/web/e2e/wiki.e2e.ts` — "wiki.e2e: open a page" (e2e, none, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - real-provider: 들어오는 지식을 만드는 추출이 실제 Provider로 돈 적 없다 ([절차](../verification/v02-site-flow/RUNBOOK.md))
  - windows-installer: 설치본에서는 실행한 적 없다 ([절차](../verification/v02-site-flow/RUNBOOK.md))

## FS08 Reflection 새 관계

- 상태: mock-only
- 책임 작업: K02
- Provider 호출: 함
- 대역·개발 장비 증거:
  - `backend/src/lint-flow.test.ts` — "lists the missing link with evidence; accepting with a type" (unit, mock, dev)
  - `backend/src/lint-flow.test.ts` — "a started backend has the daily and the weekly period" (unit, mock, dev)
  - `knowledge-engine/src/reflection-refine-job.test.ts` — "stores the verdict whose quote is in the document" (unit, mock, dev)
  - `apps/web/e2e/lint.e2e.ts` — "lint.e2e: see a finding" (e2e, none, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - real-provider: 정제 판정을 실제 Provider로 받은 적 없다 ([절차](../verification/v02-site-flow/RUNBOOK.md))
  - windows-installer: 정기 실행이 Windows 절전·시계 변경 뒤에 도는지 확인하지 않았다(site-setup S19) ([절차](../docs/site-setup.md))

## FS09 다출처 Insight

- 상태: mock-only
- 책임 작업: P01
- Provider 호출: 함
- 대역·개발 장비 증거:
  - `backend/src/extraction-flow.test.ts` — "links A and B across the three imported sources into one inferred Insight with three evidence" (unit, mock, dev)
  - `knowledge-engine/src/insight-import.test.ts` — "gives one pending_request and one open_issue" (unit, mock, dev)
  - `backend/src/insight-api.test.ts` — "lists active Insights highest score first" (unit, none, dev)
  - `apps/web/e2e/evidence.e2e.ts` — "evidence.e2e: the Insight's three evidence" (e2e, mock, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - real-provider: 실제 Provider로 만든 Insight의 품질(EVALUATION 2.2)은 재지 않았다 ([절차](../docs/EVALUATION.md))
  - windows-installer: 설치본에서는 실행한 적 없다 ([절차](../verification/v02-site-flow/RUNBOOK.md))

## FS10 근거 있는 능동 전달

- 상태: mock-only
- 책임 작업: P02
- Provider 호출: 안 함
- 대역·개발 장비 증거:
  - `backend/src/notify-flow.test.ts` — "lists an important Insight as sent with its words" (unit, mock, dev)
  - `apps/desktop/src/notifier.test.ts` — "shows one toast with the fixed words" (unit, none, dev)
  - `apps/web/e2e/notifications.e2e.ts` — "notifications.e2e: read a card" (e2e, none, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - windows-installer: OS 토스트와 트레이는 가짜 Electron 객체로만 시험했고 Windows 설치본에서 띄워 보지 않았다(site-setup S44) ([절차](../docs/site-setup.md))

## FS11 피드백 개선

- 상태: mock-only
- 책임 작업: P03
- Provider 호출: 안 함
- 대역·개발 장비 증거:
  - `backend/src/feedback-api.test.ts` — "puts the liked Insight first among equals" (unit, none, dev)
  - `knowledge-engine/src/feedback-eval.test.ts` — "computes both metrics over the Insights without feedback" (unit, none, dev)
  - `apps/web/e2e/feedback.e2e.ts` — "feedback.e2e: mark an Insight irrelevant" (e2e, none, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - windows-installer: 설치본에서는 실행한 적 없다 ([절차](../docs/site-setup.md))

## FS12 근거 기반 자연어 답변

- 상태: mock-only
- 책임 작업: X01
- Provider 호출: 함
- 대역·개발 장비 증거:
  - `backend/src/ask-flow.test.ts` — "streams route, hits, answer, sentences, done" (unit, mock, dev)
  - `apps/web/e2e/ask.e2e.ts` — "ask.e2e: the hits" (e2e, mock, dev)
  - `eval/results/x01-dev-t0.json` (measure, none, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - real-provider: 실제 Provider의 답 인용 정확도와 답변 시간은 재지 않았다. 측정 파일도 답 없이 검색만 잰 것이다(site-setup S37) ([절차](../docs/site-setup.md))
  - windows-installer: 설치본에서는 실행한 적 없다 ([절차](../docs/site-setup.md))

## FS13 원본 삭제 파생물 갱신

- 상태: mock-only
- 책임 작업: I04, H01
- Provider 호출: 안 함
- 대역·개발 장비 증거:
  - `backend/src/source-deletion.test.ts` — "resolves and empties the Insight when the dependency's source is deleted" (unit, mock, dev)
  - `knowledge-engine/src/deletion.test.ts` — "writes a tombstone at the latest product version" (unit, none, dev)
  - `backend/src/derivative-coverage.test.ts` — "every table of the migrated schema is classified" (unit, none, dev)
  - `apps/web/e2e/v02-flow.e2e.ts` — "read-gate.e2e: right after a source is deleted" (e2e, mock, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - windows-installer: 설치본의 데이터 폴더 파일에서 지운 내용이 사라지는지 확인하지 않았다(site-setup S22) ([절차](../verification/v02-site-flow/RUNBOOK.md))

## FS14 재시작 작업 재개

- 상태: mock-only
- 책임 작업: I03, H02
- Provider 호출: 안 함
- 대역·개발 장비 증거:
  - `backend/src/job-kill.test.ts` — "finishes three jobs after a kill in the middle of one" (unit, none, dev)
  - `backend/src/boot.resume.test.ts` — "H02A-C7: registers the job of an overdue period" (unit, mock, dev)
  - `apps/desktop/e2e/lifecycle.e2e.ts` — "a backend that dies is restarted at a new address" (e2e, none, dev)
  - `eval/results/h03-c2-dev.json` (measure, mock, dev)
- 설치본·실제 Provider 증거:
  - 없음
- 차단 항목:
  - windows-installer: Windows에서의 강제 종료·절전·최대 절전·시계 변경 뒤 재개는 확인하지 않았다(site-setup S19) ([절차](../verification/v02-site-flow/RUNBOOK.md))
  - threshold: 기록된 유일한 측정(eval/results/h03-c2-dev.json)의 재시작 뒤 첫 작업까지가 약 120초로 통과선 60초를 넘는다. 개발 장비 값이고 그 뒤의 수정(#294)을 다시 재지 않았다 ([절차](../docs/EVALUATION.md))
