"""Scenarios 4-7: contradicting_statements, correction_supersedes, deletion, permission_revocation."""


def s04(w):
    # --- I1: two sources give different deploy dates, no resolution ----------------------
    I = w.instance("S04-I1", "contradicting_statements")
    I.rec("mailA", "mail", "결제 모듈 배포는 2026-12-01에 진행합니다. 인프라팀과 이미 조율했습니다.\n",
          "결제 모듈 배포 일정", "woojin.jung@example.test", "2026-11-08T10:00:00+09:00")
    I.rec("wikiB", "wiki", "# 결제 모듈 배포 계획\n\n배포 예정일: 2026-12-08\n담당: 윤채원\n",
          "결제 모듈 배포 계획", "chaewon.yoon@example.test", "2026-11-08T10:40:00+09:00")
    I.rec("msgC", "messenger", "배포일이 메일과 위키에서 다르게 적혀 있는데 어느 쪽이 맞나요?",
          "배포일 질문", "yeonwoo.kang@example.test", "2026-11-09T09:15:00+09:00", scope=["channel:platform"])
    I.ent("f1", "Fact", "결제 모듈 배포일 2026-12-01", [("mailA", "결제 모듈 배포는 2026-12-01에 진행합니다")])
    I.ent("f2", "Fact", "결제 모듈 배포일 2026-12-08", [("wikiB", "배포 예정일: 2026-12-08")])
    I.rel("f2", "CONTRADICTS", "f1", [("mailA", "결제 모듈 배포는 2026-12-01에 진행합니다"), ("wikiB", "배포 예정일: 2026-12-08")])
    I.fact("f1", "deploy_date", "2026-12-01", "2026-11-08", None, "disputed", [("mailA", "결제 모듈 배포는 2026-12-01에 진행합니다")])
    I.fact("f2", "deploy_date", "2026-12-08", "2026-11-08", None, "disputed", [("wikiB", "배포 예정일: 2026-12-08")])
    I.ins("conflicting_information", "결제 모듈 배포일이 메일(2026-12-01)과 위키(2026-12-08)에서 상충", True, ["f1", "f2"],
          [("mailA", "결제 모듈 배포는 2026-12-01에 진행합니다"), ("wikiB", "배포 예정일: 2026-12-08"),
           ("msgC", "배포일이 메일과 위키에서 다르게 적혀 있는데")])
    I.qa("결제 모듈 배포일은 언제인가?", ["메일은 2026-12-01", "위키는 2026-12-08", "두 출처가 상충하며 확정할 수 없음"],
         [("mailA", "결제 모듈 배포는 2026-12-01에 진행합니다"), ("wikiB", "배포 예정일: 2026-12-08")])
    # --- I2: two different owners ---------------------------------------------------------
    I = w.instance("S04-I2", "contradicting_statements")
    I.rec("wikiA", "wiki", "# 정산 배치 운영\n\n정산 배치 담당: 정우진\n장애 시 1차 연락: 정우진\n",
          "정산 배치 운영", "ops-bot@example.test", "2026-10-30T11:00:00+09:00")
    I.rec("mailB", "mail", "팀장 노지안입니다. 정산 배치 담당은 윤채원입니다. 장애 시 윤채원에게 먼저 연락해 주세요.\n",
          "정산 배치 담당 안내", "jian.noh@example.test", "2026-11-03T09:00:00+09:00", participants=["jian.noh@example.test", "all-dev@example.test"])
    I.rec("msgC", "messenger", "정산 배치 담당자 확인이 필요합니다. 야간 장애 대응표를 갱신해야 해요.",
          "담당자 확인", "gaeun.shin@example.test", "2026-11-04T10:10:00+09:00", scope=["channel:ops"])
    I.ent("batch", "System", "정산 배치", [("wikiA", "정산 배치"), ("mailB", "정산 배치")])
    I.ent("p1", "Person", "정우진", [("wikiA", "정우진")])
    I.ent("p2", "Person", "윤채원", [("mailB", "윤채원")])
    I.rel("p1", "RESPONSIBLE_FOR", "batch", [("wikiA", "정산 배치 담당: 정우진")])
    I.rel("p2", "RESPONSIBLE_FOR", "batch", [("mailB", "정산 배치 담당은 윤채원입니다")])
    I.fact("batch", "owner", "정우진", None, None, "disputed", [("wikiA", "정산 배치 담당: 정우진")])
    I.fact("batch", "owner", "윤채원", "2026-11-03", None, "disputed", [("mailB", "정산 배치 담당은 윤채원입니다")])
    I.ins("conflicting_information", "정산 배치 담당자가 위키(정우진)와 메일(윤채원)에서 다름", True, ["batch", "p1", "p2"],
          [("wikiA", "정산 배치 담당: 정우진"), ("mailB", "정산 배치 담당은 윤채원입니다")])
    I.qa("정산 배치 담당자는 누구인가?", ["위키는 정우진", "메일은 윤채원", "상충함"],
         [("wikiA", "정산 배치 담당: 정우진"), ("mailB", "정산 배치 담당은 윤채원입니다")])
    # --- I3: numbers differ by a factor of ten -------------------------------------------
    I = w.instance("S04-I3", "contradicting_statements")
    I.rec("wikiA", "wiki", "# 검색 서비스 현황\n\n월 요청량은 약 120만 건이다. 피크 시간대는 평일 오전 10시이다.\n",
          "검색 서비스 현황", "taeyang.min@example.test", "2026-10-22T10:00:00+09:00")
    I.rec("mailB", "mail", "지난달 검색 서비스 월 요청량은 약 12만 건으로 집계되었습니다. 용량 계획에 참고해 주세요.\n",
          "10월 검색 사용량", "minseo.go@example.test", "2026-11-02T14:00:00+09:00")
    I.rec("msgC", "messenger", "요청량 숫자가 위키랑 메일이 달라서 용량 산정이 안 되네요.",
          "용량 산정", "sunwoo.baek@example.test", "2026-11-03T11:05:00+09:00", scope=["channel:capacity"])
    I.ent("sys", "System", "검색 서비스", [("wikiA", "검색 서비스"), ("mailB", "검색 서비스")])
    I.ent("f1", "Fact", "월 요청량 120만 건", [("wikiA", "월 요청량은 약 120만 건이다")])
    I.ent("f2", "Fact", "월 요청량 12만 건", [("mailB", "월 요청량은 약 12만 건으로 집계되었습니다")])
    I.rel("f2", "CONTRADICTS", "f1", [("wikiA", "월 요청량은 약 120만 건이다"), ("mailB", "월 요청량은 약 12만 건으로 집계되었습니다")])
    I.fact("sys", "monthly_requests", "1200000", None, None, "disputed", [("wikiA", "월 요청량은 약 120만 건이다")])
    I.fact("sys", "monthly_requests", "120000", "2026-10-01", "2026-10-31", "disputed", [("mailB", "월 요청량은 약 12만 건으로 집계되었습니다")])
    I.ins("conflicting_information", "검색 서비스 월 요청량이 위키와 메일에서 10배 차이", True, ["sys", "f1", "f2"],
          [("wikiA", "월 요청량은 약 120만 건이다"), ("mailB", "월 요청량은 약 12만 건으로 집계되었습니다")])
    I.qa("검색 서비스의 월 요청량은?", ["위키는 약 120만 건", "메일은 약 12만 건", "상충함"],
         [("wikiA", "월 요청량은 약 120만 건이다"), ("mailB", "월 요청량은 약 12만 건으로 집계되었습니다")])


