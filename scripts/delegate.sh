#!/usr/bin/env bash
# Run a headless opencode worker or reviewer in one worktree.
#
#   npm run delegate -- work   <worktree> <spec.md>
#   npm run delegate -- review <pr> <worktree> "<focus>"
#   npm run delegate -- recheck <pr> <worktree>
#
# work:    implement the spec in the worktree; edits allowed only there.
# review:  read-only verify-pr review; writes logs/delegate/verdict-<pr>.md.
# recheck: after `gh pr update-branch`, re-run the fast lane at the new head
#          and write logs/delegate/recheck-<pr>.md (post it with gh pr comment).
#
# Model: DELEGATE_MODEL (default opencode-go/deepseek-v4.1-flash, flat-rate).
# Logs and verdicts go to <worktree>/logs/delegate/ (git-ignored).
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
MAIN=$(git -C "$ROOT" worktree list --porcelain | awk '/^worktree /{print $2; exit}')
TREES="$(dirname "$MAIN")/$(basename "$MAIN")-worktrees"
MODEL=${DELEGATE_MODEL:-opencode-go/deepseek-v4.1-flash}

die() { echo "delegate: $*" >&2; exit 1; }
tree() { local w="$TREES/$1"; [ -d "$w" ] || die "no worktree $w (npm run worktree:new -- $1)"; echo "$w"; }

# Permission config: edits only where allowed, a bash allowlist, no web.
config() { # <edit-allow-glob> <extra-bash-csv>
  python3 -I - "$1" "$MAIN" "$2" <<'PY'
import json, sys
edit, main, extra = sys.argv[1:4]
allow = ["git status*", "git diff*", "git log*", "git show*", "git rev-parse*", "git stash*",
         "npx vitest*", "npx tsc*", "npx eslint*", "npm run verify*", "node scripts/verify.mjs*",
         "node scripts/verify-witness.mjs*", "npm run verify:witness*", "npm ls*",
         "gh pr view*", "gh pr diff*", "cat *", "ls*", "grep *", "rg *", "sed -n*",
         "head *", "tail *", "wc *", "find *"] + [x for x in extra.split(",") if x]
print(json.dumps({"permission": {
    "edit": {"*": "deny", edit: "allow"},
    "webfetch": "deny",
    "external_directory": {"*": "deny", f"{main}/node_modules/*": "allow",
                           f"{main}/.obsidian-cache/*": "allow", "/tmp/*": "allow"},
    "bash": {"*": "deny", **{p: "allow" for p in allow}}}}))
PY
}

run() { # <worktree> <title> <config> <prompt-file> <log>
  (cd "$1" && OPENCODE_CONFIG_CONTENT="$3" opencode run --archived --title "$2" --model "$MODEL" < "$4" > "$5" 2>&1)
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
    run "$W" "work $1" "$(config "$W/*" "git add*,git commit*,npm run lint*,npm run typecheck*")" "$PROMPT" "$LOG" || true
    echo "log: $LOG"; tail -25 "$LOG"
    ;;
  review)
    [ $# -eq 3 ] || die "usage: review <pr> <worktree> \"<focus>\""
    PR=$1; W=$(tree "$2"); mkdir -p "$W/logs/delegate"
    HEAD=$(git -C "$W" rev-parse HEAD); OUT="$W/logs/delegate/verdict-$PR.md"
    PROMPT="$W/logs/delegate/review-$PR.md"; LOG="$W/logs/delegate/review-$PR.log"
    cat > "$PROMPT" <<EOF
You are an independent reviewer. You did not write this change. Work in $W (head $HEAD).
Read AGENTS.md and .agents/skills/verify-pr/SKILL.md first and follow verify-pr.
Do not edit any repo file. Do not run live chaos, opencode, or any live model call.

Review PR #$PR (gh pr view $PR; git diff origin/main...HEAD).
Focus: $3
Always: prove the witness (for a src/ change it must fail without the src change,
for example node scripts/verify-witness.mjs --base origin/main --test-file <t> --src <s>),
and run npm run verify:fast; report the unit and smoke e2e counts.

Write the verdict to $OUT, first lines exactly:
Verdict: PASS | PASS+NOTES | FAIL
Head: $HEAD
Reviewer: opencode $(basename "$MODEL")
Fast lane: PASS (<n> passed, <files> files; smoke e2e <n> passed)
Then findings with file:line. A FAIL needs a concrete failure scenario.
EOF
    run "$W" "review $PR" "$(config "$OUT" "")" "$PROMPT" "$LOG" || true
    [ -f "$OUT" ] || die "no verdict written; see $LOG"
    echo "verdict: $OUT"; head -4 "$OUT"
    ;;
  recheck)
    [ $# -eq 2 ] || die "usage: recheck <pr> <worktree>"
    PR=$1; W=$(tree "$2"); mkdir -p "$W/logs/delegate"
    git -C "$W" pull -q --ff-only
    HEAD=$(git -C "$W" rev-parse HEAD); OUT="$W/logs/delegate/recheck-$PR.md"
    LOG="$W/logs/delegate/fast-$PR-${HEAD:0:7}.log"
    (cd "$W" && npm run verify -- fast > "$LOG" 2>&1) || die "fast lane failed at $HEAD; see $LOG"
    UNIT=$(grep "unit tests" "$LOG" | grep -o "[0-9]* passed" | head -1)
    SMOKE=$(grep "smoke e2e" "$LOG" | grep -o "[0-9]* passed" | head -1)
    cat > "$OUT" <<EOF
Verdict: PASS
Head: $HEAD
Reviewer: re-check after update from main ($(basename "$MODEL") review above)
Fast lane: PASS ($UNIT, 0 failed unit; smoke e2e $SMOKE)

Update from \`main\` only; the PR's own diff is unchanged: $(git -C "$W" diff --stat origin/main...HEAD | tail -1).
EOF
    echo "recheck: $OUT"; cat "$OUT"
    ;;
  *) die "usage: delegate work|review|recheck ..." ;;
esac
