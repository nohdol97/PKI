# ADR 0007: 패키징 — Electron + electron-builder(NSIS) + electron-updater

- 날짜: 2026-11-21 / 상태: **잠정 — 배포처 검증 대기**
- 관련: 원 설계 16절, [OSS_EVALUATION 4.1절·4.7절·4.8절](../OSS_EVALUATION.md), 이슈 #13(R04), 가정 A13, A14, A15

## 맥락

원 설계는 Windows 11 설치 파일, 자동 업데이트, 필요한 런타임 포함을 요구하고 "설치 파일 생성은 개발 초기부터 검증한다"고 한다. 조사 결과(빌드·실행 없음):

- electron-updater가 Windows에서 지원하는 자동 업데이트 대상은 NSIS뿐이다. Electron Forge에는 NSIS maker가 없다(4.1절, 4.7절 6번).
- 업데이트 검증은 서명자가 설정한 게시자 이름과 일치해야 하며, 서명 없는 업데이트는 검증을 끄지 않으면 실패한다(4.1절).
- SmartScreen 경고는 첫 릴리스에서 완전히 피할 수 없다. 평판은 파일 해시와 게시자 인증서로 쌓인다(4.7절 5번).
- electron-builder는 최근 사람 commit이 사실상 한 명에게 몰려 있다(4.1절).

## 결정

- 쉘은 **Electron**, 설치 파일은 **electron-builder의 NSIS**, 자동 업데이트는 **electron-updater**로 한다.
- **서명 정체성은 정하지 않았다.** 조직 인증서인지, 배포처의 내부 서명인지는 배포 주체에 달려 있다. 정해질 때까지 자동 업데이트는 구성만 하고 켜지 않는다.
- 업데이트를 받아 오는 주소는 설정 값이다. 공용 저장소의 기본값은 "없음(자동 업데이트 끔)"이다.
- **Windows 검증은 배포처에서 한다.** 다른 OS에서의 빌드 성공을 Windows 동작의 증거로 쓰지 않는다.

## 기각한 대안

| 대안 | 기각 이유 |
|---|---|
| Electron Forge | NSIS maker가 없어 electron-updater의 Windows 경로를 쓸 수 없다. **차선**으로 남긴다(4.8절) |
| Tauri | 절약은 Electron 런타임 크기뿐이고 Rust와 WebView2 처리가 추가된다(4.7절 8번, 추정) |
| 서명 없이 자동 업데이트 | 업데이트 검증을 꺼야 한다. 변조된 업데이트를 막을 수 없다 |

## 결과

- 패키징 구성과 배포처 실행 절차서는 R04(#13)의 사외 준비물이다. V01의 Electron 쉘이 그 입력이다.
- 설치 파일 크기, 압축률, 유휴 자원 사용량은 빌드해서 재기 전에는 모른다(4.6절).
- manifest 서명 검증(Ed25519, `apps/desktop/src/update.ts`)은 Authenticode(electron-updater의 게시자 검사)와 별개의 층이다. 어느 한쪽이 다른 쪽을 대신하지 않는다([H02 spec](../specs/2026-11-24-H02-common.md)).
- 번들한 `.dll`·`.node`가 기본으로 서명되는지, 서명 없는 바이너리를 Windows가 막는지는 확인이 필요하다(4.7절 4번, A14).
- electron-builder v27에 호환성이 깨지는 변경이 예고되어 있다(4.1절). 버전을 고정한다.
