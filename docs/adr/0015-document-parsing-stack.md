# ADR 0015: 문서 파싱 구성 — 형식별 순수 JavaScript 파서, 압축 검사를 앞에

- 날짜: 2026-11-21 / 상태: **잠정**(배포처의 S16·S17 결과로 확정하거나 고친다)
- 관련: [I02-A spec](../specs/2026-11-21-I02-document-normalization.md), [OSS_EVALUATION 4.4절·4.8절](../OSS_EVALUATION.md), [REUSE_AND_BUILD.md](../REUSE_AND_BUILD.md), [ADR 0008](0008-security-baseline.md), [ADR 0009](0009-license.md), [ADR 0011](0011-sidecar-language.md), 이슈 #19(I02)

## 맥락

REUSE_AND_BUILD.md는 문서 파싱을 "잠정 기본값, Phase 2(I02)에서 결정"으로 남겼다. 후보는 pdfjs-dist(PDF), mammoth(DOCX), SheetJS CDN 또는 read-excel-file(XLSX), 복잡한 PDF에는 선택적 Docling이었다. I02-A가 파일 하나를 정규화하는 모듈을 만들면서 이를 정한다.

정할 때 본 조건:

- 설치 파일에 Python·네이티브 빌드를 끌어들이지 않는다(ADR 0001, 0007).
- 라이선스가 MIT 제품과 맞는다(ADR 0009).
- **배포처는 npm 미러로 설치할 가능성이 높다.** 레지스트리 밖의 tarball 주소에 기대는 의존성은 거기서 설치되지 않을 수 있다.
- 형식 고유의 위치(쪽, 시트·칸, 문단, 줄)를 얻을 수 있어야 한다.
- 실행 환경: 테스트는 저장소가 고정한 Node 24, 설치본의 백엔드는 Electron 45.4.1의 `utilityProcess`, 즉 Electron에 든 Node 24.22.3(Electron 배포 목록, 2026-11-21 조회)에서 돈다.

조사 근거는 2026-11-21의 설치·실행 시험이다(macOS arm64, Node 26.5.0. Windows는 미확인. Node 24.22.3에서는 이후 테스트 모음이 통과했다).

## 결정

| 형식·역할 | 고른 것 | 버전 | 라이선스 | 근거 |
|---|---|---|---|---|
| PDF | unpdf | 2.2.1 | MIT(담긴 PDF.js는 Apache-2.0) | PDF.js의 서버용 빌드(`dist/pdfjs.mjs`, Apache-2.0)를 담은 얇은 감싸개. 담긴 구성 요소의 Apache-2.0 고지는 ADR 0009의 고지 목록에 올린다. 네이티브 의존성 없음, 3.5 MB. `engines: node >=24`는 두 실행 환경을 모두 만족한다. 손으로 만든 한글·이모지 PDF에서 쪽별 글이 그대로 나왔다(ToUnicode 대응표가 있는 글꼴) |
| DOCX | mammoth | 1.13.0 | BSD-2-Clause | 순수 JavaScript, 유지되고 있다. 위치를 주지 않으므로 문서 나무를 걸어 문단 번호를 센다. 외부 파일 접근(`externalFileAccess`)을 끈다 |
| XLSX | read-excel-file | 9.3.20 | MIT | npm 레지스트리에 있고 2026-11에도 갱신된다. 칸 주소 대신 행·열 위치를 주지만 배열 위치가 시트의 실제 행·열과 같다는 것을 확인했다(`C3`의 값이 `data[2][2]`, 시트 이름 한글 그대로). 수식 칸은 저장된 계산값을 준다 |
| HTML | parse5 | 8.1.1 | MIT | 표준을 따르는 해석기이며 실행도 내려받기도 하지 않는다. 원문 위치(줄)를 준다 |
| Markdown | mdast-util-from-markdown | 2.1.0 | MIT | unified 없이 구문 나무와 줄 위치를 준다 |
| CSV | csv-parse | 7.0.3 | MIT | 의존성 없음. 레코드마다 원문 줄 번호를 준다 |
| 압축 검사(읽기) | yauzl | 3.4.0 | MIT | 압축을 풀지 않고 중앙 디렉터리의 선언 크기를 읽는다. 풀 때 실제 크기 검증은 코드가 `validateEntrySizes: false`로 끄고 바이트를 직접 세어 선언과 다르거나 한도를 넘으면 멈춘다 |
| 압축 다시 묶기, 시험 파일 생성 | fflate | 0.8.3 | MIT | 의존성 없음. 검사를 통과한 항목만으로 압축을 다시 묶어 파서에 넘긴다 |
| OOXML 속성(`core.xml`) | @xmldom/xmldom | 0.8.15(mammoth가 이미 쓰는 0.8 계열에 맞춘다) | MIT | 새 XML 해석기를 하나 더 들이지 않는다. pnpm의 엄격한 배치에서는 전이 의존성을 직접 불러올 수 없어 직접 의존성으로 둔다 |
| 형식 타입(개발용) | @types/mdast, @types/yauzl | 4.0.4, 3.4.0 | MIT | 개발 의존성이며 제품 묶음에 들어가지 않는다 |
| 인코딩 | UTF-8·UTF-16은 내장 `TextDecoder`, EUC-KR(CP949)은 iconv-lite | 0.7.3 | MIT | 감지 라이브러리 없이 BOM → 엄격한 UTF-8 → EUC-KR 순서로 푼다. **Node 24.22.3의 `TextDecoder("euc-kr")`는 CP949 확장 글자를 풀지 못한다**(바이트 `8C 63` "똠"이 `U+008C U+0063`으로 나온다. `windows-949`도 같은 해석기). iconv-lite의 `cp949`는 "똠"을 풀고 잘못된 바이트에는 U+FFFD를 낸다. 순수 JavaScript이고 설치 스크립트가 없으며 의존성이 `safer-buffer` 하나라서 Electron의 ICU 구성에도 기대지 않는다 |
| TXT, JSON | 내장 | — | — | |

