# R04 절차서: Windows 설치 파일 측정·점검 (배포처 실행용)

> **상태: 작성만 됨 — 실행된 적 없음. PowerShell 스크립트는 구문 검사도 하지 못했습니다**(작성한 기기에 PowerShell이 없었음). 처음 돌릴 때 문법 오류가 나면 그 줄을 고치는 것부터 시작합니다.
>
> **전제(꼭 읽기): 이 키트는 설치 파일을 만들지 않습니다.** 제품 코드가 아직 없어서 Electron + Local API 설치 파일(skeleton)은 V01(#16)이 만듭니다. 이 키트는 **그 설치 파일이 생겼을 때** 측정·점검하는 도구입니다. 설치 파일이 없으면 모든 스크립트가 `미구현, 배포처 후속: R04-S1`을 출력하고 종료 코드 3으로 끝납니다. 또 #13은 R05 기준이 정해지기 전에는 합격선을 두지 말라고 하므로, 이 키트는 **숫자만 모으고 합격선을 정하지 않습니다.**
>
> 스펙: [R04 스펙](../../docs/specs/2026-11-21-R04-windows-installer.md).

## 1. 이 검증이 하는 일

Windows 11에서 (1) Node, Python, Docker, DB 서버를 따로 설치하지 않은 **깨끗한 PC**에 설치·실행·제거가 되는지, (2) 시작 시간, 쉬고 있을 때(idle) CPU·메모리, 설치 크기가 얼마인지, (3) 앱을 두 번 켜도 하나만 뜨는지(단일 인스턴스), 닫으면 보조 프로세스까지 정상 종료되는지, (4) 제거 뒤 찌꺼기가 남는지, (5) 실행 파일에 서명이 있는지를 확인합니다.

## 2. 처음 나오는 말

| 말 | 뜻 |
|---|---|
| 설치 파일 / 무인(silent) 설치 | 설치 마법사 화면 없이 명령 한 줄로 설치하는 방식 |
| NSIS | electron-builder가 만드는 Windows 설치 파일 형식. 무인 설치 스위치(`/S` 등)는 형식마다 달라 설치 파일을 받은 뒤 문서로 확인합니다(잠정 예시일 뿐) |
| 단일 인스턴스 | 앱을 두 번 실행해도 프로세스 묶음이 하나만 있는 것 |
| 정상 종료(graceful stop) | 강제로 죽이지 않고 "닫아 달라"는 요청으로 끝나는 것 |
| worker | 앱 본체 옆에서 일하는 보조 프로세스(예: Python 엔진). 본체가 죽을 때 같이 사라져야 합니다 |
| idle | 사용자가 아무것도 하지 않고 앱만 켜 둔 상태 |
| RSS(working set) | 프로세스가 실제로 차지한 메모리. 프로세스 묶음 전체를 합치면 공유 메모리가 중복되어 실제보다 크게 나옵니다 |
| Authenticode / SmartScreen / Smart App Control | 실행 파일 서명 방식 / 서명·평판이 없는 프로그램에 경고를 띄우는 Windows 기능 / 서명이 없는 파일을 막는 Windows 기능 |

## 3. 준비

1. **깨끗한 Windows 11 가상 머신**(또는 초기화 가능한 PC)과 되돌릴 수 있는 **스냅샷**. 한 번 설치한 환경은 더 이상 깨끗하지 않으므로 시험마다 스냅샷으로 되돌립니다.
2. V01 skeleton 설치 파일 1개. 두 번째 설치 실험(R04-C2)에는 R03 통과 후보의 Python/native 모듈을 담은 설치 파일이 따로 필요합니다(R04-S2).
3. `config.example.json`을 `config.json`으로 복사해 `<...>` 자리를 채웁니다: 설치 파일 경로, 무인 설치·제거 인자, 설치 폴더, 제품 exe 이름, 준비 신호(Local API 주소의 `/health` 같은 주소 또는 주 창 핸들), worker 프로세스 이름, round trip 요청.
4. PowerShell 5.1(Windows 11 기본). 이 PC에는 Python이 **없어야 합니다**(깨끗한 환경 점검 대상). 결과 정리용 Python은 다른 PC에서 씁니다.

## 4. 순서

`verification\r04-windows-installer\scripts` 폴더에서 PowerShell로, 같은 `-OutDir`를 쓰며 차례로 실행합니다(`python run.py plan`이 같은 순서를 보여 줍니다). 실행 정책 때문에 막히면 해당 세션에서만 `powershell -ExecutionPolicy Bypass -File .\01-preflight.ps1`처럼 한 번에 하나씩 실행합니다(시스템 정책 자체는 바꾸지 않습니다).

| 순서 | 스크립트 | 하는 일 | 기준 |
|---|---|---|---|
| 1 | `01-preflight.ps1` | Node/Python/Docker/DB 서버가 없는지 확인. 있으면 FAIL이고 이어서 진행하지 않음 | R04-C1 |
| 2 | `02-install-silent.ps1` | 설치 전 스냅샷 저장(로컬 전용), 무인 설치, 설치 파일·설치 후 크기 기록 | R04-C1, C3 |
| 3 | `08-roundtrip.ps1` | 합성 요청을 Local API로 보내 쓰기·읽기 확인 | R04-C1 |
| 4 | `03-startup-time.ps1` | 시작부터 준비 신호까지 시간을 N회 | R04-C3 |
| 5 | `04-idle-sampling.ps1` | 준비 뒤 idle에서 프로세스 묶음의 CPU·RSS를 일정 간격으로 표본 추출 | R04-C3 |
| 6 | `05-single-instance-stop.ps1 [-IncludeCrashTest]` | 두 번째 실행 처리, 정상 종료, worker 잔존, (선택) 본체만 강제 종료했을 때 worker가 남는지 | R04-C1, C2 |
| 7 | `07-signature-info.ps1` | 설치 파일과 설치 폴더의 exe/dll/node/sys/pyd 서명 상태 | R04-C3 |
| 8 | `06-uninstall-leftovers.ps1` | 무인 제거 뒤 설치 전 스냅샷과 비교해 **차이만** 기록 | R04-C1 |
| 9 | (수동) `CHECKLIST_MANUAL.md` | SmartScreen, 브라우저·Electron 화면 round trip, 트레이, 서명·업데이트 미확정 사항 | R04-C1, C3 |

결과는 `-OutDir`(기본 `..\r04-result`)의 `result.json` 하나에 쌓입니다. 시작 시간의 "콜드 스타트"는 재부팅 직후 첫 실행이며 스크립트가 재부팅할 수 없으므로 재부팅 뒤 `03`을 1회 돌려 첫 값을 따로 적습니다.

## 5. 결과 정리 (다른 PC에서)

PowerShell은 값을 만들 때부터 호스트 이름, 사용자 이름, 홈 경로를 자리표시자로 바꿉니다. 그래도 이슈에 붙이기 전에 한 번 더 거릅니다.

```text
python run.py sanitize --raw <r04-result>\result.json --out <정리된 폴더> [--redact <회사 이름 등>]
```

스키마가 틀렸거나 식별 값이 남아 있으면 파일을 쓰지 않고 실패합니다. 성공하면 `<정리된 폴더>`의 `result.json`, `result.md`만 이슈에 붙입니다. `snapshot-*.json`은 이 PC 안에서만 쓰는 파일이며 절대 붙이지 않습니다.

## 6. R04-C2 (두 번째 설치 실험)

R03에서 통과한 후보의 Python/native 모듈을 담은 설치 파일이 생기면 같은 스크립트를 쓰되 `config.json`의 `WorkerProcessNames`에 worker 프로세스 이름을 넣고 `05`를 `-IncludeCrashTest`로 돌립니다. 실행 파일·의존 라이브러리 확인은 `07`의 서명 상태 목록과 `02`의 설치 파일 수로 시작합니다. 이 설치 파일을 만드는 일은 이 키트에 없습니다(R04-S2, `python run.py second-installer`는 안내만 출력).

## 7. 하지 말아야 할 것

- 개발용 PC에서 돌리고 "Windows에서 통과"라고 쓰지 않습니다. 깨끗하지 않으면 01이 FAIL입니다.
- 회사 정책을 바꾸는 작업(실행 정책, 백신 예외 등록)을 이 키트가 요구하지 않습니다. 필요해 보이면 그 사실을 발견으로 기록합니다.
- 합격선을 임의로 정하지 않습니다(R05).
- 실제 업무 데이터를 앱에 넣지 않습니다.

결과 기록: [결과 양식](RESULT_TEMPLATE.md).
