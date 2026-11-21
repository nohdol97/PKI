"""Scenarios 1-3: schedule_dependency_delay, same_name_different_people, abbreviation_two_meanings."""


def s01(w):
    # --- I1: the design section 10 A/B example (mail + wiki + messenger) -----------------
    I = w.instance("S01-I1", "schedule_dependency_delay")
    I.rec("mailA", "mail",
          "안녕하세요, 한서윤입니다.\n\n오로라 프로젝트의 완료 목표는 2026-12-05입니다. 출시 전 최종 점검은 그 주에 진행할 예정입니다.\n\n감사합니다.\n한서윤 드림\n",
          "[오로라] 완료 목표 공유", "seoyun.han@example.test", "2026-11-03T10:12:00+09:00",
          participants=["seoyun.han@example.test", "team-aurora@example.test"], scope=["group:aurora-team"])
    I.rec("wikiB", "wiki",
          "# 오로라 프로젝트 구조\n\n오로라 프로젝트는 정산 API의 결제 승인 엔드포인트에 의존한다. 정산 API가 준비되기 전에는 오로라의 연동 테스트를 시작할 수 없다.\n\n담당: 한서윤 (프로젝트 오너)\n",
          "오로라 프로젝트 구조", "seoyun.han@example.test", "2026-10-20T14:00:00+09:00")
    I.rec("msgC1", "messenger", "정산 API 개발 일정 공유드립니다. 원래 목표는 2026-12-03이었습니다.",
          "정산 API 일정", "minjae.park@example.test", "2026-11-10T17:40:00+09:00",
          thread="thr-s01-i1-settlement", scope=["channel:settlement-api"])
    I.rec("msgC2", "messenger", "내부 이슈로 정산 API 개발 완료가 2026-12-10으로 연기되었습니다.",
          "정산 API 일정", "minjae.park@example.test", "2026-11-12T09:05:00+09:00",
          thread="thr-s01-i1-settlement", scope=["channel:settlement-api"])
    I.ent("proj", "Project", "오로라", [("mailA", "오로라 프로젝트"), ("wikiB", "오로라 프로젝트")])
    I.ent("sys", "System", "정산 API", [("wikiB", "정산 API"), ("msgC2", "정산 API")])
    I.ent("owner", "Person", "한서윤", [("mailA", "한서윤")])
    I.rel("proj", "DEPENDS_ON", "sys", [("wikiB", "오로라 프로젝트는 정산 API의 결제 승인 엔드포인트에 의존한다")])
    I.rel("owner", "RESPONSIBLE_FOR", "proj", [("wikiB", "담당: 한서윤 (프로젝트 오너)")])
    I.fact("proj", "target_date", "2026-12-05", "2026-11-03", None, "verified",
           [("mailA", "오로라 프로젝트의 완료 목표는 2026-12-05입니다")])
    old = I.fact("sys", "completion_date", "2026-12-03", "2026-11-10", "2026-11-12", "superseded",
                 [("msgC1", "원래 목표는 2026-12-03이었습니다")])
    I.fact("sys", "completion_date", "2026-12-10", "2026-11-12", None, "verified",
           [("msgC2", "정산 API 개발 완료가 2026-12-10으로 연기되었습니다")], supersedes=old)
    I.ins("dependency_delay", "오로라 목표 일정(2026-12-05)이 정산 API 지연(2026-12-10)으로 위험", True, ["proj", "sys"],
          [("mailA", "오로라 프로젝트의 완료 목표는 2026-12-05입니다"),
           ("wikiB", "오로라 프로젝트는 정산 API의 결제 승인 엔드포인트에 의존한다"),
           ("msgC2", "정산 API 개발 완료가 2026-12-10으로 연기되었습니다")])
    I.qa("오로라 프로젝트의 목표 일정에 영향을 줄 수 있는 지연이 있나?",
         ["오로라 프로젝트의 완료 목표는 2026-12-05", "오로라는 정산 API에 의존", "정산 API 완료가 2026-12-10으로 연기됨(목표보다 5일 늦음)", "확정 사실이 아니라 근거 기반 추론"],
         [("mailA", "오로라 프로젝트의 완료 목표는 2026-12-05입니다"),
          ("wikiB", "오로라 프로젝트는 정산 API의 결제 승인 엔드포인트에 의존한다"),
          ("msgC2", "정산 API 개발 완료가 2026-12-10으로 연기되었습니다")])
    I.qa("정산 API 개발 완료 예정일은?", ["2026-12-10"], [("msgC2", "정산 API 개발 완료가 2026-12-10으로 연기되었습니다")])

    # --- I2: dependency stated in wiki, delay in mail, target in messenger ------------------
    I = w.instance("S01-I2", "schedule_dependency_delay")
    I.rec("msgA", "messenger", "가람 앱 v3 출시 목표는 2026-12-15로 잡았습니다. 앱스토어 심사 기간은 이미 반영했어요.",
          "가람 v3 일정", "chaewon.yoon@example.test", "2026-11-05T11:20:00+09:00", scope=["channel:garam-app"])
    I.rec("wikiB", "wiki",
          "# 알림 게이트웨이 연동 명세\n\n가람 앱의 푸시 발송은 알림 게이트웨이(Notification Gateway)에 의존한다.\n게이트웨이가 발송을 제한하는 동안 가람 앱의 푸시 기능은 동작하지 않는다.\n",
          "알림 게이트웨이 연동 명세", "chaewon.yoon@example.test", "2026-10-28T16:30:00+09:00")
    I.rec("mailC", "mail",
          "인프라팀 장도훈입니다.\n\n인증서 교체 작업으로 알림 게이트웨이의 발송 기능이 2026-12-18까지 제한됩니다. 기존 안내했던 2026-12-08 복구 일정은 철회합니다.\n\n문의는 인프라팀 채널로 주세요.\n",
          "[공지] 알림 게이트웨이 발송 제한", "dohoon.jang@example.test", "2026-11-14T15:02:00+09:00",
          participants=["dohoon.jang@example.test", "all-dev@example.test"])
    I.rec("msgD", "messenger", "공지 확인했습니다. 출시 일정에 영향이 있는지 따로 살펴볼게요.",
          "가람 v3 일정", "chaewon.yoon@example.test", "2026-11-14T15:20:00+09:00", scope=["channel:garam-app"])
    I.ent("proj", "Project", "가람 앱 v3", [("msgA", "가람 앱 v3")], aliases=["가람"])
    I.ent("sys", "System", "알림 게이트웨이", [("wikiB", "알림 게이트웨이"), ("mailC", "알림 게이트웨이")], aliases=["Notification Gateway"])
    I.rel("proj", "DEPENDS_ON", "sys", [("wikiB", "가람 앱의 푸시 발송은 알림 게이트웨이(Notification Gateway)에 의존한다")])
    I.fact("proj", "target_date", "2026-12-15", "2026-11-05", None, "verified",
           [("msgA", "출시 목표는 2026-12-15로 잡았습니다")])
    o = I.fact("sys", "completion_date", "2026-12-08", "2026-11-01", "2026-11-14", "superseded",
               [("mailC", "기존 안내했던 2026-12-08 복구 일정은 철회합니다")])
    I.fact("sys", "completion_date", "2026-12-18", "2026-11-14", None, "verified",
           [("mailC", "발송 기능이 2026-12-18까지 제한됩니다")], supersedes=o)
    I.ins("dependency_delay", "알림 게이트웨이 제한(2026-12-18)이 가람 v3 출시 목표(2026-12-15)보다 늦음", True, ["proj", "sys"],
          [("msgA", "출시 목표는 2026-12-15로 잡았습니다"),
           ("wikiB", "가람 앱의 푸시 발송은 알림 게이트웨이(Notification Gateway)에 의존한다"),
           ("mailC", "발송 기능이 2026-12-18까지 제한됩니다")])
    I.qa("가람 v3 출시가 늦어질 수 있는 이유가 있나?",
         ["알림 게이트웨이 발송 제한이 2026-12-18까지", "출시 목표 2026-12-15", "가람 앱이 게이트웨이에 의존", "추론임"],
         [("msgA", "출시 목표는 2026-12-15로 잡았습니다"),
          ("wikiB", "가람 앱의 푸시 발송은 알림 게이트웨이(Notification Gateway)에 의존한다"),
          ("mailC", "발송 기능이 2026-12-18까지 제한됩니다")])

    # --- I3: English mail + Korean-format date ------------------------------------------
    I = w.instance("S01-I3", "schedule_dependency_delay")
    I.rec("mailA", "mail",
          "Hi team,\n\nThe target release for Project Mir is 2026-12-12. Please plan the final regression around that date.\n\nThanks,\nJian Noh\n",
          "Project Mir release target", "jian.noh@example.test", "2026-11-04T09:30:00+09:00",
          participants=["jian.noh@example.test", "team-mir@example.test"])
    I.rec("wikiB", "wiki",
          "# Project Mir 설계 메모\n\nMir의 로그인 흐름은 인증 서비스(Auth Service)의 token API에 의존한다. token API 없이는 로그인 통합 테스트가 불가능하다.\n",
          "Project Mir 설계 메모", "jian.noh@example.test", "2026-10-25T13:00:00+09:00")
    I.rec("msgC", "messenger", "인증 서비스 token API 개발 완료가 2026년 12월 18일로 밀렸습니다. 죄송합니다.",
          "token API 일정", "seungwoo.baek@example.test", "2026-11-13T18:10:00+09:00", scope=["channel:auth-team"])
    I.rec("mailD", "mail",
          "노지안님께,\n\n인증팀 백승우입니다. token API 일정이 밀린 점 공유드립니다. 자세한 내용은 인증팀 채널 공지를 참고해 주세요.\n",
          "token API 일정 공유", "seungwoo.baek@example.test", "2026-11-13T18:30:00+09:00",
          participants=["seungwoo.baek@example.test", "jian.noh@example.test"])
    I.ent("proj", "Project", "Project Mir", [("mailA", "Project Mir"), ("wikiB", "Mir")])
    I.ent("sys", "System", "인증 서비스", [("wikiB", "인증 서비스(Auth Service)"), ("msgC", "인증 서비스")], aliases=["Auth Service"])
    I.rel("proj", "DEPENDS_ON", "sys", [("wikiB", "Mir의 로그인 흐름은 인증 서비스(Auth Service)의 token API에 의존한다")])
    I.fact("proj", "target_date", "2026-12-12", "2026-11-04", None, "verified",
           [("mailA", "target release for Project Mir is 2026-12-12")])
    I.fact("sys", "completion_date", "2026-12-18", "2026-11-13", None, "verified",
           [("msgC", "token API 개발 완료가 2026년 12월 18일로 밀렸습니다")])
    I.ins("dependency_delay", "인증 서비스 token API 지연(2026-12-18)이 Mir 출시 목표(2026-12-12)를 위협", True, ["proj", "sys"],
          [("mailA", "target release for Project Mir is 2026-12-12"),
           ("wikiB", "Mir의 로그인 흐름은 인증 서비스(Auth Service)의 token API에 의존한다"),
           ("msgC", "token API 개발 완료가 2026년 12월 18일로 밀렸습니다")])
    I.qa("When is the token API expected to be done, and does it affect Project Mir?",
         ["token API 완료는 2026-12-18", "Mir 목표 2026-12-12보다 늦음", "Mir이 token API에 의존"],
         [("msgC", "token API 개발 완료가 2026년 12월 18일로 밀렸습니다"),
          ("wikiB", "Mir의 로그인 흐름은 인증 서비스(Auth Service)의 token API에 의존한다"),
          ("mailA", "target release for Project Mir is 2026-12-12")])

    # --- I4: dependency in messenger, delay in mail, target in a wiki table ---------------
    I = w.instance("S01-I4", "schedule_dependency_delay")
    I.rec("wikiA", "wiki",
          "# 2026 Q4 로드맵\n\n| 프로젝트 | 목표일 | 담당 |\n|---|---|---|\n| 새벽 | 2026-12-20 | 오태이 |\n| 하늘길 | 2027-01-15 | 문하람 |\n",
          "2026 Q4 로드맵", "taei.oh@example.test", "2026-10-15T10:00:00+09:00")
    I.rec("msgB", "messenger", "새벽은 로그 수집기 v2가 배포되어 있어야 시작할 수 있어요. v2 없이는 데이터 검증 단계가 막힙니다.",
          "새벽 선행 조건", "taei.oh@example.test", "2026-11-02T14:45:00+09:00", scope=["channel:dawn"])
    I.rec("mailC", "mail",
          "문하람입니다.\n\n로그 수집기 v2 배포를 2026-12-22로 미룹니다. 저장소 마이그레이션이 예상보다 오래 걸리고 있습니다.\n",
          "로그 수집기 v2 배포 일정 변경", "haram.moon@example.test", "2026-11-16T11:00:00+09:00",
          participants=["haram.moon@example.test", "all-dev@example.test"])
    I.ent("proj", "Project", "새벽", [("wikiA", "새벽"), ("msgB", "새벽")])
    I.ent("sys", "System", "로그 수집기 v2", [("msgB", "로그 수집기 v2"), ("mailC", "로그 수집기 v2")])
    I.rel("proj", "DEPENDS_ON", "sys", [("msgB", "새벽은 로그 수집기 v2가 배포되어 있어야 시작할 수 있어요")])
    I.fact("proj", "target_date", "2026-12-20", "2026-10-15", None, "verified", [("wikiA", "| 새벽 | 2026-12-20 | 오태이 |")])
    I.fact("sys", "deploy_date", "2026-12-22", "2026-11-16", None, "verified",
           [("mailC", "로그 수집기 v2 배포를 2026-12-22로 미룹니다")])
    I.ins("dependency_delay", "로그 수집기 v2 배포(2026-12-22)가 새벽 목표(2026-12-20)보다 늦음", True, ["proj", "sys"],
          [("wikiA", "| 새벽 | 2026-12-20 | 오태이 |"),
           ("msgB", "새벽은 로그 수집기 v2가 배포되어 있어야 시작할 수 있어요"),
           ("mailC", "로그 수집기 v2 배포를 2026-12-22로 미룹니다")])
    I.qa("새벽 프로젝트가 막힐 수 있는 선행 작업은?", ["로그 수집기 v2", "v2 배포가 2026-12-22로 연기", "새벽 목표는 2026-12-20"],
         [("msgB", "새벽은 로그 수집기 v2가 배포되어 있어야 시작할 수 있어요"),
          ("mailC", "로그 수집기 v2 배포를 2026-12-22로 미룹니다"),
          ("wikiA", "| 새벽 | 2026-12-20 | 오태이 |")])


