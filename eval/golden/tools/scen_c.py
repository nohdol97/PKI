"""Scenarios 8-11: timezone_offsets, duplicate_threads, mixed_ko_en_same_concept, distractor_noise."""


def s08(w):
    # --- I1: one maintenance start expressed in three offsets, plus a different instant ----
    I = w.instance("S08-I1", "timezone_offsets")
    I.rec("mailA", "mail", "정기 점검은 2026-11-18T10:00:00+09:00에 시작합니다. 서울 사이트 기준입니다.\n",
          "정기 점검 공지(서울)", "sunwoo.baek@example.test", "2026-11-16T18:00:00+09:00")
    I.rec("msgB", "messenger", "Maintenance window starts 2026-11-18T02:00:00+01:00 for the Berlin site.",
          "Maintenance (Berlin)", "lena.fischer@example.test", "2026-11-16T10:30:00+01:00", scope=["channel:ops-eu"])
    I.rec("msgC", "messenger", "점검 시작은 2026-11-17T17:00:00-08:00 (현지 시각)입니다. 시애틀 사이트 공지예요.",
          "점검 시작(시애틀)", "ryan.cho@example.test", "2026-11-16T02:00:00-08:00", scope=["channel:ops-us"])
    I.rec("msgD", "messenger", "별도의 DB 점검은 2026-11-18T10:00:00-08:00에 시작합니다. 정기 점검과는 다른 작업이에요.",
          "DB 점검", "ryan.cho@example.test", "2026-11-16T02:10:00-08:00", scope=["channel:ops-us"])
    I.ent("e1", "Event", "정기 점검", [("mailA", "정기 점검"), ("msgB", "Maintenance window")], aliases=["Maintenance window"])
    I.ent("e2", "Event", "DB 점검", [("msgD", "DB 점검")])
    I.pair(("mailA", "2026-11-18T10:00:00+09:00"), ("msgB", "2026-11-18T02:00:00+01:00"), "e1", "e1")
    I.pair(("mailA", "2026-11-18T10:00:00+09:00"), ("msgC", "2026-11-17T17:00:00-08:00"), "e1", "e1")
    I.pair(("mailA", "2026-11-18T10:00:00+09:00"), ("msgD", "2026-11-18T10:00:00-08:00"), "e1", "e2")
    I.fact("e1", "start_instant", "2026-11-18T01:00:00Z", "2026-11-16", None, "verified",
           [("mailA", "2026-11-18T10:00:00+09:00"), ("msgB", "2026-11-18T02:00:00+01:00"), ("msgC", "2026-11-17T17:00:00-08:00")])
    I.fact("e2", "start_instant", "2026-11-18T18:00:00Z", "2026-11-16", None, "verified",
           [("msgD", "2026-11-18T10:00:00-08:00")])
    I.qa("정기 점검은 UTC로 언제 시작하는가?", ["2026-11-18T01:00:00Z", "서울·베를린·시애틀 공지가 같은 시각"],
         [("mailA", "2026-11-18T10:00:00+09:00"), ("msgB", "2026-11-18T02:00:00+01:00"), ("msgC", "2026-11-17T17:00:00-08:00")])
    # --- I2: deadline in US time, delivery plan in Korea time ---------------------------------
    I = w.instance("S08-I2", "timezone_offsets")
    I.rec("wikiA", "wiki", "# 감사 자료 제출 안내\n\n제출 마감: 2026-12-01T23:59:00-08:00\n제출처: 외부 감사 포털\n",
          "감사 자료 제출 안내", "ryan.cho@example.test", "2026-11-10T09:00:00-08:00")
    I.rec("mailB", "mail", "감사 자료는 2026-12-02T17:00:00+09:00에 제출하겠습니다. 서울 팀 검토 후 올립니다.\n",
          "감사 자료 제출 계획", "yuna.cha@example.test", "2026-11-18T10:00:00+09:00")
    I.rec("msgC", "messenger", "마감이 12월 1일이라 서둘러야 하나요? 우리는 12월 2일 오후에 올릴 계획인데요.",
          "마감 질문", "gaeun.shin@example.test", "2026-11-18T10:30:00+09:00", scope=["channel:audit"])
    I.rec("mailD", "mail", "Deadline is 23:59 Pacific time on December 1. Please convert before planning.\n",
          "Re: audit deadline", "ryan.cho@example.test", "2026-11-18T09:00:00-08:00", participants=["ryan.cho@example.test", "yuna.cha@example.test"])
    I.ent("deadline", "Event", "감사 자료 제출 마감", [("wikiA", "제출 마감")])
    I.ent("plan", "Commitment", "감사 자료 제출 계획", [("mailB", "감사 자료는 2026-12-02T17:00:00+09:00에 제출하겠습니다")])
    I.fact("deadline", "due_instant", "2026-12-02T07:59:00Z", "2026-11-10", None, "verified",
           [("wikiA", "제출 마감: 2026-12-01T23:59:00-08:00")])
    I.fact("plan", "submit_instant", "2026-12-02T08:00:00Z", "2026-11-18", None, "verified",
           [("mailB", "2026-12-02T17:00:00+09:00에 제출하겠습니다")])
    I.ins("schedule_conflict", "제출 계획(2026-12-02T08:00:00Z)이 마감(2026-12-02T07:59:00Z)보다 1분 늦음", True, ["deadline", "plan"],
          [("wikiA", "제출 마감: 2026-12-01T23:59:00-08:00"), ("mailB", "2026-12-02T17:00:00+09:00에 제출하겠습니다")])
    I.qa("감사 자료 제출 계획은 마감을 지키는가?", ["마감은 UTC 2026-12-02T07:59:00Z", "계획은 UTC 2026-12-02T08:00:00Z", "1분 늦음(추론)"],
         [("wikiA", "제출 마감: 2026-12-01T23:59:00-08:00"), ("mailB", "2026-12-02T17:00:00+09:00에 제출하겠습니다")])
    # --- I3: same words ("tomorrow 9am") resolved with different local offsets -------------
    I = w.instance("S08-I3", "timezone_offsets")
    I.rec("msgA", "messenger", "내일 오전 9시에 주간 동기화 회의를 시작합니다. (서울 기준)",
          "주간 동기화(서울)", "taei.oh@example.test", "2026-11-23T20:00:00+09:00", scope=["channel:sync-kr"])
    I.rec("msgB", "messenger", "내일 오전 9시에 주간 동기화 회의를 시작합니다. (시애틀 기준)",
          "주간 동기화(시애틀)", "ryan.cho@example.test", "2026-11-23T20:00:00-08:00", scope=["channel:sync-us"])
    I.rec("mailC", "mail", "서울과 시애틀 주간 동기화는 서로 별개의 회의입니다. 시차 때문에 시간이 겹치지 않습니다.\n",
          "주간 동기화 안내", "taei.oh@example.test", "2026-11-23T09:00:00Z")
    I.ent("e1", "Event", "주간 동기화(서울)", [("msgA", "주간 동기화 회의")])
    I.ent("e2", "Event", "주간 동기화(시애틀)", [("msgB", "주간 동기화 회의")])
    I.pair(("msgA", "내일 오전 9시"), ("msgB", "내일 오전 9시"), "e1", "e2")
    I.pair(("msgA", "주간 동기화 회의"), ("mailC", "서울"), "e1", "e1")
    I.fact("e1", "start_instant", "2026-11-24T00:00:00Z", "2026-11-23", None, "verified", [("msgA", "내일 오전 9시에 주간 동기화 회의를 시작합니다. (서울 기준)")])
    I.fact("e2", "start_instant", "2026-11-24T17:00:00Z", "2026-11-24", None, "verified", [("msgB", "내일 오전 9시에 주간 동기화 회의를 시작합니다. (시애틀 기준)")])
    I.qa("시애틀 주간 동기화는 언제 시작하나?", ["2026-11-24T09:00:00-08:00(UTC 17:00)"],
         [("msgB", "내일 오전 9시에 주간 동기화 회의를 시작합니다. (시애틀 기준)")])