def s05(w):
    # --- I1: mail correction supersedes the earlier mail ---------------------------------
    I = w.instance("S05-I1", "correction_supersedes")
    I.rec("mailA", "mail", "다음 정기 회의는 2026-11-25 14:00에 진행합니다. 안건은 별도로 공유하겠습니다.\n",
          "정기 회의 일정", "taei.oh@example.test", "2026-11-10T09:00:00+09:00", thread="thr-s05-i1-meeting")
    I.rec("mailB", "mail", "정정합니다. 정기 회의는 2026-11-26 14:00입니다. 장소는 동일합니다.\n",
          "Re: 정기 회의 일정", "taei.oh@example.test", "2026-11-11T09:30:00+09:00", thread="thr-s05-i1-meeting")
    I.rec("msgC", "messenger", "정기 회의 수요일 말고 목요일로 바뀐 거 맞죠?", "회의 확인",
          "haram.moon@example.test", "2026-11-11T10:00:00+09:00", scope=["channel:team"])
    I.ent("old", "Fact", "정기 회의 2026-11-25 14:00", [("mailA", "2026-11-25 14:00")])
    I.ent("new", "Fact", "정기 회의 2026-11-26 14:00", [("mailB", "2026-11-26 14:00")])
    I.rel("new", "SUPERSEDES", "old", [("mailB", "정정합니다. 정기 회의는 2026-11-26 14:00입니다")])
    o = I.fact("old", "meeting_start", "2026-11-25T14:00:00+09:00", "2026-11-10", "2026-11-11", "superseded",
               [("mailA", "정기 회의는 2026-11-25 14:00에 진행합니다")])
    I.fact("new", "meeting_start", "2026-11-26T14:00:00+09:00", "2026-11-11", None, "verified",
           [("mailB", "정정합니다. 정기 회의는 2026-11-26 14:00입니다")], supersedes=o)
    I.ins("important_work_change", "정기 회의 일정이 2026-11-25에서 2026-11-26으로 정정됨", False, ["old", "new"],
          [("mailA", "정기 회의는 2026-11-25 14:00에 진행합니다"), ("mailB", "정정합니다. 정기 회의는 2026-11-26 14:00입니다")])
    I.qa("정기 회의는 언제인가?", ["2026-11-26 14:00", "이전 안내(2026-11-25)는 정정으로 대체됨"],
         [("mailB", "정정합니다. 정기 회의는 2026-11-26 14:00입니다")])
    # --- I2: wiki page edited (versions 1 and 2 of the same record) -----------------------
    I = w.instance("S05-I2", "correction_supersedes")
    I.rec("wikiA", "wiki", "# 공개 API 사용 정책\n\nAPI 호출 제한은 분당 100회이다.\n문의는 플랫폼팀으로 한다.\n",
          "공개 API 사용 정책", "yeonwoo.kang@example.test", "2026-10-05T10:00:00+09:00")
    I.rec("wikiA", "wiki", "# 공개 API 사용 정책\n\nAPI 호출 제한은 분당 300회이다. (2026-11-12 상향)\n문의는 플랫폼팀으로 한다.\n",
          "공개 API 사용 정책", "yeonwoo.kang@example.test", "2026-10-05T10:00:00+09:00", version=2, updated="2026-11-12T16:00:00+09:00")
    I.rec("msgB", "messenger", "공개 API 호출 제한이 올라갔다고 들었어요. 이제 분당 300회 맞죠?", "API 제한",
          "jiho.ahn@example.test", "2026-11-13T09:20:00+09:00", scope=["channel:platform"])
    I.ent("api", "System", "공개 API", [("wikiA", "공개 API", 1), ("wikiA", "공개 API", 2)])
    I.ent("old", "Fact", "호출 제한 분당 100회", [("wikiA", "분당 100회", 1)])
    I.ent("new", "Fact", "호출 제한 분당 300회", [("wikiA", "분당 300회", 2)])
    I.rel("new", "SUPERSEDES", "old", [("wikiA", "API 호출 제한은 분당 300회이다. (2026-11-12 상향)", 2)])
    o = I.fact("api", "rate_limit_per_minute", "100", "2026-10-05", "2026-11-12", "superseded",
               [("wikiA", "API 호출 제한은 분당 100회이다", 1)])
    I.fact("api", "rate_limit_per_minute", "300", "2026-11-12", None, "verified",
           [("wikiA", "API 호출 제한은 분당 300회이다", 2)], supersedes=o)
    I.qa("공개 API의 현재 호출 제한은?", ["분당 300회(2026-11-12 상향)", "이전 값 분당 100회는 대체됨"],
         [("wikiA", "API 호출 제한은 분당 300회이다", 2)])
    # --- I3: edited chat message ----------------------------------------------------------
    I = w.instance("S05-I3", "correction_supersedes")
    I.rec("msgA", "messenger", "이번 주 서버 점검 담당자는 최도윤입니다.", "점검 담당", "jian.noh@example.test",
          "2026-11-16T09:00:00+09:00", thread="thr-s05-i3-duty", scope=["channel:infra"])
    I.rec("msgA", "messenger", "이번 주 서버 점검 담당자는 강예린입니다. (수정됨)", "점검 담당", "jian.noh@example.test",
          "2026-11-16T09:00:00+09:00", version=2, updated="2026-11-16T09:12:00+09:00", thread="thr-s05-i3-duty", scope=["channel:infra"])
    I.rec("msgB", "messenger", "수정 확인했어요. 강예린 님이 맡는 걸로 일정에 반영했습니다.", "점검 담당", "haram.moon@example.test",
          "2026-11-16T09:20:00+09:00", thread="thr-s05-i3-duty", scope=["channel:infra"])
    I.rec("wikiC", "wiki", "# 서버 점검 당번표\n\n11월 3주차: 강예린\n11월 4주차: 최도윤\n", "서버 점검 당번표",
          "haram.moon@example.test", "2026-11-16T09:40:00+09:00")
    I.ent("p_old", "Person", "최도윤", [("msgA", "최도윤", 1), ("wikiC", "최도윤")])
    I.ent("p_new", "Person", "강예린", [("msgA", "강예린", 2), ("wikiC", "강예린")])
    I.ent("duty", "Task", "11월 3주차 서버 점검", [("msgA", "서버 점검", 2)])
    o = I.fact("duty", "assignee", "최도윤", "2026-11-16", "2026-11-16", "superseded", [("msgA", "서버 점검 담당자는 최도윤입니다", 1)])
    I.fact("duty", "assignee", "강예린", "2026-11-16", None, "verified", [("msgA", "서버 점검 담당자는 강예린입니다", 2),
           ("wikiC", "11월 3주차: 강예린")], supersedes=o)
    I.rel("p_new", "RESPONSIBLE_FOR", "duty", [("msgA", "서버 점검 담당자는 강예린입니다", 2)])
    I.rel("p_old", "RESPONSIBLE_FOR", "duty", [("msgA", "서버 점검 담당자는 최도윤입니다", 1)], expected=False)
    I.qa("이번 주 서버 점검 담당자는?", ["강예린", "최도윤은 수정 전 값"],
         [("msgA", "서버 점검 담당자는 강예린입니다", 2), ("wikiC", "11월 3주차: 강예린")])