def s02(w):
    # --- I1: two people named 서하윤 in different teams ----------------------------------
    I = w.instance("S02-I1", "same_name_different_people")
    I.rec("mailA", "mail",
          "서하윤입니다. 인증팀에서 토큰 회전 정책을 정리했습니다. 이번 주 안에 보안 점검 일정을 잡겠습니다.\n",
          "토큰 회전 정책", "hayoon.seo1@example.test", "2026-11-06T10:00:00+09:00")
    I.rec("mailB", "mail",
          "서하윤입니다. 영업지원팀 견적 템플릿을 개정했습니다. 새 양식은 다음 주부터 사용해 주세요.\n",
          "견적 템플릿 개정", "hayoon.seo2@example.test", "2026-11-06T11:30:00+09:00")
    I.rec("wikiC", "wiki",
          "# 인원 안내\n\n- 서하윤 (인증팀, 선임)\n- 서하윤 (영업지원팀, 매니저)\n- 정우진 (플랫폼팀, 팀장)\n",
          "인원 안내", "hr-bot@example.test", "2026-10-02T09:00:00+09:00")
    I.rec("msgD", "messenger", "서하윤 님, 토큰 만료 시간 정책 확인 부탁드립니다. 인증팀 점검 항목입니다.",
          "정책 확인", "woojin.jung@example.test", "2026-11-09T13:15:00+09:00", scope=["channel:security"])
    I.ent("p1", "Person", "서하윤(인증팀)", [("mailA", "서하윤"), ("wikiC", "서하윤 (인증팀, 선임)")])
    I.ent("p2", "Person", "서하윤(영업지원팀)", [("mailB", "서하윤"), ("wikiC", "서하윤 (영업지원팀, 매니저)")])
    I.ent("t1", "Organization", "인증팀", [("wikiC", "인증팀")])
    I.ent("t2", "Organization", "영업지원팀", [("wikiC", "영업지원팀")])
    I.pair(("mailA", "서하윤"), ("wikiC", "서하윤 (인증팀, 선임)"), "p1", "p1")
    I.pair(("mailA", "서하윤"), ("mailB", "서하윤"), "p1", "p2")
    I.pair(("msgD", "서하윤"), ("mailA", "서하윤"), "p1", "p1")
    I.pair(("msgD", "서하윤"), ("mailB", "서하윤"), "p1", "p2")
    I.rel("p1", "BELONGS_TO", "t1", [("wikiC", "서하윤 (인증팀, 선임)")])
    I.rel("p2", "BELONGS_TO", "t2", [("wikiC", "서하윤 (영업지원팀, 매니저)")])
    I.rel("p2", "BELONGS_TO", "t1", [("mailB", "서하윤입니다. 영업지원팀 견적 템플릿을 개정했습니다")], expected=False)
    I.qa("인증팀의 토큰 회전 정책은 누가 정리했나?", ["인증팀 서하윤(선임)"],
         [("mailA", "인증팀에서 토큰 회전 정책을 정리했습니다"), ("wikiC", "서하윤 (인증팀, 선임)")])

    # --- I2: same name, internal vs partner company; plus English transliteration ---------
    I = w.instance("S02-I2", "same_name_different_people")
    I.rec("mailA", "mail",
          "이도현입니다. 결제 모듈 배포 승인 요청드립니다.\n\nDohyun Lee, 플랫폼팀\n",
          "결제 모듈 배포 승인", "dohyun.lee@example.test", "2026-11-07T09:40:00+09:00")
    I.rec("mailB", "mail",
          "협력사 이도현입니다. 납품 일정 관련하여 문의드립니다.\n\n주식회사 가상물류 이도현 드림\n",
          "납품 일정 문의", "dohyun.lee@partner.example.test", "2026-11-07T10:05:00+09:00")
    I.rec("msgC", "messenger", "Dohyun이 승인 요청한 배포는 오늘 오후에 진행합니다.",
          "배포 일정", "yeonwoo.kang@example.test", "2026-11-08T08:50:00+09:00", scope=["channel:platform"])
    I.rec("wikiD", "wiki",
          "# 협력사 연락처\n\n- 가상물류: 이도현 담당자 (외부, partner.example.test)\n",
          "협력사 연락처", "ops-bot@example.test", "2026-09-12T10:00:00+09:00")
    I.ent("p1", "Person", "이도현(플랫폼팀)", [("mailA", "이도현"), ("mailA", "Dohyun Lee")], aliases=["Dohyun Lee"])
    I.ent("p2", "Person", "이도현(가상물류)", [("mailB", "이도현"), ("wikiD", "이도현 담당자")])
    I.pair(("mailA", "이도현"), ("mailA", "Dohyun Lee"), "p1", "p1")
    I.pair(("msgC", "Dohyun"), ("mailA", "Dohyun Lee"), "p1", "p1")
    I.pair(("mailA", "이도현"), ("mailB", "이도현"), "p1", "p2")
    I.pair(("mailB", "이도현"), ("wikiD", "이도현 담당자"), "p2", "p2")
    I.ent("o2", "Organization", "가상물류", [("mailB", "주식회사 가상물류")])
    I.rel("p2", "BELONGS_TO", "o2", [("mailB", "주식회사 가상물류 이도현")])
    I.rel("p1", "BELONGS_TO", "o2", [("mailA", "Dohyun Lee, 플랫폼팀")], expected=False)
    I.qa("결제 모듈 배포 승인을 요청한 사람은?", ["플랫폼팀 이도현(Dohyun Lee)"],
         [("mailA", "결제 모듈 배포 승인 요청드립니다"), ("mailA", "Dohyun Lee, 플랫폼팀")])

    # --- I3: same name, one person left, another joined ---------------------------------
    I = w.instance("S02-I3", "same_name_different_people")
    I.rec("wikiA", "wiki",
          "# 인사 변경 공지 (2026-10)\n\n- 박서준 (데이터팀): 2026-09-30 퇴사\n- 박서준 (인프라팀): 2026-10-01 입사\n",
          "인사 변경 공지 2026-10", "hr-bot@example.test", "2026-10-01T09:00:00+09:00")
    I.rec("mailB", "mail",
          "박서준입니다. 데이터 파이프라인 인수인계 문서를 공유드립니다. 마지막 근무일은 2026-09-30입니다.\n",
          "인수인계 문서", "seojun.park1@example.test", "2026-09-25T17:00:00+09:00")
    I.rec("mailC", "mail",
          "안녕하세요, 인프라팀에 합류한 박서준입니다. 모니터링 알림 정리 작업부터 시작합니다.\n",
          "합류 인사", "seojun.park2@example.test", "2026-10-02T09:30:00+09:00")
    I.rec("msgD", "messenger", "박서준 님한테 모니터링 알림 정리 요청드렸어요.",
          "모니터링", "haram.moon@example.test", "2026-10-20T15:00:00+09:00", scope=["channel:infra"])
    I.ent("p1", "Person", "박서준(데이터팀)", [("mailB", "박서준"), ("wikiA", "박서준 (데이터팀)")])
    I.ent("p2", "Person", "박서준(인프라팀)", [("mailC", "박서준"), ("wikiA", "박서준 (인프라팀)")])
    I.ent("t1", "Organization", "데이터팀", [("wikiA", "데이터팀")])
    I.ent("t2", "Organization", "인프라팀", [("wikiA", "인프라팀")])
    I.ent("task", "Task", "모니터링 알림 정리", [("mailC", "모니터링 알림 정리"), ("msgD", "모니터링 알림 정리")])
    I.rel("p1", "BELONGS_TO", "t1", [("wikiA", "박서준 (데이터팀): 2026-09-30 퇴사")], vu="2026-09-30")
    I.rel("p2", "BELONGS_TO", "t2", [("wikiA", "박서준 (인프라팀): 2026-10-01 입사")], vf="2026-10-01")
    I.rel("p2", "RESPONSIBLE_FOR", "task", [("mailC", "모니터링 알림 정리 작업부터 시작합니다")], vf="2026-10-02")
    I.rel("p1", "RESPONSIBLE_FOR", "task", [("msgD", "박서준 님한테 모니터링 알림 정리 요청드렸어요")], expected=False)
    I.pair(("mailB", "박서준"), ("mailC", "박서준"), "p1", "p2")
    I.pair(("msgD", "박서준"), ("mailC", "박서준"), "p2", "p2")
    I.pair(("msgD", "박서준"), ("mailB", "박서준"), "p2", "p1")
    I.fact("p1", "employment", "데이터팀 재직", None, "2026-09-30", "superseded",
           [("wikiA", "박서준 (데이터팀): 2026-09-30 퇴사")])
    I.fact("p2", "employment", "인프라팀 재직", "2026-10-01", None, "verified",
           [("wikiA", "박서준 (인프라팀): 2026-10-01 입사")])
    I.qa("2026-10-20 현재 모니터링 알림 정리를 맡은 박서준은 어느 팀인가?", ["인프라팀(2026-10-01 입사)"],
         [("msgD", "박서준 님한테 모니터링 알림 정리 요청드렸어요"), ("wikiA", "박서준 (인프라팀): 2026-10-01 입사")])