def s09(w):
    # --- I1: original mail, a forward, and the same mail re-ingested by another connector ----
    I = w.instance("S09-I1", "duplicate_threads")
    I.rec("mailA", "mail", "웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다. 2026-11-09부터 적용됩니다.\n",
          "점검창 변경 안내", "sunwoo.baek@example.test", "2026-11-05T10:00:00+09:00", thread="thr-s09-i1-window")
    I.rec("mailB", "mail", "참고하세요.\n\n---------- 전달된 메시지 ----------\n웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다. 2026-11-09부터 적용됩니다.\n",
          "Fwd: 점검창 변경 안내", "gaeun.shin@example.test", "2026-11-05T11:00:00+09:00", thread="thr-s09-i1-window")
    I.rec("mailC", "mail", "웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다. 2026-11-09부터 적용됩니다.\n",
          "점검창 변경 안내", "sunwoo.baek@example.test", "2026-11-05T10:00:00+09:00", thread="thr-s09-i1-window",
          connector="conn-mail-02", ext="<s09-i1-mailC-resync@mail.example.test>")
    I.rec("msgD", "messenger", "DB 점검창은 매주 목요일 02:00입니다. 웹 서비스와 별도 일정이에요.",
          "DB 점검창", "sunwoo.baek@example.test", "2026-11-05T12:00:00+09:00", scope=["channel:infra"])
    I.ent("d1", "Decision", "웹 서비스 점검창 변경", [("mailA", "웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다"),
                                                  ("mailB", "웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다"),
                                                  ("mailC", "웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다")])
    I.ent("d2", "Fact", "DB 점검창 목요일 02:00", [("msgD", "DB 점검창은 매주 목요일 02:00입니다")])
    I.pair(("mailA", "웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다"), ("mailB", "웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다"), "d1", "d1")
    I.pair(("mailA", "웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다"), ("mailC", "웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다"), "d1", "d1")
    I.pair(("mailA", "점검창이 매주 화요일 22:00"), ("msgD", "DB 점검창은 매주 목요일 02:00"), "d1", "d2")
    I.fact("d1", "maintenance_window", "매주 화요일 22:00", "2026-11-09", None, "verified",
           [("mailA", "웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다")])
    I.qa("웹 서비스 점검창은 언제인가?", ["매주 화요일 22:00(2026-11-09부터)"],
         [("mailA", "웹 서비스 점검창이 매주 화요일 22:00으로 변경되었습니다")])
    # --- I2: the same announcement cross-posted to two channels and quoted in a digest ----
    I = w.instance("S09-I2", "duplicate_threads")
    I.rec("msgA", "messenger", "배포 동결 기간은 2026-12-24부터 2027-01-03까지입니다. 긴급 수정만 허용됩니다.",
          "배포 동결 공지", "taeyang.min@example.test", "2026-11-12T10:00:00+09:00", thread="thr-s09-i2-dev", scope=["channel:dev"])
    I.rec("msgB", "messenger", "배포 동결 기간은 2026-12-24부터 2027-01-03까지입니다. 긴급 수정만 허용됩니다.",
          "배포 동결 공지", "taeyang.min@example.test", "2026-11-12T10:01:00+09:00", thread="thr-s09-i2-ops", scope=["channel:ops"])
    I.rec("msgC", "messenger", "동결 공지 확인했습니다.", "배포 동결 공지", "jiho.ahn@example.test",
          "2026-11-12T10:10:00+09:00", thread="thr-s09-i2-dev", scope=["channel:dev"])
    I.rec("mailD", "mail", "이번 주 소식\n\n- 배포 동결 기간은 2026-12-24부터 2027-01-03까지입니다. 긴급 수정만 허용됩니다.\n- 사내 도서 반납 안내\n",
          "주간 소식", "newsletter@example.test", "2026-11-13T09:00:00+09:00", participants=["all-staff@example.test"])
    I.ent("freeze", "Event", "배포 동결", [("msgA", "배포 동결"), ("msgB", "배포 동결"), ("mailD", "배포 동결")])
    I.pair(("msgA", "배포 동결 기간은 2026-12-24부터 2027-01-03까지입니다"), ("msgB", "배포 동결 기간은 2026-12-24부터 2027-01-03까지입니다"), "freeze", "freeze")
    I.pair(("msgA", "배포 동결 기간은 2026-12-24부터 2027-01-03까지입니다"), ("mailD", "배포 동결 기간은 2026-12-24부터 2027-01-03까지입니다"), "freeze", "freeze")
    I.fact("freeze", "freeze_period", "2026-12-24/2027-01-03", "2026-12-24", "2027-01-03", "verified",
           [("msgA", "배포 동결 기간은 2026-12-24부터 2027-01-03까지입니다")])
    I.qa("배포 동결 기간은?", ["2026-12-24부터 2027-01-03까지"], [("msgA", "배포 동결 기간은 2026-12-24부터 2027-01-03까지입니다")])
    # --- I3: wiki copy, plus a near-duplicate with a changed number (must not be merged) -------
    I = w.instance("S09-I3", "duplicate_threads")
    I.rec("wikiA", "wiki", "# 서비스 등급 정책\n\nP1 장애는 15분 안에 응답한다.\nP2 장애는 2시간 안에 응답한다.\n",
          "서비스 등급 정책", "woojin.jung@example.test", "2026-10-10T10:00:00+09:00")
    I.rec("wikiB", "wiki", "# 서비스 등급 정책\n\nP1 장애는 15분 안에 응답한다.\nP2 장애는 2시간 안에 응답한다.\n",
          "서비스 등급 정책 (복사본)", "gaeun.shin@example.test", "2026-10-12T10:00:00+09:00")
    I.rec("wikiC", "wiki", "# 서비스 등급 정책 초안\n\nP1 장애는 30분 안에 응답한다.\nP2 장애는 4시간 안에 응답한다.\n",
          "서비스 등급 정책 초안", "woojin.jung@example.test", "2026-09-20T10:00:00+09:00")
    I.rec("msgD", "messenger", "서비스 등급 정책 문서가 두 개 보이는데 어느 게 최신인가요?", "정책 문서",
          "jiho.ahn@example.test", "2026-10-13T09:00:00+09:00", scope=["channel:ops"])
    I.ent("pol", "BusinessRule", "P1 장애 응답 기준", [("wikiA", "P1 장애는 15분 안에 응답한다"), ("wikiB", "P1 장애는 15분 안에 응답한다"),
                                                  ("wikiC", "P1 장애는 30분 안에 응답한다")])
    I.pair(("wikiA", "P1 장애는 15분 안에 응답한다"), ("wikiB", "P1 장애는 15분 안에 응답한다"), "pol", "pol")
    I.pair(("wikiA", "P1 장애는 15분 안에 응답한다"), ("wikiC", "P1 장애는 30분 안에 응답한다"), "pol", "pol")
    o = I.fact("pol", "p1_response_minutes", "30", "2026-09-20", "2026-10-10", "superseded", [("wikiC", "P1 장애는 30분 안에 응답한다")])
    I.fact("pol", "p1_response_minutes", "15", "2026-10-10", None, "verified", [("wikiA", "P1 장애는 15분 안에 응답한다")], supersedes=o)
    I.qa("P1 장애는 몇 분 안에 응답해야 하나?", ["15분"], [("wikiA", "P1 장애는 15분 안에 응답한다")])


