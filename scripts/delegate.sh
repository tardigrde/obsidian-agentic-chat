#!/usr/bin/env bash
# Run a headless opencode worker or reviewer in one worktree.
#
#   npm run delegate -- work   <worktree> <spec.md>
#   npm run delegate -- review <pr> <worktree> "<focus>"
#   npm run delegate -- recheck <pr> <worktree>
#
# work:    implement the spec; edits allowed only inside the worktree.
# review:  read-only verify-pr review; may write only logs/delegate/verdict-<pr>.md.
# recheck: after `gh pr update-branch`, re-run the fast lane at the new head and
#          write logs/delegate/recheck-<pr>.md (post it with gh pr comment).
#
# Sandbox: `opencode run --standalone` with OpenCode V2 `permissions` rules in
# OPENCODE_CONFIG_CONTENT. Without --standalone the shared background service
# ignores the client's env, so no rule applies. Rules: deny everything, then
# allow reads (not .env), edits inside the project (work) or only the verdict
# file (review), and a shell allowlist without cat/grep/head/tail (the read and
# grep tools cover those and obey the .env deny). Web, code execution, and
# subagents stay denied.
#
# Model: DELEGATE_MODEL (default opencode-go/deepseek-v4.1-flash, flat-rate).
# Logs and verdicts go to <worktree>/logs/delegate/ (git-ignored).
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
MAIN=$(git -C "$ROOT" worktree list --porcelain | sed -n 's/^worktree //p' | head -n 1)
TREES="$(dirname "$MAIN")/$(basename "$MAIN")-worktrees"
MODEL=${DELEGATE_MODEL:-opencode-go/deepseek-v4.1-flash}
REVIEWER="opencode $(basename "$MODEL")"

die() { echo "delegate: $*" >&2; exit 1; }
tree() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || die "bad worktree name: $1"
  local w="$TREES/$1"
  [ -d "$w" ] || die "no worktree $w (npm run worktree:new -- $1)"
  echo "$w"
}

# V2 permissions. Last matching rule wins, so the catch-all deny comes first.
config() { # <edit-resource, relative to the worktree> <extra-shell-csv>
  python3 -I - "$1" "$MAIN" "$2" <<'PY'
import json, sys
edit, main, extra = sys.argv[1:4]
shell = ["git status *", "git diff *", "git log *", "git show *", "git rev-parse *", "git stash *",
         "npx vitest *", "npx tsc *", "npx eslint *", "npm run verify *", "npm run verify:*",
         "node scripts/verify.mjs *", "node scripts/verify-witness.mjs *", "npm ls *",
         "gh pr view *", "gh pr diff *", "ls *", "wc *"] + [x for x in extra.split(",") if x]
rule = lambda action, resource, effect: {"action": action, "resource": resource, "effect": effect}
rules = [rule("*", "*", "deny")]
rules += [rule(a, "*", "allow") for a in ("read", "glob", "grep", "list", "todowrite", "todoread")]
rules += [rule("read", p, "deny") for p in ("*.env", "*.env.*", "*auth.json")]
rules += [rule("external_directory", f"{main}/node_modules/*", "allow"),
          rule("external_directory", f"{main}/.obsidian-cache/*", "allow")]
rules += [rule("edit", edit, "allow")]
rules += [rule("shell", s, "allow") for s in shell]
print(json.dumps({"permissions": rules}))
PY
}

run() { # <worktree> <title> <config> <prompt-file> <log>
  (cd "$1" && OPENCODE_CONFIG_CONTENT="$3" opencode run --standalone --archived \
    --title "$2" --model "$MODEL" < "$4" > "$5" 2>&1)
}