def s03(w):
    # --- I1: PG = Payment Gateway vs Project Group ------------------------------------
    I = w.instance("S03-I1", "abbreviation_two_meanings")
    I.rec("mailA", "mail", "PG 연동 장애로 오늘 오전 카드 승인 실패율이 올라갔습니다. 재시도 큐는 정상입니다.\n",
          "카드 승인 실패율", "minseo.go@example.test", "2026-11-09T11:00:00+09:00")
    I.rec("wikiB", "wiki", "# 용어집\n\n- PG: Payment Gateway, 카드 결제 승인을 중계하는 외부 서비스\n- PG(조직): 프로젝트 그룹(Project Group), 정례 회의를 가지는 팀 묶음\n",
          "용어집", "ops-bot@example.test", "2026-09-01T10:00:00+09:00")
    I.rec("msgC", "messenger", "다음 주 PG 회의는 목요일 오후 3시입니다. 프로젝트 그룹 안건만 다룹니다.",
          "PG 회의", "yuna.cha@example.test", "2026-11-10T09:00:00+09:00", scope=["channel:pmo"])
    I.rec("msgD", "messenger", "PG 쪽에서 장애 원인 회신 왔어요. 인증서 만료였다고 합니다.",
          "승인 실패", "minseo.go@example.test", "2026-11-09T14:30:00+09:00", scope=["channel:payments"])
    I.ent("c1", "System", "PG(결제 게이트웨이)", [("wikiB", "PG: Payment Gateway"), ("mailA", "PG")], aliases=["Payment Gateway"])
    I.ent("c2", "Organization", "PG(프로젝트 그룹)", [("wikiB", "PG(조직): 프로젝트 그룹(Project Group)"), ("msgC", "PG")], aliases=["Project Group"])
    I.pair(("mailA", "PG"), ("wikiB", "PG: Payment Gateway"), "c1", "c1")
    I.pair(("msgD", "PG"), ("mailA", "PG"), "c1", "c1")
    I.pair(("msgC", "PG"), ("mailA", "PG"), "c2", "c1")
    I.pair(("msgC", "PG"), ("wikiB", "PG(조직): 프로젝트 그룹(Project Group)"), "c2", "c2")
    I.rel("c2", "RELATED_TO", "c1", [("msgC", "PG 회의는 목요일 오후 3시입니다")], expected=False)
    I.qa("카드 승인 실패율 상승의 원인은?", ["결제 게이트웨이(PG)의 인증서 만료"],
         [("mailA", "PG 연동 장애로 오늘 오전 카드 승인 실패율이 올라갔습니다"), ("msgD", "인증서 만료였다고 합니다")])
    # --- I2: SR = Service Request vs Security Review ----------------------------------
    I = w.instance("S03-I2", "abbreviation_two_meanings")
    I.rec("mailA", "mail", "SR-2041 처리 현황을 공유합니다. 고객 계정 이전 요청이며 담당자는 배정되었습니다.\n",
          "SR-2041 현황", "jiho.ahn@example.test", "2026-11-04T10:30:00+09:00")
    I.rec("wikiB", "wiki", "# 약어 안내\n\n- SR (서비스 요청, Service Request): 고객지원 티켓 유형\n- SR (보안 검토, Security Review): 릴리스 전 보안팀 검토 단계\n",
          "약어 안내", "ops-bot@example.test", "2026-08-20T10:00:00+09:00")
    I.rec("msgC", "messenger", "릴리스 4.3은 SR이 끝나야 배포할 수 있어요. 보안팀 검토 결과를 기다리는 중입니다.",
          "릴리스 4.3", "taeyang.min@example.test", "2026-11-11T16:00:00+09:00", scope=["channel:release"])
    I.rec("msgD", "messenger", "SR 큐에 신규 티켓 5건 들어왔습니다. 오늘 안에 분류하겠습니다.",
          "고객지원", "jiho.ahn@example.test", "2026-11-11T16:20:00+09:00", scope=["channel:support"])
    I.ent("c1", "Concept", "SR(서비스 요청)", [("wikiB", "SR (서비스 요청, Service Request)"), ("mailA", "SR-2041")], aliases=["Service Request"])
    I.ent("c2", "Concept", "SR(보안 검토)", [("wikiB", "SR (보안 검토, Security Review)"), ("msgC", "SR")], aliases=["Security Review"])
    I.pair(("mailA", "SR-2041"), ("wikiB", "SR (서비스 요청, Service Request)"), "c1", "c1")
    I.pair(("msgD", "SR"), ("mailA", "SR-2041"), "c1", "c1")
    I.pair(("msgC", "SR"), ("wikiB", "SR (보안 검토, Security Review)"), "c2", "c2")
    I.pair(("msgC", "SR"), ("msgD", "SR"), "c2", "c1")
    I.fact("c2", "blocker", "보안 검토 완료 대기", "2026-11-11", None, "verified",
           [("msgC", "릴리스 4.3은 SR이 끝나야 배포할 수 있어요")])
    I.qa("릴리스 4.3 배포를 막고 있는 SR은 어떤 의미인가?", ["보안 검토(Security Review)"],
         [("msgC", "릴리스 4.3은 SR이 끝나야 배포할 수 있어요"), ("wikiB", "SR (보안 검토, Security Review)")])
    # --- I3: DR = Disaster Recovery vs Design Review ------------------------------------
    I = w.instance("S03-I3", "abbreviation_two_meanings")
    I.rec("mailA", "mail", "DR 훈련을 2026-12-03에 진행합니다. 주 저장소를 보조 리전으로 전환하는 절차를 점검합니다.\n",
          "DR 훈련 공지", "sunwoo.baek@example.test", "2026-11-12T09:10:00+09:00", participants=["sunwoo.baek@example.test", "all-dev@example.test"])
    I.rec("wikiB", "wiki", "# DR 정의\n\n- DR = Disaster Recovery(재해 복구): 장애 시 보조 리전으로 서비스를 복구하는 계획\n- DR = Design Review(설계 검토): 구현 착수 전 설계 문서를 검토하는 회의\n",
          "DR 정의", "ops-bot@example.test", "2026-07-10T10:00:00+09:00")
    I.rec("msgC", "messenger", "신규 알림 기능 DR은 금요일입니다. 설계 문서를 미리 읽어 오세요.",
          "알림 기능 DR", "gaeun.shin@example.test", "2026-11-12T13:00:00+09:00", scope=["channel:design"])
    I.rec("msgD", "messenger", "DR 훈련 때 DB 복구 시간(RTO)을 측정합니다. 로그 수집 준비 부탁드립니다.",
          "DR 훈련", "sunwoo.baek@example.test", "2026-11-12T13:40:00+09:00", scope=["channel:infra"])
    I.ent("c1", "Concept", "DR(재해 복구)", [("wikiB", "DR = Disaster Recovery(재해 복구)")], aliases=["Disaster Recovery"])
    I.ent("c2", "Concept", "DR(설계 검토)", [("wikiB", "DR = Design Review(설계 검토)")], aliases=["Design Review"])
    I.ent("drill", "Event", "DR 훈련", [("mailA", "DR 훈련")])
    I.pair(("mailA", "DR"), ("wikiB", "DR = Disaster Recovery(재해 복구)"), "c1", "c1")
    I.pair(("msgD", "DR"), ("mailA", "DR"), "c1", "c1")
    I.pair(("msgC", "DR"), ("msgD", "DR"), "c2", "c1")
    I.pair(("msgC", "DR"), ("wikiB", "DR = Design Review(설계 검토)"), "c2", "c2")
    I.fact("drill", "start_date", "2026-12-03", "2026-11-12", None, "verified", [("mailA", "DR 훈련을 2026-12-03에 진행합니다")])
    I.qa("2026-12-03에 예정된 DR은 무엇인가?", ["재해 복구(Disaster Recovery) 훈련"],
         [("mailA", "DR 훈련을 2026-12-03에 진행합니다"), ("wikiB", "DR = Disaster Recovery(재해 복구)")])