def s10(w):
    # --- I1: 롤백 / rollback / revert ---------------------------------------------------------
    I = w.instance("S10-I1", "mixed_ko_en_same_concept")
    I.rec("mailA", "mail", "어제 릴리스 4.2를 롤백했습니다. 원인은 결제 승인 오류입니다.\n",
          "릴리스 4.2 롤백", "taeyang.min@example.test", "2026-11-13T09:00:00+09:00")
    I.rec("msgB", "messenger", "We rolled back release 4.2 because of payment approval errors.",
          "release 4.2", "lena.fischer@example.test", "2026-11-13T09:30:00+09:00", scope=["channel:release"])
    I.rec("msgC", "messenger", "릴리즈 4.2 revert 완료. root cause는 payment 승인 오류예요.",
          "릴리즈 4.2", "jiho.ahn@example.test", "2026-11-13T09:40:00+09:00", scope=["channel:release"])
    I.rec("wikiD", "wiki", "# 릴리스 4.2 회고\n\n릴리스 4.2는 결제 승인 오류로 되돌림(rollback)되었다. 재배포는 4.2.1로 진행한다.\n",
          "릴리스 4.2 회고", "taeyang.min@example.test", "2026-11-14T10:00:00+09:00")
    I.rec("msgE", "messenger", "릴리스 4.3은 다음 주에 배포합니다. 4.2와는 별개 일정이에요.", "릴리스 4.3",
          "taeyang.min@example.test", "2026-11-14T11:00:00+09:00", scope=["channel:release"])
    I.ent("rb", "Event", "릴리스 4.2 롤백", [("mailA", "릴리스 4.2를 롤백했습니다"), ("msgB", "rolled back release 4.2"),
                                           ("msgC", "릴리즈 4.2 revert 완료")], aliases=["rollback", "revert", "되돌림"])
    I.ent("err", "Issue", "결제 승인 오류", [("mailA", "결제 승인 오류"), ("msgB", "payment approval errors"), ("msgC", "payment 승인 오류")],
          aliases=["payment approval errors"])
    I.ent("r43", "Event", "릴리스 4.3 배포", [("msgE", "릴리스 4.3은 다음 주에 배포합니다")])
    I.pair(("mailA", "롤백했습니다"), ("msgB", "rolled back"), "rb", "rb")
    I.pair(("msgC", "revert 완료"), ("msgB", "rolled back"), "rb", "rb")
    I.pair(("wikiD", "되돌림(rollback)"), ("mailA", "롤백했습니다"), "rb", "rb")
    I.pair(("msgE", "릴리스 4.3은 다음 주에 배포합니다"), ("mailA", "릴리스 4.2를 롤백했습니다"), "r43", "rb")
    I.rel("rb", "CAUSED_BY", "err", [("mailA", "원인은 결제 승인 오류입니다"), ("msgB", "because of payment approval errors")])
    I.rel("rb", "RELATED_TO", "r43", [("msgE", "4.2와는 별개 일정이에요")], expected=False)
    I.fact("rb", "status", "rolled_back", "2026-11-12", None, "verified", [("wikiD", "릴리스 4.2는 결제 승인 오류로 되돌림(rollback)되었다")])
    I.qa("Why was release 4.2 rolled back?", ["payment approval errors(결제 승인 오류)"],
         [("msgB", "We rolled back release 4.2 because of payment approval errors"), ("mailA", "원인은 결제 승인 오류입니다")])
    # --- I2: 승인율 / approval rate / auth rate -----------------------------------------------
    I = w.instance("S10-I2", "mixed_ko_en_same_concept")
    I.rec("mailA", "mail", "카드 승인율이 지난주 98.2%에서 96.5%로 떨어졌습니다. 원인 분석 중입니다.\n",
          "승인율 하락", "minseo.go@example.test", "2026-11-17T10:00:00+09:00")
    I.rec("msgB", "messenger", "approval rate drop은 게이트웨이 timeout 때문인 것 같아요.", "approval rate",
          "yeonwoo.kang@example.test", "2026-11-17T10:30:00+09:00", scope=["channel:payments"])
    I.rec("msgC", "messenger", "auth rate 지표 알림이 두 번 울렸습니다. threshold는 97%예요.", "auth rate 알림",
          "jiho.ahn@example.test", "2026-11-17T11:00:00+09:00", scope=["channel:payments"])
    I.rec("wikiD", "wiki", "# 지표 정의\n\n승인율(approval rate, auth rate)은 전체 결제 시도 중 승인된 건의 비율이다.\n",
          "지표 정의", "ops-bot@example.test", "2026-08-01T10:00:00+09:00")
    I.ent("m", "Concept", "승인율", [("wikiD", "승인율(approval rate, auth rate)"), ("mailA", "승인율"), ("msgB", "approval rate"), ("msgC", "auth rate")],
          aliases=["approval rate", "auth rate"])
    I.pair(("mailA", "승인율"), ("msgB", "approval rate"), "m", "m")
    I.pair(("msgC", "auth rate"), ("wikiD", "approval rate, auth rate"), "m", "m")
    o = I.fact("m", "card_approval_rate", "98.2%", "2026-11-10", "2026-11-17", "superseded", [("mailA", "지난주 98.2%")])
    I.fact("m", "card_approval_rate", "96.5%", "2026-11-17", None, "verified", [("mailA", "96.5%로 떨어졌습니다")], supersedes=o)
    I.ins("important_work_change", "카드 승인율이 98.2%에서 96.5%로 하락(알림 threshold 97% 아래)", True, ["m"],
          [("mailA", "98.2%에서 96.5%로 떨어졌습니다"), ("msgC", "threshold는 97%예요")])
    I.qa("What is the current card approval rate?", ["96.5%", "지난주 98.2%에서 하락"],
         [("mailA", "98.2%에서 96.5%로 떨어졌습니다")])
    # --- I3: 장애 / incident / outage ---------------------------------------------------------
    I = w.instance("S10-I3", "mixed_ko_en_same_concept")
    I.rec("msgA", "messenger", "오전 장애로 로그인이 40분간 안 됐습니다.", "로그인 장애", "gaeun.shin@example.test",
          "2026-11-17T11:30:00+09:00", scope=["channel:ops"])
    I.rec("mailB", "mail", "Incident report: login outage lasted 40 minutes on 2026-11-17. Root cause was an expired certificate.\n",
          "Incident report 2026-11-17", "sunwoo.baek@example.test", "2026-11-17T18:00:00+09:00")
    I.rec("wikiC", "wiki", "# 장애 보고서 2026-11-17\n\n로그인 서비스 outage(장애) 40분. 원인: 인증서 만료.\n",
          "장애 보고서 2026-11-17", "sunwoo.baek@example.test", "2026-11-18T10:00:00+09:00")
    I.rec("msgD", "messenger", "incident 후속으로 인증서 만료 알림을 추가했어요.", "후속 조치",
          "haram.moon@example.test", "2026-11-18T14:00:00+09:00", scope=["channel:ops"])
    I.ent("inc", "Event", "로그인 장애 2026-11-17", [("msgA", "장애로 로그인이 40분간 안 됐습니다"), ("mailB", "login outage"),
                                                  ("wikiC", "outage(장애) 40분")], aliases=["login outage", "incident"])
    I.ent("cert", "Issue", "인증서 만료", [("mailB", "expired certificate"), ("wikiC", "인증서 만료")], aliases=["expired certificate"])
    I.pair(("msgA", "장애"), ("mailB", "outage"), "inc", "inc")
    I.pair(("msgD", "incident"), ("wikiC", "outage(장애)"), "inc", "inc")
    I.rel("inc", "CAUSED_BY", "cert", [("mailB", "Root cause was an expired certificate"), ("wikiC", "원인: 인증서 만료")])
    I.fact("inc", "duration_minutes", "40", "2026-11-17", "2026-11-17", "verified",
           [("msgA", "로그인이 40분간 안 됐습니다"), ("mailB", "lasted 40 minutes"), ("wikiC", "outage(장애) 40분")])
    I.qa("로그인 outage의 원인은?", ["인증서 만료(expired certificate)"],
         [("mailB", "Root cause was an expired certificate"), ("wikiC", "원인: 인증서 만료")])