def s06(w):
    # --- I1: sole source deleted -> derived fact must go ----------------------------------
    I = w.instance("S06-I1", "deletion")
    I.rec("mailA", "mail", "프로젝트 가람 예산은 3억 원으로 확정되었습니다. 외부 공개는 하지 말아 주세요.\n",
          "가람 예산 확정", "seoa.lee@example.test", "2026-11-05T10:00:00+09:00", scope=["group:finance-team"])
    I.rec("mailA", "mail", "", "가람 예산 확정", "seoa.lee@example.test", "2026-11-05T10:00:00+09:00",
          version=2, updated="2026-11-15T09:00:00+09:00", op="delete", scope=["group:finance-team"])
    I.rec("wikiB", "wiki", "# 프로젝트 가람 개요\n\n프로젝트 가람은 모바일 앱 v3를 개발하는 프로젝트이다.\n",
          "프로젝트 가람 개요", "chaewon.yoon@example.test", "2026-10-01T10:00:00+09:00")
    I.rec("msgC", "messenger", "가람 예산 관련 자료는 별도로 안내드리겠습니다.", "자료 안내",
          "seoa.lee@example.test", "2026-11-06T09:00:00+09:00", scope=["group:finance-team"])
    I.ent("proj", "Project", "가람", [("wikiB", "프로젝트 가람")])
    I.fact("proj", "budget_krw", "300000000", "2026-11-05", None, "removed",
           [("mailA", "프로젝트 가람 예산은 3억 원으로 확정되었습니다")], trigger=I.trig("mailA", 2))
    I.fact("proj", "description", "모바일 앱 v3 개발 프로젝트", None, None, "verified",
           [("wikiB", "프로젝트 가람은 모바일 앱 v3를 개발하는 프로젝트이다")])
    I.qa("프로젝트 가람의 예산은 얼마인가?", [], [("mailA", "프로젝트 가람 예산은 3억 원으로 확정되었습니다")],
         answerable=False, trigger=I.trig("mailA", 2))
    I.qa("프로젝트 가람은 무엇인가?", ["모바일 앱 v3를 개발하는 프로젝트"],
         [("wikiB", "프로젝트 가람은 모바일 앱 v3를 개발하는 프로젝트이다")])
    # --- I2: message deleted, but a wiki still supports the same fact -----------------------
    I = w.instance("S06-I2", "deletion")
    I.rec("msgA", "messenger", "결제 장애 때는 임시로 우회 경로 B를 쓰고 있어요. 이번 주까지만 유지합니다.",
          "우회 경로", "minseo.go@example.test", "2026-11-10T14:00:00+09:00", scope=["channel:payments"])
    I.rec("msgA", "messenger", "", "우회 경로", "minseo.go@example.test", "2026-11-10T14:00:00+09:00",
          version=2, updated="2026-11-12T10:00:00+09:00", op="delete", scope=["channel:payments"])
    I.rec("wikiB", "wiki", "# 결제 장애 대응 런북\n\n장애 시 우회 경로 B로 전환한다. 전환 후 30분 안에 재시도 큐를 비운다.\n",
          "결제 장애 대응 런북", "yeonwoo.kang@example.test", "2026-10-18T10:00:00+09:00")
    I.rec("mailC", "mail", "우회 경로 B 전환 훈련 결과를 공유합니다. 전환에는 평균 4분이 걸렸습니다.\n",
          "전환 훈련 결과", "yeonwoo.kang@example.test", "2026-10-25T17:00:00+09:00")
    I.ent("route", "System", "우회 경로 B", [("wikiB", "우회 경로 B"), ("mailC", "우회 경로 B")])
    I.fact("route", "temporary_use_until_week_end", "true", "2026-11-10", None, "removed",
           [("msgA", "임시로 우회 경로 B를 쓰고 있어요. 이번 주까지만 유지합니다")], trigger=I.trig("msgA", 2))
    I.fact("route", "failover_target", "우회 경로 B", None, None, "verified",
           [("wikiB", "장애 시 우회 경로 B로 전환한다")])
    I.qa("결제 장애 시 어디로 전환하는가?", ["우회 경로 B"],
         [("wikiB", "장애 시 우회 경로 B로 전환한다")])
    I.qa("우회 경로 B를 이번 주까지만 유지한다는 말이 있었나?", [], [("msgA", "이번 주까지만 유지합니다")],
         answerable=False, trigger=I.trig("msgA", 2))
    # --- I3: wiki page deleted, the insight built on it must not survive --------------------
    I = w.instance("S06-I3", "deletion")
    I.rec("wikiA", "wiki", "# 임시 일정표\n\n마일스톤 M2 완료: 2026-12-09\n", "임시 일정표",
          "taei.oh@example.test", "2026-11-03T10:00:00+09:00")
    I.rec("wikiA", "wiki", "", "임시 일정표", "taei.oh@example.test", "2026-11-03T10:00:00+09:00",
          version=2, updated="2026-11-14T11:00:00+09:00", op="delete")
    I.rec("mailB", "mail", "마일스톤 M2 검수는 2026-12-08에 시작합니다. 검수 전에 완료 보고를 받아야 합니다.\n",
          "M2 검수 일정", "haram.moon@example.test", "2026-11-04T10:00:00+09:00")
    I.rec("msgC", "messenger", "일정표 문서가 없어졌네요. 어디서 다시 보나요?", "일정표",
          "gaeun.shin@example.test", "2026-11-15T09:30:00+09:00", scope=["channel:team"])
    I.ent("m2", "Event", "마일스톤 M2", [("wikiA", "마일스톤 M2"), ("mailB", "마일스톤 M2")])
    I.fact("m2", "completion_date", "2026-12-09", "2026-11-03", None, "removed",
           [("wikiA", "마일스톤 M2 완료: 2026-12-09")], trigger=I.trig("wikiA", 2))
    I.fact("m2", "review_start_date", "2026-12-08", "2026-11-04", None, "verified",
           [("mailB", "마일스톤 M2 검수는 2026-12-08에 시작합니다")])
    I.ins("schedule_conflict", "M2 완료(2026-12-09)가 검수 시작(2026-12-08)보다 늦음", True, ["m2"],
          [("wikiA", "마일스톤 M2 완료: 2026-12-09"), ("mailB", "마일스톤 M2 검수는 2026-12-08에 시작합니다")],
          expected=False, trigger=I.trig("wikiA", 2))
    I.qa("마일스톤 M2 완료 예정일은?", [], [("wikiA", "마일스톤 M2 완료: 2026-12-09")], answerable=False,
         trigger=I.trig("wikiA", 2))


