# R02-C4 약관·허용 범위 확인 체크리스트 (R02-S1, 사람이 수행)

> **상태: 작성만 됨 — 실행된 적 없음.** 스크립트가 아니라 사람이 공식 문서를 읽고 기록합니다. `python run.py terms`는 이 파일을 안내하는 문구만 출력하고 비0으로 끝납니다. 근거: [CLI Provider 약관·격리 조사](../../docs/research/2026-11-21-cli-provider-terms-and-isolation.md) 3절, 8절.

질문은 하나입니다. **"사용자가 자기 구독으로 로그인한 CLI를, 제품이 사용자 몰래가 아니라 사용자 PC 안에서 자동으로(무인·예약) 띄워도 되는가?"** 조사 문서의 결론은 Anthropic은 "모호, 금지 쪽", OpenAI는 "모호"였고 이를 허용이나 금지로 바꾸지 않았습니다. 키 추출과 인증 우회는 어떤 경우에도 하지 않습니다.

## 1. 다시 읽을 공식 문서 (읽은 날짜와 버전 표기)

| 대상 | 문서 | 확인할 것 | 읽은 날짜 | 문구가 바뀌었나 |
|---|---|---|---|---|
| Anthropic | Claude Code 법무·준수 페이지(code.claude.com/docs/en/legal-and-compliance) | 제품 개발자의 구독 자격 증명 경유 금지, 최종 사용자의 수정되지 않은 바이너리 로그인 허용, 제품 안 실행 조건 | | |
| Anthropic | 소비자 약관(anthropic.com/legal/consumer-terms) | 자동화·비인간 접근 금지와 "명시적으로 허용" 예외 | | |
| Anthropic | Agent SDK 개요, 인증 문서 | "사전 승인된 경우 제외" 경로의 의미, setup-token 용도 | | |
| OpenAI | Codex 인증·CI 인증(developers.openai.com/codex/auth, /auth/ci-cd-auth) | ChatGPT 관리 인증이 허용되는 러너 조건 | | |
| OpenAI | Codex 비대화형 문서, app-server 문서 | `exec`의 저장된 인증 재사용, 호스트 제품용 인터페이스 | | |
| OpenAI | 이용약관(openai.com/policies/terms-of-use) | "자동 또는 프로그램적 추출" 조항과 Codex 예외 | | |

## 2. 벤더에 서면으로 물을 질문 (조사 문서 8절)

- Anthropic: 호스팅·재판매를 하지 않는 데스크톱 제품이 사용자의 Pro/Max 로그인으로 사용자 자신의 문서를 무인·예약 처리하기 위해 수정되지 않은 `claude -p`를 자식 프로세스로 띄워도 되는가? 이것이 "일반 개인 사용"과 "제3자 하네스" 중 어디에 해당하는가? "Unless previously approved"는 등록 경로를 제공하는가? `--restricted`는 구독 OAuth 로그인과 함께 지원되는가?
- OpenAI: 제3자 데스크톱 제품이 사용자의 ChatGPT 로그인으로 무인 예약 실행을 위해 `codex exec`(또는 app-server 관리형 로그인)를 띄워도 되는가? 이용약관의 프로그램적 추출 조항이 적용되는가? Windows 취소·자손 완료 계약과 샌드박스 모드별 최소 버전은?

## 3. 기록 양식 (이슈 #11에 붙임)

```text
벤더: <Anthropic|OpenAI>
확인한 공식 문구(짧은 인용 + URL + 읽은 날짜):
벤더 답변: <없음 | 수신일 + 요지>  (서면 답변이 없으면 "미확인"이라고 쓴다)
허용 판정: <허용 | 금지 | 모호 | 미확인>   # 모호를 허용으로 바꾸지 않는다
제품이 쓸 수 있는 경로: <API 키 | CLI 구독 | 벤더 계약 | 없음>
미확인으로 남은 것:
```

미확인은 지원으로 표시하지 않습니다. 이 확인이 끝나기 전에는 구독 로그인 기반 백그라운드 처리를 배포하지 않습니다(조사 문서 3.1절 결론).