어느 파서도 압축을 풀 때 크기를 제한하지 않는다. 그래서 **압축 검사는 파서 앞의 별도 단계**이며, 파서는 원래 바이트가 아니라 검사를 통과한 항목만으로 다시 묶은 압축을 받는다(I02-A spec R4).

## 기각한 대안

| 대안 | 기각 이유 |
|---|---|
| SheetJS 0.20.x(CDN tarball) | 칸 주소·수식까지 주는 가장 작은 선택지지만 npm 레지스트리에 없다. tarball 주소 설치는 미러에서 닿지 않을 수 있고 lockfile의 출처 확인과 `npm audit`을 깨뜨린다. 저장소에 내려받아 넣는 방법은 갱신 경로를 손으로 관리하게 만든다 |
| npm의 `xlsx` 0.18.5 | 2022-03-24에 멈춘 사본이다. 알려진 보안 권고가 0.19.3 이후에만 고쳐졌다 |
| exceljs 4.4.0 | 칸 주소를 주지만 마지막 배포가 2024-12-20이고 설치한 묶음에 `uuid`의 보통 등급 권고 2건이 있다. 23 MB |
| pdf-parse 2.4.5 | 네이티브 모듈(`@napi-rs/canvas`)을 필수로 끌어오고 오래된 PDF.js를 고정한다 |
| pdfjs-dist 직접 사용 | 38 MB. unpdf가 PDF.js를 안에 담고 있어 선택적 peer인 `pdfjs-dist`는 설치하지 않았고 필요하지도 않았다. 모자란 제어(글꼴 등)가 생기면 그때 바꾼다 |
| docx4js | 2024-09 이후 갱신이 없고 오래된 의존성을 끌어온다 |
| OOXML 직접 걷기(DOCX) | 위치는 가장 정확하지만 코드가 많다. mammoth의 문서 나무로 모자라면 바꾼다 |
| htmlparser2 | parse5의 가벼운 대안. 지금은 표준 준수와 줄 위치 쪽을 택했다 |
| jsdom, linkedom | 문서 실행 환경을 흉내 내는 도구다. 글만 뽑는 데 필요 없고 공격면만 넓다 |
| sanitize-html, DOMPurify | 화면에 그릴 HTML을 정리하는 도구다. 이 제품은 글자로만 그린다(ADR 0008) |
| remark-parse(unified) | 같은 해석기에 층 하나를 더할 뿐이다 |
| papaparse | 레코드의 원문 줄 번호를 주지 않는다 |
| chardet, jschardet(인코딩 감지) | 짧은 EUC-KR 표본을 잘못 알아봤다(chardet은 ISO-8859-6을 첫째로, jschardet은 확신도 0.17) |
| jszip 직접 사용 | 압축 해제 크기를 공개 API로 주지 않는다 |
| Docling, MarkItDown(Python) | Python 사이드카를 강제하고 Docling은 torch와 첫 사용 때 358 MB 모델 내려받기가 필요하다. 고품질 PDF·DOCX 처리가 필요해지면 선택적 사이드카로 따로 정한다([ADR 0011](0011-sidecar-language.md)) |
| PyMuPDF | AGPL이라 번들할 수 없다(ADR 0009) |

