# ADR 0010: 저장 데이터 암호화의 범위와 키 보관

- 날짜: 2026-11-21 / 상태: **잠정 진행 — 사용자 확인 대기, 번복 시 V01-T03 재작업**. 비밀 값의 저장 방식은 V01-T11이 조사해 잠정으로 정했다(아래 "자격 증명 저장 방식의 조사"). 이것도 사용자 확인 대기이며, 번복하면 V01-T11의 쉘 저장소를 다시 만든다
- 관련: 원 설계 17절, 이슈 #15 R06-C3, 이슈 #16 V01-C5, [ARCHITECTURE "사용자 확인이 필요한 결정"·4절·8절](../ARCHITECTURE.md), 가정 A16, A19

## 맥락

원 설계 17절은 "OS 사용자별 데이터 격리", "로컬 데이터 암호화", "OS Credential Store 활용", "로그 내 민감 정보 제거"를 초기부터 고려하라고 한다. R06-C3은 암호화 대상, 키 저장, 백업 암호화, 임시 파일과 로그를 결정하라고 한다.

무엇으로부터 지키는지부터 나눈다.

| 위협 | 막는 수단 |
|---|---|
| 같은 PC의 다른 OS 사용자 | OS 사용자별 데이터 디렉터리와 파일 권한. macOS·Linux에서는 `storage`의 `ensureDataDirectory()`가 데이터 폴더를 소유자만 읽는 권한(0700)으로 만들고 넓으면 고치며, 정본 DB를 여는 V01-T04의 백엔드 구성이 이것을 부른다. Windows의 ACL 확인은 S11·H01 후속이다 |
| PC나 디스크를 잃어버림 | OS의 디스크 암호화. 또는 DB 파일 자체의 암호화 |
| 백업 파일이 다른 곳으로 복사됨 | 백업 파일 암호화 |
| 사용자 권한으로 도는 악성 프로그램 | 위 수단으로는 막지 못한다 |

정본 SQLite 파일을 통째로 암호화하려면 암호화를 지원하는 SQLite 빌드가 필요하다. **그런 구성요소는 [OSS_EVALUATION](../OSS_EVALUATION.md)에서 평가하지 않았다.** 평가하지 않은 네이티브 구성요소를 여기서 고르지 않는다. 본문 열만 앱에서 암호화하는 방법은 키워드 색인과 벡터에 내용이 그대로 남아 보호되는 것처럼 보이기만 한다.

**같은 잣대가 자격 증명 저장소에도 걸린다.** Electron을 거쳐 OS 자격 증명 저장소를 쓰는 구체적 방식도 OSS_EVALUATION이 평가하지 않았다. 그런데 비밀 값은 저장하지 않을 수 없으므로 여기서는 미루지 못한다. 그래서 방식의 조사를 V01-T11의 첫 산출물로 두고, 그 결과를 이 ADR에 적기 전에는 V01-C5의 자격 증명 부분을 충족했다고 하지 않는다.

## 결정

사용자가 확인하기 전까지 아래대로 진행한다.

