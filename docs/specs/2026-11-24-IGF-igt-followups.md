# 스펙: IGT 후속(IGF) — 색인 포트 타입 단언의 선택 필드 구멍과 정지 포트 오류 코드의 타입

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 IGF-D1~D2 포함)
- 관련: 이슈 #353(F1·F2), [IGT spec](2026-11-24-IGT-ingestion-guard-tests.md)(IGT-C1)
- 번호: 요구사항 `IGF-R<n>`, 완료 기준 `IGF-C<n>`, 결정 `IGF-D<n>`. 마이그레이션·계약 변경은 없다.
- 기준 코드: `origin/main` `a9d6c68e`.

## 배경

| 항목 | 근거(`파일:줄`) | 처리 |
|---|---|---|
| F1 IGT-C1의 `Same<>`는 서로 대입 가능한지만 봐서, 한쪽 인자 객체에 **선택** 필드가 더해지면 초록으로 남는다(검토자 실측) | `backend/src/local-files-connector.test.ts:56`~`:65` | IGF-R1 |
| F2 spawner가 없을 때의 정지 포트가 `code: "worker-failed"`를 포트 타입(`string`)으로만 확인해, 오타가 나면 `asSkipReason`에서 조용히 `corrupt`로 바뀐다 | `backend/src/composition.ts:813`~`:816` | IGF-R2 |

## 목표 / 비목표

- 목표: 위 두 컴파일 시점 가드가 실제로 어긋남을 잡게 한다.
- 비목표: 포트·계약 타입 자체를 바꾸는 것, 런타임 동작 변경.

## 요구사항

- **IGF-R1** IGT-C1 단언은 `updateEntry`의 `next`와 `insertEntry`의 `entry` 인자에 대해, 타입의 상호 대입 가능성에 더해 **키 집합**(`keyof`)이 양쪽에서 같은지도 확인한다.
- **IGF-R2** 정지 포트의 오류 코드 값은 `IsolatedErrorCode`를 만족해야 컴파일된다(`satisfies IsolatedErrorCode`).

## 완료 기준

| 기준 | 확인 | 변이(빨개져야 함) |
|---|---|---|
| IGF-C1 | `pnpm typecheck` 0, `pnpm exec vitest run backend/src/local-files-connector.test.ts` 초록 | `storage/src/local-files.ts`의 `EntryFields`에 선택 필드 하나 추가 → `pnpm typecheck` 실패, 오류 위치가 IGT-C1 단언 줄 |
| IGF-C2 | `pnpm typecheck` 0 | `backend/src/composition.ts`의 `"worker-failed"`를 `"worker-faild"`로 → `pnpm typecheck` 실패 |

## 잠정 결정

- **IGF-D1** 키 집합 비교는 시험 파일 안의 타입 별칭으로 둔다(공용 유틸을 새로 만들지 않음). 바꾸려면 `packages/testkit`으로 옮기면 된다.
- **IGF-D2** F2는 제품 코드 한 줄(`satisfies`)로 막는다. 런타임 동작은 같다.