def s11(w):
    # --- I1: a project and a restaurant both called 가람; dates that coincide by chance -------
    I = w.instance("S11-I1", "distractor_noise")
    I.rec("mailA", "mail", "프로젝트 가람 마일스톤 점검은 2026-11-27 오전 10시입니다. 자료는 전날까지 올려 주세요.\n",
          "가람 마일스톤 점검", "chaewon.yoon@example.test", "2026-11-18T09:00:00+09:00")
    I.rec("msgB", "messenger", "연말 회식은 가람 식당에서 하려고요. 예약은 2026-11-27 저녁 7시입니다.", "회식 장소",
          "yuna.cha@example.test", "2026-11-18T12:00:00+09:00", scope=["channel:random"])
    I.rec("wikiC", "wiki", "# 프로젝트 가람 개요\n\n프로젝트 가람은 모바일 앱 v3 개발을 맡은 프로젝트로, 마일스톤 점검을 정기적으로 진행한다.\n",
          "프로젝트 가람 개요", "chaewon.yoon@example.test", "2026-10-01T10:00:00+09:00")
    I.rec("msgD", "messenger", "가람 식당 예약 확인했습니다. 12명으로 잡았어요.", "회식 예약",
          "yuna.cha@example.test", "2026-11-18T12:30:00+09:00", scope=["channel:random"])
    I.rec("mailE", "mail", "11월 회식 비용 정산은 영수증을 첨부해 영업지원팀으로 보내 주세요.\n",
          "회식 비용 정산", "hayoon.seo2@example.test", "2026-11-19T09:00:00+09:00")
    I.ent("proj", "Project", "프로젝트 가람", [("mailA", "프로젝트 가람"), ("wikiC", "프로젝트 가람")])
    I.ent("rest", "Organization", "가람 식당", [("msgB", "가람 식당"), ("msgD", "가람 식당")])
    I.pair(("mailA", "프로젝트 가람"), ("msgB", "가람 식당"), "proj", "rest")
    I.pair(("wikiC", "프로젝트 가람"), ("mailA", "프로젝트 가람"), "proj", "proj")
    I.rel("proj", "RELATED_TO", "rest", [("mailA", "프로젝트 가람 마일스톤 점검은 2026-11-27 오전 10시입니다"),
                                         ("msgB", "가람 식당에서 하려고요")], expected=False)
    I.ins("schedule_conflict", "마일스톤 점검과 회식 예약이 같은 날(2026-11-27)이라 충돌", True, ["proj", "rest"],
          [("mailA", "2026-11-27 오전 10시"), ("msgB", "2026-11-27 저녁 7시")], expected=False)
    I.qa("프로젝트 가람의 마일스톤 점검은 언제인가?", ["2026-11-27 오전 10시"],
         [("mailA", "프로젝트 가람 마일스톤 점검은 2026-11-27 오전 10시입니다")])
    # --- I2: two similarly named systems that do not depend on each other --------------------
    I = w.instance("S11-I2", "distractor_noise")
    I.rec("wikiA", "wiki", "# 알림 서비스\n\n알림 서비스는 푸시 알림을 발송하는 시스템이다.\n", "알림 서비스",
          "dohoon.jang@example.test", "2026-09-05T10:00:00+09:00")
    I.rec("wikiB", "wiki", "# 알림판\n\n알림판은 사내 공지를 보여 주는 게시판 화면이다.\n", "알림판",
          "gaeun.shin@example.test", "2026-09-06T10:00:00+09:00")
    I.rec("mailC", "mail", "알림판 공지 영역 개편은 2026-12-02에 배포합니다.\n", "알림판 개편 배포",
          "gaeun.shin@example.test", "2026-11-17T10:00:00+09:00")
    I.rec("msgD", "messenger", "알림 서비스 큐 지연이 있었지만 복구됐습니다. 2026-11-17 오전 이야기예요.", "큐 지연",
          "dohoon.jang@example.test", "2026-11-17T13:00:00+09:00", scope=["channel:infra"])
    I.rec("msgE", "messenger", "알림판 개편 일정과 알림 서비스는 무관합니다. 서로 의존하지 않아요.", "무관 확인",
          "gaeun.shin@example.test", "2026-11-17T13:20:00+09:00", scope=["channel:infra"])
    I.ent("svc", "System", "알림 서비스", [("wikiA", "알림 서비스"), ("msgD", "알림 서비스")])
    I.ent("board", "System", "알림판", [("wikiB", "알림판"), ("mailC", "알림판")])
    I.pair(("wikiA", "알림 서비스"), ("wikiB", "알림판"), "svc", "board")
    I.pair(("msgD", "알림 서비스"), ("wikiA", "알림 서비스"), "svc", "svc")
    I.rel("board", "DEPENDS_ON", "svc", [("msgE", "알림판 개편 일정과 알림 서비스는 무관합니다. 서로 의존하지 않아요")], expected=False)
    I.fact("board", "deploy_date", "2026-12-02", "2026-11-17", None, "verified", [("mailC", "알림판 공지 영역 개편은 2026-12-02에 배포합니다")])
    I.ins("dependency_delay", "알림 서비스 큐 지연이 알림판 개편 일정에 영향", True, ["svc", "board"],
          [("msgD", "알림 서비스 큐 지연이 있었지만 복구됐습니다"), ("mailC", "알림판 공지 영역 개편은 2026-12-02에 배포합니다")], expected=False)
    I.qa("알림판 개편은 언제 배포되나?", ["2026-12-02"], [("mailC", "알림판 공지 영역 개편은 2026-12-02에 배포합니다")])
    # --- I3: unrelated delay in a different system ---------------------------------------------
    I = w.instance("S11-I3", "distractor_noise")
    I.rec("mailA", "mail", "물류 시스템 연동이 2026-12-10까지 지연됩니다. 창고 앱 배포도 함께 밀립니다.\n",
          "물류 연동 지연", "seoa.lee@example.test", "2026-11-16T10:00:00+09:00")
    I.rec("wikiB", "wiki", "# 나루 프로젝트\n\n나루 프로젝트는 회계 시스템 개편 프로젝트이다. 물류 시스템과는 연동하지 않는다.\n",
          "나루 프로젝트", "jian.noh@example.test", "2026-10-08T10:00:00+09:00")
    I.rec("msgC", "messenger", "나루 프로젝트 목표일은 2026-12-30입니다.", "나루 목표일",
          "jian.noh@example.test", "2026-11-02T10:00:00+09:00", scope=["channel:naru"])
    I.rec("msgD", "messenger", "물류 시스템 지연 때문에 창고 앱 배포가 일주일 밀립니다.", "창고 앱",
          "seoa.lee@example.test", "2026-11-16T10:30:00+09:00", scope=["channel:logistics"])
    I.rec("mailE", "mail", "연말 휴무는 2026-12-31부터 2027-01-01까지입니다.\n", "연말 휴무 안내",
          "hr-bot@example.test", "2026-11-10T09:00:00+09:00", participants=["all-staff@example.test"])
    I.ent("naru", "Project", "나루 프로젝트", [("wikiB", "나루 프로젝트"), ("msgC", "나루 프로젝트")])
    I.ent("logi", "System", "물류 시스템", [("mailA", "물류 시스템"), ("wikiB", "물류 시스템")])
    I.rel("naru", "DEPENDS_ON", "logi", [("wikiB", "물류 시스템과는 연동하지 않는다")], expected=False)
    I.fact("naru", "target_date", "2026-12-30", "2026-11-02", None, "verified", [("msgC", "나루 프로젝트 목표일은 2026-12-30입니다")])
    I.fact("logi", "completion_date", "2026-12-10", "2026-11-16", None, "verified", [("mailA", "물류 시스템 연동이 2026-12-10까지 지연됩니다")])
    I.ins("dependency_delay", "물류 시스템 지연(2026-12-10)이 나루 프로젝트(2026-12-30) 일정에 영향", True, ["naru", "logi"],
          [("mailA", "물류 시스템 연동이 2026-12-10까지 지연됩니다"), ("msgC", "나루 프로젝트 목표일은 2026-12-30입니다")], expected=False)
    I.qa("나루 프로젝트 목표일은?", ["2026-12-30"], [("msgC", "나루 프로젝트 목표일은 2026-12-30입니다")])