## 결과

- 고른 의존성은 모두 npm 레지스트리 패키지이고 설치 스크립트와 네이티브 모듈이 없다. 저장소의 테스트가 lockfile에 tarball·git 해석이 없다는 것을 확인한다(I02-A spec C12).
- 내장 `TextDecoder`만으로 EUC-KR을 풀려던 처음 결정은 Node 24.22.3에서의 실측(T01)으로 뒤집혔다. 인코딩 행과 아래 변경 이력을 본다.
- 스캔한 PDF는 글이 나오지 않는다(OCR 없음). 한계 표시로 알린다.
- Node 24.22.3(저장소가 고정한 버전)에서는 테스트 모음이 통과한다(검토에서 확인). 확인하지 못한 것: Windows 11에서의 실행, 설치본(Electron) 안에서의 EUC-KR 풀기, 한글 문서 실물에서의 PDF 글꼴 대응, 문서 보안(DRM)으로 감싼 파일의 동작, 압축 폭탄 앞에서 파서 자체의 메모리 동작(파서 앞의 검사로 막으므로 파서에 닿지 않게 했다). 미러에서의 설치는 S16에서, Windows 설치본에서의 EUC-KR 풀기·PDF 글꼴·DRM 파일은 S17에서 본다.
- 전이 의존성의 라이선스는 설치 묶음 전체를 읽어 GPL 전용이 없음을 봤다(jszip은 MIT 또는 GPL 중 MIT를 고른다). 법률 검토는 아니다(ADR 0009).
- **시간 상한이 없다(검토 B2).** 파서(micromark, PDF.js 등)는 시간을 묶지 않는다. 실측: 24 KB Markdown 14 s, 3.1 MB PDF CPU 359 s. I02-A에는 제품 호출자가 없어 받아들였다. 첫 제품 호출자(I02-B의 가져오기·폴더 훑기)는 폴더 훑기가 나가기 전에 정규화를 `worker_threads`(`resourceLimits`)나 utility process에서 제한 시간을 두고 돌리고 시간 초과 오류 코드를 더해야 한다.

## 변경 이력

| 날짜 | 변경 내용 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-21 | 최초 작성(잠정) | 이 문서 | I02-A의 문서 파싱 구성 결정 |
| 2026-11-21 | 인코딩 행을 UTF-8·UTF-16은 내장 `TextDecoder`, EUC-KR은 iconv-lite 0.7.3으로 고치고 기각 표의 iconv-lite 행을 지운다(spec 차이 D1) | 결정 표 "인코딩", 기각한 대안, 결과 | 저장소가 고정한 Node 24.22.3에서 `TextDecoder("euc-kr")`가 CP949 확장 글자(바이트 `8C 63` "똠")를 풀지 못해 기준 I02A-C3이 내장만으로는 통과할 수 없다. 처음 근거(표준의 `euc-kr`이 CP949를 포함한다)가 이 런타임에서는 성립하지 않았다 |
| 2026-11-21 | @xmldom/xmldom 0.8.15, @types/mdast 4.0.4를 의존성에 더하고, `pdfjs-dist`는 더하지 않는다고 적는다(spec 차이 D2) | 결정 표, 기각한 대안 | pnpm의 엄격한 배치가 직접 의존성을 요구하고 mdast 타입이 필요하다. unpdf는 PDF.js를 담고 있어 선택적 peer가 필요 없다 |
| 2026-11-21 | 검토 반영: yauzl 행을 "크기 검증은 코드가 직접 한다"로 고치고, unpdf 행에 담긴 PDF.js의 Apache-2.0을 적고, Node 24.22.3에서 테스트 모음이 통과한다는 것을 확인된 것으로 옮기고, 파서에 시간 상한이 없다는 위험과 I02-B의 작업자 격리 의무(실측 24 KB .md 14 s, 3.1 MB PDF 359 s)를 결과에 더한다. 압축 한도 기본값은 128 MiB·32 MiB로 낮춘다(spec 한도 표) | 결정 표(unpdf, yauzl), 결과 | 검토 A7, B8, B2, B3. yauzl 행이 코드(`validateEntrySizes: false`)와 어긋났고, PDF.js 고지는 ADR 0009의 목록에 필요하다 |
