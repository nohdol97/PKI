# Phase 5 (Proactive Intelligence) 완료 Gate 검토

- 검토일: 2026-11-24 (origin/main `d1384090` 기준, 이슈 상태는 같은 날 `gh`로 측정)
- 범위: 공용(개인 저장소) 쪽에서 확인할 수 있는 것만 판정한다. 실제 Provider 해석, 실제 OS 알림(tray·toast), Windows 실행, 배포처 실행이 필요한 기준은 통과로 쓰지 않는다.
- 판정 말: `증거 있음` / `미검증 — Windows 필요` / `미검증 — 배포처 필요` / `미검증 — 보류(사유)` / `증거 없음`
- 증거 표기: PR 번호 뒤 괄호는 `origin/main`에 들어 있는 merge commit 짧은 SHA다.
- 이 문서는 시험 파일이 존재하는지까지만 확인했다. 이번 검토에서 시험을 다시 돌리지 않았다.

## 1. 대상

에픽 #7 `[Phase 5] Proactive Intelligence` (open). 하위 작업:

| 이슈 | 상태 | 라벨 |
|---|---|---|
| #27 [P01] Insight 발견·변경 감지·설명 가능한 Ranking | open | site-verify |
| #28 [P02] 알림·Digest·Timeline과 반복 억제 | closed | blocked |
| #29 [P03] Feedback Learning·교정과 선호 분리 | open | blocked |

에픽 체크박스는 #27 `[ ]`, #28 `[x]`, #29 `[ ]`이며 실제 상태(#27 open, #28 closed, #29 open)와 일치한다. 구현 작업은 모두 머지됐다: P01 #224 (`ce08aaa0`) #231 (`09014ea3`) #239 (`9b5488a0`) #256 (`c080d1da`) #262 (`5c1a703f`) #289 (`0b498f93`), P02 #275 (`5035150a`), P03 #253 (`cacbaf51`) #289 (`0b498f93`). #28이 closed인데 `blocked` 라벨이 그대로 붙어 있고, #29가 open이면서 `blocked` 라벨인 이유(P02·X01 선행)는 이미 풀려 있다(이슈 표류 참고).

## 2. 완료 기준별 증거

### P01 Insight 발견 (#27)

| 기준 | 근거 | 판정 |
|---|---|---|
| P01-C1a 지원 유형(일정 충돌·의존 업무 지연·의사결정 변경·충돌·미처리 요청·미해결 이슈·기회·정책 변화·새 관계·중요 변경)의 fixture와 코드 판정, 조건을 깨는 변형에서는 생기지 않음 | #224 (`ce08aaa0`) #231 (`09014ea3`) #239 (`9b5488a0`); `knowledge-engine/src/insight-code-rules.test.ts`, `knowledge-engine/src/insight-import.test.ts`, `knowledge-engine/src/dependency-delay.test.ts`, `fixtures/p01-insights.json`, `fixtures/p01-status.jsonl` | 증거 있음 |
| P01-C1b 13개 유형 표와 fixture 일치, 미지원 유형은 사유가 있고 Insight를 만들지 않음 | #224 (`ce08aaa0`); `packages/contracts/src/insight-types.test.ts`. 미지원은 `similar_resolution`, `related_document`, `missed_information` 세 유형(`packages/contracts/src/insight-types.ts`) | 증거 있음 |
| P01-C1 중 미지원 세 유형(유사 해결·관련 문서·놓친 정보) 자체의 발견 | 코드가 "지원 안 함"으로 선언. 사유 문구("유사도 검색이 없다", "검색이 없다")는 X01 검색 구현 이전에 쓴 것이라 지금도 맞는지는 확인하지 못했다 | 미검증 — 보류(지원 안 함으로 선언된 유형, 사유 문구 재확인 필요) |
| P01-C2a Insight schema·근거·reasoning_summary·사실/추론 구분, 철회 시 비움 | #224 (`ce08aaa0`) #231 (`09014ea3`); `knowledge-engine/src/insight-rules.test.ts`, `storage/src/insights.test.ts`, `packages/contracts/src/insight-types.test.ts`, `apps/web/src/evidence-view.test.tsx` | 증거 있음 |
| P01-C2b 여섯 축 ranking 결정성과 방향 | #224 (`ce08aaa0`); `knowledge-engine/src/insight-ranking.test.ts` | 증거 있음 |
| P01-C2c 모델 내부 사고과정 비저장(이유 요약 500자 상한, 정해진 키 밖 응답 거부) | #231 (`09014ea3`); `knowledge-engine/src/insight-interpret.test.ts`, `providers/src/broker.insight-interpret.test.ts` | 증거 있음 |
| P01-C3a 날짜·상태·dependency·dedup은 코드 판정, 해석만 LLM, 해석이 코드 판정을 바꾸지 않음 | #231 (`09014ea3`) #262 (`5c1a703f`); `knowledge-engine/src/insight-interpret.test.ts`, `backend/src/insight-interpret-flow.test.ts`, `storage/src/insight-interpretation.test.ts` | 증거 있음 |
| P01-C3b fingerprint 통합, 새 근거에 갱신·철회·되살림, 낮은 신뢰 Insight의 알림 제외 표시 | #224 (`ce08aaa0`) #262 (`5c1a703f`); `knowledge-engine/src/insight-code-rules.test.ts`, `backend/src/insight-api.test.ts`, `backend/src/read-gate.test.ts` | 증거 있음 |
| P01 실제 Provider의 Insight 해석, Windows(site-setup 해당 절) | 해석 시험은 fake Provider로 돈다. 실행 결과 없음 | 미검증 — 배포처 필요 |

