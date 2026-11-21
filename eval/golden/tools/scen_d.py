"""Extra eval-split instances (appended last so earlier record ids stay stable):
S02-I4, S04-I4, S05-I4, S06-I4, S09-I4, S11-I4. They add eval items for the rate gates in docs/EVALUATION.md."""


def s12(w):
    # --- S02-I4: two people named 정하린, told apart by chat channel, minutes and a cover mail ---
    I = w.instance("S02-I4", "same_name_different_people")
    I.rec("msgA", "messenger", "정하린입니다. 월말 마감 점검표를 갱신했어요. 정산 채널 분들은 새 표로 바꿔 주세요.",
          "점검표 갱신", "harin.jung1@example.test", "2026-11-18T09:00:00+09:00", scope=["channel:settlement"])
    I.rec("msgB", "messenger", "정하린입니다. 발주서 양식이 바뀌었으니 새 양식으로 요청해 주세요.",
          "발주서 양식", "harin.jung2@example.test", "2026-11-18T09:40:00+09:00", scope=["channel:procurement"])
    I.rec("wikiC", "wiki", "# 11월 정례 회의록\n\n참석: 정하린(구매팀 대리), 오세훈, 조민아\n결정: 발주서 양식은 12월부터 새 양식을 쓴다.\n",
          "11월 정례 회의록", "minah.jo@example.test", "2026-11-19T17:00:00+09:00")
    I.rec("mailD", "mail", "정하린 님께,\n\n정산팀 점검표 반영본을 첨부합니다. 같은 정산팀 소속이라 바로 공유드립니다.\n\n오세훈 드림\n",
          "점검표 반영본", "sehun.oh@example.test", "2026-11-19T10:00:00+09:00", participants=["sehun.oh@example.test", "harin.jung1@example.test"])
    I.ent("p1", "Person", "정하린(정산팀)", [("msgA", "정하린"), ("mailD", "정하린")])
    I.ent("p2", "Person", "정하린(구매팀)", [("msgB", "정하린"), ("wikiC", "정하린(구매팀 대리)")])
    I.ent("t1", "Organization", "정산팀", [("mailD", "정산팀")])
    I.ent("t2", "Organization", "구매팀", [("wikiC", "구매팀")])
    I.pair(("msgA", "정하린"), ("mailD", "정하린"), "p1", "p1")
    I.pair(("msgA", "정하린"), ("msgB", "정하린"), "p1", "p2")
    I.pair(("msgB", "정하린"), ("wikiC", "정하린(구매팀 대리)"), "p2", "p2")
    I.pair(("mailD", "정하린"), ("wikiC", "정하린(구매팀 대리)"), "p1", "p2")
    I.rel("p1", "BELONGS_TO", "t1", [("mailD", "같은 정산팀 소속이라")])
    I.rel("p2", "BELONGS_TO", "t2", [("wikiC", "정하린(구매팀 대리)")])
    I.rel("p2", "BELONGS_TO", "t1", [("msgB", "정하린입니다. 발주서 양식이 바뀌었으니"), ("wikiC", "정하린(구매팀 대리)")], expected=False)
    I.qa("발주서 양식 변경을 안내한 정하린은 어느 팀인가?", ["구매팀(대리)"],
         [("msgB", "발주서 양식이 바뀌었으니 새 양식으로 요청해 주세요"), ("wikiC", "정하린(구매팀 대리)")])

    # --- S04-I4: owner and open date differ, no one notices -----------------------------
    I = w.instance("S04-I4", "contradicting_statements")
    I.rec("wikiA", "wiki", "# 고객 포털 개편\n\n오픈 예정일: 2026-12-14\n담당: 최서진\n", "고객 포털 개편",
          "seojin.choi@example.test", "2026-11-10T10:00:00+09:00")
    I.rec("mailB", "mail", "고객 포털 개편은 2026-12-21에 오픈합니다. 담당은 한유진입니다.\n", "고객 포털 오픈 안내",
          "yujin.han@example.test", "2026-11-12T10:00:00+09:00", participants=["yujin.han@example.test", "all-dev@example.test"])
    I.rec("msgC", "messenger", "포털 개편 회의록은 공유 폴더에 올렸습니다.", "회의록", "yujin.han@example.test",
          "2026-11-13T09:00:00+09:00", scope=["channel:portal"])
    I.ent("portal", "Project", "고객 포털 개편", [("wikiA", "고객 포털 개편"), ("mailB", "고객 포털 개편")])
    I.ent("f1", "Fact", "오픈 2026-12-14", [("wikiA", "오픈 예정일: 2026-12-14")])
    I.ent("f2", "Fact", "오픈 2026-12-21", [("mailB", "2026-12-21에 오픈합니다")])
    I.ent("g1", "Fact", "담당 최서진", [("wikiA", "담당: 최서진")])
    I.ent("g2", "Fact", "담당 한유진", [("mailB", "담당은 한유진입니다")])
    I.rel("f2", "CONTRADICTS", "f1", [("wikiA", "오픈 예정일: 2026-12-14"), ("mailB", "2026-12-21에 오픈합니다")])
    I.rel("g2", "CONTRADICTS", "g1", [("wikiA", "담당: 최서진"), ("mailB", "담당은 한유진입니다")])
    I.fact("portal", "launch_date", "2026-12-14", "2026-11-10", None, "disputed", [("wikiA", "오픈 예정일: 2026-12-14")])
    I.fact("portal", "launch_date", "2026-12-21", "2026-11-12", None, "disputed", [("mailB", "2026-12-21에 오픈합니다")])
    I.fact("portal", "owner", "최서진", None, None, "disputed", [("wikiA", "담당: 최서진")])
    I.fact("portal", "owner", "한유진", None, None, "disputed", [("mailB", "담당은 한유진입니다")])
    I.ins("conflicting_information", "고객 포털 개편의 오픈일과 담당자가 위키와 메일에서 다름", True, ["portal", "f1", "f2", "g1", "g2"],
          [("wikiA", "오픈 예정일: 2026-12-14"), ("mailB", "2026-12-21에 오픈합니다"),
           ("wikiA", "담당: 최서진"), ("mailB", "담당은 한유진입니다")])
    I.qa("고객 포털 개편 오픈일은 언제인가?", ["위키는 2026-12-14", "메일은 2026-12-21", "상충함"],
         [("wikiA", "오픈 예정일: 2026-12-14"), ("mailB", "2026-12-21에 오픈합니다")])

    # --- S05-I4: an explicit correction mail ----------------------------------------------
    I = w.instance("S05-I4", "correction_supersedes")
    I.rec("mailA", "mail", "신규 요금 안내는 2026-12-01부터 적용됩니다.\n", "신규 요금 안내", "yuna.cha@example.test",
          "2026-11-17T10:00:00+09:00", thread="thr-s05-i4-price")
    I.rec("mailB", "mail", "정정 안내: 신규 요금 적용일은 2026-12-08입니다. 이전 메일의 2026-12-01은 잘못된 날짜였습니다.\n",
          "Re: 신규 요금 안내", "yuna.cha@example.test", "2026-11-17T15:00:00+09:00", thread="thr-s05-i4-price")
    I.rec("msgC", "messenger", "요금 적용일 바뀐 거 고객 안내문에 반영했어요.", "안내문", "gaeun.shin@example.test",
          "2026-11-17T16:00:00+09:00", scope=["channel:support"])
    I.ent("old", "Fact", "신규 요금 적용일 2026-12-01", [("mailA", "2026-12-01부터 적용됩니다")])
    I.ent("new", "Fact", "신규 요금 적용일 2026-12-08", [("mailB", "신규 요금 적용일은 2026-12-08입니다")])
    I.ent("price", "Event", "신규 요금 적용", [("mailA", "신규 요금"), ("mailB", "신규 요금 적용일")])
    I.rel("new", "SUPERSEDES", "old", [("mailB", "정정 안내: 신규 요금 적용일은 2026-12-08입니다")])
    o = I.fact("price", "start_date", "2026-12-01", "2026-11-17", "2026-11-17", "superseded", [("mailA", "신규 요금 안내는 2026-12-01부터 적용됩니다")])
    I.fact("price", "start_date", "2026-12-08", "2026-11-17", None, "verified",
           [("mailB", "신규 요금 적용일은 2026-12-08입니다")], supersedes=o)
    I.ins("important_work_change", "신규 요금 적용일이 2026-12-01에서 2026-12-08로 정정됨", False, ["price", "old", "new"],
          [("mailA", "신규 요금 안내는 2026-12-01부터 적용됩니다"), ("mailB", "신규 요금 적용일은 2026-12-08입니다")])
    I.qa("신규 요금은 언제부터 적용되나?", ["2026-12-08", "2026-12-01은 정정으로 대체됨"],
         [("mailB", "신규 요금 적용일은 2026-12-08입니다")])

    # --- S06-I4: message deleted, date still supported by two other sources ---------------
    I = w.instance("S06-I4", "deletion")
    I.rec("msgA", "messenger", "임시 계정 정리는 2026-12-05에 진행합니다. 담당은 마도윤입니다.", "임시 계정 정리",
          "doyun.ma@example.test", "2026-11-18T10:00:00+09:00", scope=["channel:security"])
    I.rec("msgA", "messenger", "", "임시 계정 정리", "doyun.ma@example.test", "2026-11-18T10:00:00+09:00",
          version=2, updated="2026-11-19T11:00:00+09:00", op="delete", scope=["channel:security"])
    I.rec("wikiB", "wiki", "# 계정 정리 절차\n\n임시 계정 정리는 2026-12-05에 진행한다. 정리 전에 담당자 확인을 받는다.\n",
          "계정 정리 절차", "woojin.jung@example.test", "2026-10-20T10:00:00+09:00")
    I.rec("mailC", "mail", "임시 계정 정리 사전 공지: 2026-12-05 작업 예정입니다.\n", "임시 계정 정리 공지",
          "woojin.jung@example.test", "2026-11-19T09:00:00+09:00", participants=["woojin.jung@example.test", "all-dev@example.test"])
    I.ent("task", "Task", "임시 계정 정리", [("wikiB", "임시 계정 정리"), ("mailC", "임시 계정 정리")])
    I.ent("owner", "Person", "마도윤", [("msgA", "마도윤")], absent=True)
    I.fact("task", "owner", "마도윤", "2026-11-18", "2026-11-19", "removed",
           [("msgA", "담당은 마도윤입니다")], trigger=I.trig("msgA", 2))
    I.fact("task", "start_date", "2026-12-05", "2026-10-20", None, "verified",
           [("wikiB", "임시 계정 정리는 2026-12-05에 진행한다"), ("mailC", "2026-12-05 작업 예정입니다")])
    I.qa("임시 계정 정리 담당자는 누구인가?", [], [("msgA", "담당은 마도윤입니다")], answerable=False, trigger=I.trig("msgA", 2))
    I.qa("임시 계정 정리는 언제 하는가?", ["2026-12-05"], [("wikiB", "임시 계정 정리는 2026-12-05에 진행한다"), ("mailC", "2026-12-05 작업 예정입니다")])

    # --- S09-I4: re-sent announcement, cross-post, and a different date that must not merge -
    I = w.instance("S09-I4", "duplicate_threads")
    s = "VPN 점검으로 2026-12-06 02:00부터 04:00까지 접속이 제한됩니다."
    I.rec("mailA", "mail", s + "\n", "VPN 점검 안내", "sunwoo.baek@example.test", "2026-11-19T10:00:00+09:00", thread="thr-s09-i4-vpn")
    I.rec("mailB", "mail", s + "\n", "VPN 점검 안내", "sunwoo.baek@example.test", "2026-11-19T10:00:00+09:00", thread="thr-s09-i4-vpn",
          connector="conn-mail-02", ext="<s09-i4-mailB-resync@mail.example.test>")
    I.rec("msgC", "messenger", s, "VPN 점검 안내", "sunwoo.baek@example.test", "2026-11-19T10:05:00+09:00",
          thread="thr-s09-i4-chat", scope=["channel:infra"])
    I.rec("wikiD", "wiki", "# VPN 점검 안내\n\nVPN 점검은 2026-12-13 02:00부터 04:00까지 진행한다. (다음 점검)\n", "VPN 점검 안내",
          "sunwoo.baek@example.test", "2026-11-19T11:00:00+09:00")
    I.ent("d1", "Event", "VPN 점검 2026-12-06", [("mailA", s[:-1]), ("mailB", s[:-1]), ("msgC", s[:-1])])
    I.ent("d2", "Event", "VPN 점검 2026-12-13", [("wikiD", "VPN 점검은 2026-12-13 02:00부터 04:00까지 진행한다")])
    I.pair(("mailA", s[:-1]), ("mailB", s[:-1]), "d1", "d1")
    I.pair(("mailA", s[:-1]), ("msgC", s[:-1]), "d1", "d1")
    I.pair(("mailA", "VPN 점검으로 2026-12-06 02:00부터 04:00까지"), ("wikiD", "VPN 점검은 2026-12-13 02:00부터 04:00까지"), "d1", "d2")
    I.fact("d1", "start_date", "2026-12-06", "2026-11-19", None, "verified", [("mailA", "VPN 점검으로 2026-12-06 02:00부터 04:00까지 접속이 제한됩니다")])
    I.fact("d2", "start_date", "2026-12-13", "2026-11-19", None, "verified", [("wikiD", "VPN 점검은 2026-12-13 02:00부터 04:00까지 진행한다")])
    I.qa("2026-12-06 VPN 점검 시간은?", ["02:00부터 04:00까지"], [("mailA", "VPN 점검으로 2026-12-06 02:00부터 04:00까지 접속이 제한됩니다")])

    # --- S11-I4: a glossary table lists two similar names; no message says they are unrelated -
    I = w.instance("S11-I4", "distractor_noise")
    I.rec("wikiA", "wiki", "# 업무 용어 정리\n\n| 용어 | 설명 |\n|---|---|\n| 정산 리포트 | 재무팀이 매월 확인하는 월간 보고서 |\n| 야간 정산 배치 | 매일 03:00에 결제 내역을 집계하는 작업 |\n",
          "업무 용어 정리", "seoa.lee@example.test", "2026-09-10T10:00:00+09:00")
    I.rec("mailB", "mail", "어젯밤 야간 정산 배치가 20분 늦게 끝났습니다(2026-11-20 03:20 종료). 이후 실행은 정상입니다.\n", "배치 지연 안내",
          "yeonwoo.kang@example.test", "2026-11-20T09:00:00+09:00")
    I.rec("mailC", "mail", "정산 리포트 양식 개정 건입니다. 2026-11-30까지 새 양식으로 제출해 주세요. 개정 사유는 항목 명칭 정리입니다.\n", "리포트 양식 개정 안내",
          "seoa.lee@example.test", "2026-11-20T10:00:00+09:00", participants=["seoa.lee@example.test", "finance-team@example.test"])
    I.rec("msgD", "messenger", "양식 개정 공지 확인했습니다. 재무팀 템플릿부터 바꿔 두겠습니다.", "양식 확인",
          "minah.jo@example.test", "2026-11-20T10:30:00+09:00", scope=["channel:finance"])
    I.ent("report", "Document", "정산 리포트", [("wikiA", "정산 리포트"), ("mailC", "정산 리포트")])
    I.ent("batch", "System", "야간 정산 배치", [("wikiA", "야간 정산 배치"), ("mailB", "야간 정산 배치")])
    I.ent("revise", "Task", "리포트 양식 개정", [("mailC", "양식 개정")])
    I.pair(("wikiA", "정산 리포트"), ("wikiA", "야간 정산 배치"), "report", "batch")
    I.pair(("mailC", "정산 리포트"), ("wikiA", "정산 리포트"), "report", "report")
    I.rel("revise", "DEPENDS_ON", "batch", [("mailC", "개정 사유는 항목 명칭 정리입니다"), ("mailB", "야간 정산 배치가 20분 늦게 끝났습니다")], expected=False)
    I.rel("report", "RELATED_TO", "batch", [("wikiA", "| 정산 리포트 | 재무팀이 매월 확인하는 월간 보고서 |"),
                                            ("wikiA", "| 야간 정산 배치 | 매일 03:00에 결제 내역을 집계하는 작업 |")], expected=False)
    I.fact("revise", "target_date", "2026-11-30", "2026-11-20", None, "verified", [("mailC", "2026-11-30까지 새 양식으로 제출해 주세요")])
    I.ins("dependency_delay", "야간 배치 지연이 리포트 양식 개정 기한에 영향", True, ["batch", "revise"],
          [("mailB", "야간 정산 배치가 20분 늦게 끝났습니다"), ("mailC", "2026-11-30까지 새 양식으로 제출해 주세요")],
          expected=False)
    I.qa("정산 리포트 양식은 언제까지 새 양식으로 제출해야 하나?", ["2026-11-30"], [("mailC", "2026-11-30까지 새 양식으로 제출해 주세요")])
