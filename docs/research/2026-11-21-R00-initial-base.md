# 최초 base 생성 절차와 증거 (R00 보관)

- 날짜: 2026-11-21 / 관련: 이슈 #35(R00, 닫힘), 이슈 #15 R06-C1

이슈 #15의 R06-C1은 "#35에서 확정·실행한 최초 base 생성 절차와 증거를 보관한다"고 요구한다. 이 문서는 이슈 #35에 남은 기록을 저장소 안으로 옮긴 것이다. 새로 실행한 것은 없다.

## 왜 필요했는가

저장소에 commit이 하나도 없어 `origin/main`이 없었다. 모든 변경은 feature 브랜치의 PR로 들어오는데, PR은 기준이 되는 브랜치(base)가 있어야 만들 수 있다. 그래서 다른 모든 작업보다 먼저 최초 commit 하나를 `main`에 직접 올렸다. `main`에 직접 올린 것은 이 한 번뿐이다.

## 절차 (R00-C1)

1. README, `.gitignore`, LICENSE만 담은 commit 하나를 로컬 `main`에 만든다.
2. `origin/main`으로 push한다.
3. 이후의 변경은 `origin/main`에서 만든 feature 작업 디렉터리와 PR로만 들어온다.

사용자가 2026-11-21에 이 직접 push를 승인했고 제품 라이선스를 MIT로 정했다.

## 내용 (R00-C2)

commit `de24ded` — `README.md`, `.gitignore`, `LICENSE`(MIT). 제품 코드, 비밀 값, 배포처 정보는 없다.

## 실행 증거 (R00-C3)

이슈 #35의 댓글에 남은 명령과 출력이다. 작업 디렉터리의 로컬 경로는 그 기록에서 이미 `<root>`로 가려져 있었다.

```text
$ git push -u origin main
 * [new branch]      main -> main
$ git ls-remote origin main
de24ded8e116207f44b2cbff72ff591f53d69184	refs/heads/main
$ git worktree add <root>/project/.worktrees/PKI/docs/phase0-oss-evaluation -b docs/phase0-oss-evaluation --no-track origin/main
HEAD is now at de24ded chore(PKI): 최초 base 커밋 (README·.gitignore·LICENSE)
$ gh api repos/nohdol97/PKI/branches --jq 'map(.name)'
["main"]
```

## 미검증 범위

branch protection은 설정하지 않았다. `main`에 직접 push하지 않는다는 것은 규칙으로만 지켜진다.