# Newest fast-lane summary in a worktree: "<unit passed> <smoke passed>".
fast_counts() {
  local summary
  summary=$(ls -t "$1"/logs/verify/*/summary.json 2>/dev/null | head -n 1) || true
  [ -n "$summary" ] || die "no verify summary in $1/logs/verify"
  python3 -I - "$summary" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
if s.get("lane") != "fast" or s.get("verdict") != "PASS":
    sys.exit(f"summary is lane={s.get('lane')} verdict={s.get('verdict')}, not a passing fast lane")
counts = {step["label"]: (step.get("counts") or {}) for step in s["steps"]}
unit, smoke = counts.get("unit tests", {}).get("passed"), counts.get("smoke e2e", {}).get("passed")
if not unit or not smoke:
    sys.exit("fast summary has no unit or smoke e2e count")
print(unit, smoke)
PY
}

cmd=${1:-}; shift || true
case "$cmd" in
  work)
    [ $# -eq 2 ] || die "usage: work <worktree> <spec.md>"
    W=$(tree "$1"); SPEC=$(realpath "$2"); mkdir -p "$W/logs/delegate"
    LOG="$W/logs/delegate/work-$(date +%H%M%S).log"
    PROMPT="$W/logs/delegate/work-prompt.md"
    { cat "$SPEC"; cat <<EOF

Rules: work only in $W. Read AGENTS.md and follow .agents/skills/ship-change/SKILL.md.
Do not push and do not open a PR. Run every check in the foreground (never in the
background), then commit on the branch with a conventional message.
Final message: files changed, the witness (fails before, passes after, with counts),
the fast-lane unit and smoke e2e counts, and the commit hash.
EOF
    } > "$PROMPT"
    status=0
    run "$W" "work $1" "$(config "*" "git add *,git commit *,npm run lint *,npm run typecheck *")" "$PROMPT" "$LOG" || status=$?
    echo "log: $LOG (exit $status)"; tail -n 25 "$LOG"
    exit "$status"
    ;;
  review)
    [ $# -eq 3 ] || die "usage: review <pr> <worktree> \"<focus>\""
    PR=$1; W=$(tree "$2"); mkdir -p "$W/logs/delegate"
    git -C "$W" pull -q --ff-only
    HEAD=$(git -C "$W" rev-parse HEAD)
    PR_HEAD=$(gh pr view "$PR" --json headRefOid -q .headRefOid)
    [ "$HEAD" = "$PR_HEAD" ] || die "worktree head ${HEAD:0:7} is not PR head ${PR_HEAD:0:7}"
    OUT="logs/delegate/verdict-$PR.md"
    PROMPT="$W/logs/delegate/review-$PR.md"; LOG="$W/logs/delegate/review-$PR.log"
    rm -f "$W/$OUT"
    cat > "$PROMPT" <<EOF
You are an independent reviewer. You did not write this change. Work in $W (head $HEAD).
Read AGENTS.md and .agents/skills/verify-pr/SKILL.md first and follow verify-pr.
Do not edit any repo file. Do not run live chaos, opencode, or any live model call.

Review PR #$PR (gh pr view $PR; git diff origin/main...HEAD).
Focus: $3
Always: prove the witness (for a src/ change it must fail without the src change,
for example node scripts/verify-witness.mjs --base origin/main --test-file <t> --src <s>),
and run npm run verify -- fast; report the unit and smoke e2e counts.

Write the verdict to $OUT (relative to the worktree), first lines exactly:
Verdict: PASS | PASS+NOTES | FAIL
Head: $HEAD
Reviewer: $REVIEWER
Fast lane: PASS (<n> passed, <files> files; smoke e2e <n> passed)
Then findings with file:line. A FAIL needs a concrete failure scenario.
EOF
    status=0
    run "$W" "review $PR" "$(config "$OUT" "")" "$PROMPT" "$LOG" || status=$?
    [ -f "$W/$OUT" ] || die "no verdict written (exit $status); see $LOG"
    echo "verdict: $W/$OUT"; head -n 4 "$W/$OUT"
    ;;
  recheck)
    [ $# -eq 2 ] || die "usage: recheck <pr> <worktree>"
    PR=$1; W=$(tree "$2"); mkdir -p "$W/logs/delegate"
    REVIEWED=$(git -C "$W" rev-parse HEAD)
    git -C "$W" pull -q --ff-only
    HEAD=$(git -C "$W" rev-parse HEAD)
    # A re-check may only carry a reviewed head across a merge from main. It must
    # never stand in for a review: refuse when nothing moved or the PR's own diff changed.
    [ "$HEAD" != "$REVIEWED" ] || die "head did not move; run a real review instead"
    git -C "$W" fetch -q origin main
    [ "$(git -C "$W" rev-list --no-merges "$REVIEWED..$HEAD" --not origin/main | wc -l)" -eq 0 ] \
      || die "new non-merge commits since ${REVIEWED:0:7}; run a real review instead"
    # The review gate lets a PASS from another reviewer clear a FAIL; a re-check must not.
    if grep -qx "Verdict: FAIL" "$W/logs/delegate/verdict-$PR.md" 2>/dev/null; then
      die "the last review of #$PR is FAIL; fix it and run a real review"
    fi
    PR_HEAD=$(gh pr view "$PR" --json headRefOid -q .headRefOid)
    [ "$HEAD" = "$PR_HEAD" ] || die "worktree head ${HEAD:0:7} is not PR head ${PR_HEAD:0:7}"
    OUT="$W/logs/delegate/recheck-$PR.md"
    (cd "$W" && npm run verify -- fast > "$W/logs/delegate/fast-$PR-${HEAD:0:7}.log" 2>&1) \
      || die "fast lane failed at ${HEAD:0:7}; see $W/logs/delegate/fast-$PR-${HEAD:0:7}.log"
    read -r UNIT SMOKE < <(fast_counts "$W")
    cat > "$OUT" <<EOF
Verdict: PASS
Head: $HEAD
Reviewer: re-check of ${REVIEWED:0:7} after update from main
Fast lane: PASS ($UNIT passed, 0 failed unit; smoke e2e $SMOKE passed)

Update from \`main\` only: no new non-merge commits since the reviewed head
\`${REVIEWED:0:7}\`. The PR's own diff: $(git -C "$W" diff --stat origin/main...HEAD | tail -n 1).
EOF
    echo "recheck: $OUT"; cat "$OUT"
    ;;
  *) die "usage: delegate work|review|recheck ..." ;;
esac