### P02 알림·Digest·Timeline (#28, closed)

| 기준 | 근거 | 판정 |
|---|---|---|
| P02-C1a 즉시 알림·feed·daily digest·weekly report·timeline을 실 backend와 연결(API·화면) | #275 (`5035150a`); `backend/src/notify-flow.test.ts`, `knowledge-engine/src/notify-job.test.ts`, `apps/web/e2e/notifications.e2e.ts` | 증거 있음 |
| P02-C1b 실제 OS의 tray·토스트 | 셸 알림 시험은 모의 객체로 돈다: `apps/desktop/src/notifier.test.ts`, `apps/desktop/src/backend-process.notify.test.ts`. 실제 Electron 토스트·tray·ack 통로는 #28 댓글이 "미검증"으로 기록 | 미검증 — Windows 필요 |
| P02-C2a 중요 이유·연결 정보·근거·추론 여부·조치 표시, quiet hours·snooze·중복 억제, 낮은 신뢰 Insight는 즉시 발송 안 함 | #275 (`5035150a`); `knowledge-engine/src/notify-rules.test.ts`, `backend/src/notify-flow.test.ts`, `backend/src/notify-outbox.test.ts`, `apps/web/e2e/notifications.e2e.ts` | 증거 있음 |
| P02-C2b 잠금 화면 민감 내용·OS 권한 거부 | 실제 OS 권한 흐름은 시험하지 않았다(#28 댓글 "OS 권한 거부" 미검증) | 미검증 — Windows 필요 |
| P02-C3 재시도·재시작이 중복 발송하지 않음, 전송 직전 삭제·권한 재검사, 외부 변경을 승인 없이 하지 않음 | #275 (`5035150a`); `backend/src/notify-outbox.test.ts`, `backend/src/notify-gate.test.ts`, `backend/src/notify-no-egress.test.ts`, `knowledge-engine/src/notify-kind.test.ts`, `knowledge-engine/src/notify-job.test.ts` | 증거 있음 |
| P02 배포처 범위 정책의 `notify` 답(site-setup S44) | 실행 결과 없음 | 미검증 — 배포처 필요 |

### P03 Feedback Learning (#29)

| 기준 | 근거 | 판정 |
|---|---|---|
| P03-C1 피드백 여덟 종류 저장과 취소 가능한 적용 | #253 (`cacbaf51`); `storage/src/feedback.test.ts`, `backend/src/feedback-api.test.ts`, `apps/web/e2e/feedback.e2e.ts` | 증거 있음 |
| P03-C2a 정확성 교정은 지식·관계 검토로, 선호는 Insight ranking·알림으로 반영, "관련 없음"은 사실 삭제가 아님 | #253 (`cacbaf51`) #275 (`5035150a`) #289 (`0b498f93`); `knowledge-engine/src/insight-ranking.test.ts`, `backend/src/feedback-api.test.ts`, `backend/src/notify-gate.test.ts` | 증거 있음 |
| P03-C2b 선호의 검색 ranking 반영(X01-C1에서 검증) | #266 (`68a48c0e`); `knowledge-engine/src/retrieval/preference.test.ts`, `backend/src/ask-gate.test.ts` | 증거 있음 |
| P03-C3 사용자 교정이 재추출·Reflection 뒤에도 유지, 개인화 전후 평가 | #253 (`cacbaf51`); `knowledge-engine/src/feedback-lifecycle.test.ts`, `knowledge-engine/src/feedback-eval.test.ts` | 증거 있음 |
| P03 배포처 확인(site-setup S36), 개인화 효과의 실데이터 측정 | 실행 결과 없음. 평가는 합성 fixture(`fixtures/p03-personalization.json`) 위의 것이다 | 미검증 — 배포처 필요 |

## 3. 남은 항목

| 종류 | 항목 |
|---|---|
| 열린 후속 이슈(P01) | #221 첫 묶음 검토 지적 4건, #232 Insight 해석 지적과 켜는 길, #238 남은 낮은 지적 4건, #257 Wiki Insight 페이지·끝 항목 지적 |
| 열린 후속 이슈(P02) | #251 알림 백엔드 검토 지적 |
| 열린 후속 이슈(P03) | #252 피드백 검토 지적과 이어 붙일 곳, #287 Phase 5 후속 묶음 검토 지적 |
| 열린 하위 이슈 | #27(`site-verify`), #29(`blocked`, 이 라벨은 낡음). #28은 closed인데 `blocked` 라벨이 남아 있다 |
| 보류 | 없음(느린 정규화기 시험은 걸리지 않는다) |
| 의도적으로 하지 않은 것 | 초기 fine-tuning·RL은 P03 범위 밖(이슈 본문) |

## 4. 결론

공용 범위에서 확인된 것: Insight 발견·ranking·해석 분리(P01-C1a·b, C2a·b·c, C3a·b), 알림·Digest·Timeline의 백엔드와 화면·재발송 방지·직전 재검사(P02-C1a, C2a, C3), 피드백 저장·반영·유지·검색 순위 연결(P03-C1, C2a·b, C3)은 머지된 PR과 존재하는 시험 파일로 뒷받침된다.

남은 것: 실제 OS 알림과 권한 거부 흐름은 Windows에서, 실제 Provider 해석과 개인화 실측은 배포처에서만 확인된다. 지원 안 함으로 선언한 Insight 유형 셋이 남아 있다. 이 Phase의 Gate는 충족되었다고 선언하지 않는다.