def s07(w):
    # --- I1: mail scope narrowed (revoke) ---------------------------------------------------
    I = w.instance("S07-I1", "permission_revocation")
    I.rec("mailA", "mail", "협력사 가상물류와의 계약 단가는 건당 1,200원입니다. 재무팀 내부용입니다.\n",
          "계약 단가 안내", "seoa.lee@example.test", "2026-11-02T10:00:00+09:00",
          scope=["group:finance-team", "user:seoa.lee"])
    I.rec("mailA", "mail", "협력사 가상물류와의 계약 단가는 건당 1,200원입니다. 재무팀 내부용입니다.\n",
          "계약 단가 안내", "seoa.lee@example.test", "2026-11-02T10:00:00+09:00", version=2,
          updated="2026-11-16T09:00:00+09:00", op="revoke", scope=["user:seoa.lee"])
    I.rec("wikiB", "wiki", "# 계약 관리 절차\n\n계약 단가는 재무팀이 관리하고 담당자에게만 공유한다.\n",
          "계약 관리 절차", "seoa.lee@example.test", "2026-09-15T10:00:00+09:00")
    I.rec("msgC", "messenger", "계약 관련 문의는 재무팀 이서아 님께 부탁드려요.", "계약 문의",
          "gaeun.shin@example.test", "2026-11-17T10:00:00+09:00", scope=["channel:team"])
    I.ent("contract", "Document", "가상물류 계약 단가 안내", [("mailA", "협력사 가상물류와의 계약 단가", 1)])
    I.fact("contract", "unit_price_krw", "1200", "2026-11-02", None, "restricted",
           [("mailA", "계약 단가는 건당 1,200원입니다", 1), ("mailA", "계약 단가는 건당 1,200원입니다", 2)],
           trigger=I.trig("mailA", 2))
    I.qa("가상물류 계약 단가는?", [], [("mailA", "계약 단가는 건당 1,200원입니다", 1), ("mailA", "계약 단가는 건당 1,200원입니다", 2)],
         answerable=False, viewer="group:finance-team", trigger=I.trig("mailA", 2))
    I.qa("가상물류 계약 단가는?", ["건당 1,200원"], [("mailA", "계약 단가는 건당 1,200원입니다", 2)], viewer="user:seoa.lee")
    # --- I2: wiki page restricted to the security team --------------------------------------
    I = w.instance("S07-I2", "permission_revocation")
    I.rec("wikiA", "wiki", "# 보안 점검 결과 요약\n\n취약점 3건이 발견되어 조치 중이다. 상세 내역은 보안팀 티켓에 있다.\n",
          "보안 점검 결과 요약", "woojin.jung@example.test", "2026-11-04T10:00:00+09:00", scope=["org:all"])
    I.rec("wikiA", "wiki", "# 보안 점검 결과 요약\n\n취약점 3건이 발견되어 조치 중이다. 상세 내역은 보안팀 티켓에 있다.\n",
          "보안 점검 결과 요약", "woojin.jung@example.test", "2026-11-04T10:00:00+09:00", version=2,
          updated="2026-11-13T15:00:00+09:00", op="revoke", scope=["group:security-team"])
    I.rec("mailB", "mail", "보안 점검 결과는 보안팀 외에는 열람할 수 없게 조정했습니다. 필요하면 요청해 주세요.\n",
          "열람 범위 조정", "woojin.jung@example.test", "2026-11-13T15:10:00+09:00", participants=["woojin.jung@example.test", "all-dev@example.test"])
    I.rec("msgC", "messenger", "점검 결과 문서가 이제 안 열리네요. 권한 문제인가요?", "문서 권한",
          "jiho.ahn@example.test", "2026-11-14T09:00:00+09:00", scope=["channel:dev"])
    I.ent("doc", "Document", "보안 점검 결과 요약", [("wikiA", "보안 점검 결과 요약", 1)])
    I.fact("doc", "vulnerability_count", "3", "2026-11-04", None, "restricted",
           [("wikiA", "취약점 3건이 발견되어 조치 중이다", 1), ("wikiA", "취약점 3건이 발견되어 조치 중이다", 2)],
           trigger=I.trig("wikiA", 2))
    I.qa("점검에서 발견된 취약점은 몇 건인가?", [], [("wikiA", "취약점 3건이 발견되어 조치 중이다", 1), ("wikiA", "취약점 3건이 발견되어 조치 중이다", 2)],
         answerable=False, viewer="org:all", trigger=I.trig("wikiA", 2))
    I.qa("점검에서 발견된 취약점은 몇 건인가?", ["3건"], [("wikiA", "취약점 3건이 발견되어 조치 중이다", 2)],
         viewer="group:security-team")
    # --- I3: chat channel message moved to a smaller private channel --------------------------
    I = w.instance("S07-I3", "permission_revocation")
    I.rec("msgA", "messenger", "신규 요금제 출시일은 2027-01-11로 잠정 결정했습니다. 아직 공개 전입니다.",
          "요금제 출시", "yuna.cha@example.test", "2026-11-09T10:00:00+09:00", scope=["channel:proj-x"])
    I.rec("msgA", "messenger", "신규 요금제 출시일은 2027-01-11로 잠정 결정했습니다. 아직 공개 전입니다.",
          "요금제 출시", "yuna.cha@example.test", "2026-11-09T10:00:00+09:00", version=2,
          updated="2026-11-18T10:00:00+09:00", op="revoke", scope=["channel:proj-x-core"])
    I.rec("msgB", "messenger", "proj-x 채널은 정리를 위해 핵심 인원만 남기기로 했습니다.", "채널 정리",
          "yuna.cha@example.test", "2026-11-18T10:05:00+09:00", scope=["channel:proj-x"])
    I.rec("mailC", "mail", "공개 로드맵에는 신규 요금제를 2027년 1분기 출시로만 표기합니다.\n",
          "공개 로드맵 표기", "yuna.cha@example.test", "2026-11-19T09:00:00+09:00")
    I.ent("plan", "Event", "신규 요금제 출시", [("msgA", "신규 요금제 출시일", 1), ("mailC", "신규 요금제")])
    I.fact("plan", "launch_date", "2027-01-11", "2026-11-09", None, "restricted",
           [("msgA", "신규 요금제 출시일은 2027-01-11로 잠정 결정했습니다", 1), ("msgA", "신규 요금제 출시일은 2027-01-11로 잠정 결정했습니다", 2)],
           trigger=I.trig("msgA", 2))
    I.fact("plan", "public_launch_window", "2027년 1분기", None, None, "verified",
           [("mailC", "신규 요금제를 2027년 1분기 출시로만 표기합니다")])
    I.qa("신규 요금제 출시일은?", [], [("msgA", "신규 요금제 출시일은 2027-01-11로 잠정 결정했습니다", 1), ("msgA", "신규 요금제 출시일은 2027-01-11로 잠정 결정했습니다", 2)],
         answerable=False, viewer="channel:proj-x", trigger=I.trig("msgA", 2))
    I.qa("신규 요금제는 공개적으로 언제 출시된다고 안내하나?", ["2027년 1분기"],
         [("mailC", "신규 요금제를 2027년 1분기 출시로만 표기합니다")])
