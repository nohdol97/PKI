// The Settings screen's explanation of "백그라운드 실행" (I03-R17, ADR 0005 "사용자 확인
// 결과"): what a background run includes now that the scheduler starts work while the
// user is away, and which Providers the setting does and does not govern.
export const BACKGROUND_EXECUTION_TEXT =
  "켜면 격리가 검증된 CLI 조합이 백그라운드 작업을 실행합니다. 여기에는 가져오기 뒤의 추출과, " +
  "사용자가 자리에 없을 때 정해진 주기에 따라 자동으로 도는 작업이 모두 들어갑니다. " +
  "검증되지 않은 조합은 이 설정과 관계없이 백그라운드로 실행하지 않습니다. " +
  "API 키 Provider는 이 설정과 관계없이, 동의하고 전송 정책이 허용한 범위에서 같은 작업을 자동으로 실행합니다. " +
  "기본값은 끔입니다.";