| 대상 | Phase 1 | 뒤 단계 |
|---|---|---|
| 비밀 값(API 키 등) | **OS가 보호하는 키로 암호화한 암호문만** 데이터 디렉터리의 `secrets.json`(소유자 전용)에 둔다. 암호화는 Electron `safeStorage`이고 그 키를 OS가 지킨다(macOS 키체인, Windows DPAPI, Linux 비밀 서비스. 아래 조사). 평문은 SQLite, 설정 파일, 로그, 환경 파일, 임시 파일 어디에도 쓰지 않는다. OS 보호를 쓸 수 없으면 아무것도 저장하지 않고 평문으로 넘어가지 않으며 그 Provider를 "사용 불가"로 표시한다 | 같음. 실제 OS 보관함(Windows 자격 증명 관리자 등)에 값을 두려면 아래 조사의 다른 후보를 평가한다 |
| 정본 SQLite 파일 | **파일 단위 암호화 없음(평문).** OS 사용자별 디렉터리에 두고, 화면의 설정에 "데이터베이스 암호화: 적용 안 됨"을 그대로 보인다 | H01(#32) 전에 암호화 SQLite 드라이버를 조사·평가해 이 ADR을 고친다. SQL 드라이버 포트([ADR 0004](0004-embedded-storage.md)) 덕분에 상위 코드는 바뀌지 않는다 |
| 벡터 색인, 모델 캐시 | 암호화 없음. 벡터는 투영이고(Phase 1에는 구현도 없다) 모델은 공개 파일이다 | 정본과 같은 방식을 벡터에 적용할지 H01에서 정한다 |
| 백업 | Phase 1에 백업 기능 없음 | **백업 파일은 반드시 암호화한다.** 다른 PC에서 복원할 수 있어야 하므로 키는 사용자가 정한 암호구에서 만든다. 방식은 H01 spec |
| 임시 파일 | 가져온 내용을 임시 파일로 쓰지 않는다. CLI에는 stdin으로 준다. CLI가 요구하는 결과 파일은 작업마다 만든 임시 디렉터리에 두고 끝나면 지운다. CLI에는 세션을 디스크에 남기지 않는 옵션을 준다 | 같음 |
| 로그 | 원문, 프롬프트, 응답 본문, 비밀 값을 기록하지 않는다. 실패했을 때 CLI나 HTTP 서버가 돌려준 오류 내용에도 입력이 섞여 있을 수 있으므로 같은 규칙을 적용한다 | 같음 |
| 삭제한 원본 | 본문, 인용문, 색인 행을 지우고 지운 자리가 파일에 남지 않게 한다(V02) | 같음 |

**실제 업무 데이터 조건**: 정본 SQLite의 파일 단위 암호화가 들어가기 전에는, 배포처가 OS 디스크 암호화를 확인한 PC에서만 실제 업무 데이터를 넣는다([site-setup.md](../site-setup.md) S11). 공용 저장소의 개발과 테스트는 합성 데이터만 쓴다.

**V01-C5를 읽는 법.** 그 기준은 "R06에서 정한 로컬 데이터 암호화…를 첫 영속 데이터 경로에 적용"이라고 한다. R06이 정한 것은 이 표다. 따라서 Phase 1에서 그 문장이 뜻하는 것은 "비밀 값이 OS가 보호하는 키로 암호화된 형태로만 디스크에 있고(아래 조사가 이 뜻을 정한다), 정본 파일은 암호화되어 있지 않으며 그 사실이 화면에 표시된다"이다. 이 저장소의 다른 문서가 "OS 자격 증명 저장소에만"이라고 쓴 곳도 이 뜻이다. **정본 파일의 암호화는 Phase 1에 없고, 이것은 원 설계 17절의 "로컬 데이터 암호화"보다 약하다.** 배포처 실행으로 해소되는 문제가 아니라 사용자의 결정과 드라이버 조사로 해소되는 문제다.

**독립 검토가 제기한 확인 사항 두 가지.** 처음에는 이 저장소의 근거 문서에 없어 확인하지 않은 채로 두었고, V01-T03과 V01-T11에서 문서로 확인해 적기로 했다.

- **(V01-T03에서 확인함) 데이터 디렉터리.** Electron이 Windows에서 기본으로 쓰는 사용자 데이터 디렉터리는 실제로 다른 PC로 따라다니는 위치다. Electron 문서에 따르면 `userData`의 기본값은 `appData` 아래 앱 이름 폴더이고, `appData`는 Windows에서 `%APPDATA%`다([Electron `app.getPath`](https://www.electronjs.org/docs/latest/api/app#appgetpathname)). Microsoft 문서는 `%APPDATA%`를 로밍 폴더(`FOLDERID_RoamingAppData`, `AppData\Roaming`)로, `%LOCALAPPDATA%`를 "로밍하지 않는 응용 프로그램의 데이터 보관소"(`FOLDERID_LocalAppData`, `AppData\Local`)로 적는다([KNOWNFOLDERID](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid), [CSIDL](https://learn.microsoft.com/en-us/windows/win32/shell/csidl)). 로밍 프로필은 회사 PC에서 서버에 복사되었다가 다른 PC에 내려받히는 프로필이다. 그래서 Electron 기본값을 쓰지 않고 `storage/src/data-directory.ts`가 위치를 직접 정한다.

  | OS | 위치 | 근거 |
  |---|---|---|
  | Windows | `%LOCALAPPDATA%\PKI`. 값이 없거나 절대 경로가 아니면 추측하지 않고 실패한다(`%APPDATA%`로 내려가지 않는다) | 위 Microsoft 문서 |
  | macOS | `~/Library/Application Support/PKI` | Apple은 앱이 사용자 대신 만들고 관리하는 데이터를 이곳에 두라고 한다([File System Programming Guide, Library 하위 디렉터리](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html)) |
  | Linux | `$XDG_DATA_HOME/PKI`. 값이 없거나 비었거나 상대 경로이면 `~/.local/share/PKI` | [XDG Base Directory 명세](https://specifications.freedesktop.org/basedir-spec/latest/)가 기본값과 "상대 경로는 무시한다"를 정한다 |

  남은 것: Apple은 폴더 이름을 앱의 bundle identifier로 하라고 권한다. bundle identifier는 패키징(R04)에서 정하므로 지금은 `PKI`를 쓴다. 배포처 PC가 `AppData\Local`을 로밍이나 폴더 리디렉션 대상으로 따로 설정했는지는 배포처 확인 항목이다([site-setup.md](../site-setup.md) S11).
- **(V01-T11에서 확인함) 보호 저장 기능.** 우려가 맞았다. 아래 "자격 증명 저장 방식의 조사"에 근거와 결정을 적고, 결정 표의 비밀 값 행을 그 실제 동작으로 다시 썼다.

### 자격 증명 저장 방식의 조사 (V01-T11, 2026-11-21)

**근거.** Electron 45.4.1의 `safeStorage` 문서(`docs/api/safe-storage.md`, 태그 v45.4.1)와 설치된 `electron.d.ts`의 `SafeStorage` 형식, GitHub 저장소 정보(2026-11-21 조회).

**`safeStorage`가 실제로 하는 일.** 문자열을 암호화한 바이트를 돌려주고, **그 바이트를 어디에 둘지는 앱이 정한다.** OS 보관함에 들어가는 것은 값이 아니라 암호화 키다.

| OS | 키를 지키는 것(문서) | 이 앱의 판정 |
|---|---|---|
| macOS | 키체인에 앱의 키를 둔다. 다른 앱은 사용자가 허락하지 않으면 그 키를 읽지 못한다. 서명이 일정하지 않은 빌드는 키체인이 매번 다시 묻는다 | 사용 가능. 서명은 R04·S12 |
| Windows | DPAPI. 같은 로그온 자격 증명을 가진 사용자만 푼다. **같은 사용자 세션에서 도는 다른 앱으로부터는 지키지 못한다** | 사용 가능. 위협 표의 "사용자 권한으로 도는 악성 프로그램"과 같은 한계 |
| Linux | kwallet·gnome-libsecret 같은 비밀 서비스. 없으면 **코드에 박힌 암호로 암호화**한다(`getSelectedStorageBackend()`가 `basic_text`) | `basic_text`와 준비 전의 `unknown`은 "사용 불가"로 본다 |

동기 API(`isEncryptionAvailable`·`encryptString`·`decryptString`)는 Electron 45에서 폐기 예정이고 46에서 없어진다고 문서가 적는다. 그래서 비동기 API(`isAsyncEncryptionAvailable`·`encryptStringAsync`·`decryptStringAsync`)를 쓰고, 복호화가 `shouldReEncrypt`를 알리면(키 교체) 다시 암호화해 저장한다.

**후보와 판정.**

| 후보 | 값이 놓이는 곳 | 판정 |
|---|---|---|
| Electron `safeStorage` | 앱 파일에 암호문, OS 보관함에 키 | **잠정 채택.** 이미 쓰는 Electron에 들어 있어 새 네이티브 모듈이 없다 |
| `keytar` | OS 보관함에 값 | 기각. 저장소가 2022-12-12에 보관(archived) 처리되었다 |
| `@napi-rs/keyring`(keyring-node, MIT, 활동 중) | OS 보관함에 값(Windows 자격 증명 관리자, macOS 키체인) | 보류. 글자 그대로의 "OS 자격 증명 저장소에만"에 맞지만 [OSS_EVALUATION](../OSS_EVALUATION.md)이 평가하지 않은 네이티브 모듈이다. 위 "평가하지 않은 구성요소를 고르지 않는다"는 잣대에 걸린다 |
| OS 명령(`security`, `cmdkey`) 실행 | OS 보관함에 값 | 기각. 값이 명령줄 인자에 실려 같은 사용자의 다른 프로세스가 읽을 수 있다 |

**잠정 결정과 그 동작.**

- 쉘(main 프로세스)만 저장소를 가진다. 화면은 preload의 `setSecret`·`hasSecret`·`deleteSecret`으로 저장·확인·삭제만 하고 값을 다시 읽는 함수는 없다. 백엔드는 Provider가 보내기 직전에 쉘에 묻고(전용 통로의 `secret-request`) 값을 그 호출에만 쓰며 저장하지 않는다.
- 파일은 데이터 디렉터리(로밍하지 않는 OS 사용자별 위치, 0700)의 `secrets.json`이다. 소유자만 읽는 권한(0600)으로 새 파일을 쓴 뒤 바꿔 넣는다. Electron 기본 `userData`(Windows에서 로밍 폴더)에 두지 않는다: 암호문이 다른 PC로 따라간다.
- OS 보호를 쓸 수 없거나, 파일을 이 저장소의 형식으로 읽을 수 없거나, 복호화가 실패하면 "사용 불가"다. 읽을 수 없는 파일은 덮어쓰지 않는다(사용자의 키가 들어 있을 수 있다). 삭제는 OS 보호 없이도 된다.
- **API 키는 입력할 때의 엔드포인트 호스트에 묶인다.** 저장 이름이 호스트에서 나오므로(`openai-compatible.api-key.<호스트의 SHA-256 앞 32자리>`), 주소를 다른 호스트로 바꾸면 그 호스트의 키가 없어 아무것도 보내지 않는다. 세션 토큰을 가진 화면은 주소를 바꾸고 동의할 수는 있지만 값을 읽을 수 없으므로 키를 새 호스트로 옮기지 못한다. 사용자가 새 호스트에 쓸 키를 다시 입력해야 한다. 주소의 호스트가 바뀌면 다른 호스트의 키는 지운다(잠정): 옛 호스트로 되돌려도 그 키를 조용히 다시 쓰지 않고, 화면에서 볼 수도 지울 수도 없는 키가 파일에 남지 않는다. 지우지 못하면 주소도 바꾸지 않는다.
- 쉘은 백엔드가 읽을 수 있는 이름(OpenAI 호환 키의 이름 꼴)만 답한다. 상태 확인은 값이 아니라 존재만 묻고, 저장된 항목이 없으면 OS를 묻지 않는다.
- 브라우저 개발 환경(`backend/src/dev.ts`, 제품 빌드 밖)에는 쉘이 없으므로 `PKI_DEV_OPENAI_API_KEY_HOST`(엔드포인트 호스트)와 `PKI_DEV_OPENAI_API_KEY`를 호출할 때마다 읽고 그 호스트에만 준다. 저장하지 않는다.

**지켜볼 것(미검증).**

- **Windows의 `Local State`**: Chromium의 암호화 계층은 DPAPI로 감싼 `safeStorage` 키를 Electron `userData`(Windows에서 로밍되는 `%APPDATA%`)의 `Local State` 파일에 둔다고 알려져 있다(Chromium os_crypt 설계, 이 저장소에서 확인하지 않음). 암호문은 로컬에 남으므로 기밀이 새지는 않지만, 로밍 프로필 동기화가 그 키를 바꾸면 `secrets.json`을 풀지 못해 "사용 불가"가 된다(닫힌 쪽으로 실패). 배포처 S11에서 확인한다.
- **Linux의 확인 순서**: 비동기 암호기는 처음 쓸 때 초기화되므로 먼저 `isAsyncEncryptionAvailable()`을 묻고 그 뒤 `getSelectedStorageBackend()`를 읽는다. 그래도 `unknown`·`basic_text`이면 "사용 불가"다(닫힌 쪽). 실제 Linux에서는 확인하지 않았다.

**남은 것.** 실제 `safeStorage`는 이 저장소의 테스트에서 부르지 않는다(실제 키체인에 쓰지 않으려고 암호화 대역으로 시험한다). 그래서 개발 OS에서도 실제 키체인과의 동작은 미검증이고, 배포처 Windows의 DPAPI 동작은 S11이 확인한다(A16). 사용자가 "값 자체가 OS 보관함에 있어야 한다"고 정하면 `@napi-rs/keyring`을 평가해 쉘 저장소의 암호화 부분을 바꾼다(저장소 인터페이스는 그대로다).

OS 자격 증명 저장소는 Electron 쉘이 중개한다. 브라우저 개발 환경에는 쉘이 없으므로 비밀 값을 환경 변수로만 읽고 저장하지 않는다.

## 기각한 대안

| 대안 | 기각 이유 |
|---|---|
| 지금 암호화 SQLite 드라이버를 골라 넣음 | 평가하지 않은 네이티브 구성요소다. Windows 바이너리, 라이선스, 유지보수를 모른다 |
| 본문 열만 앱에서 암호화 | 키워드 색인과 벡터에 내용이 남는다. 검색을 포기하지 않는 한 보호가 되지 않는다 |
| 비밀 값을 암호화해 SQLite에 저장 | 키를 어디 둘지의 문제가 그대로 남는다. OS 자격 증명 저장소가 그 답이다 |

## 결과

- 디스크 암호화가 없는 PC를 잃어버리면 정본 파일을 읽을 수 있다.
- 사용자가 평문 시작을 받아들이지 않으면: 암호화 SQLite 드라이버 조사가 V01-T03의 선행 작업이 되고, T03이 이미 끝났다면 드라이버를 바꾸고 마이그레이션과 저장 테스트를 다시 돌린다. SQL 드라이버 포트 위의 코드는 바뀌지 않는다.
