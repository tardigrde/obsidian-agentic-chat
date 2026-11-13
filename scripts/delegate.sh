#!/usr/bin/env bash
# Run a headless opencode worker or reviewer in one worktree.
#
#   npm run delegate -- work   <worktree> <spec.md>
#   npm run delegate -- review <pr> <worktree> "<focus>"
#   npm run delegate -- recheck <pr> <worktree>
#   npm run delegate -- update  <pr> <worktree>
#   npm run delegate -- ship    <worktree> <spec.md> "<pr title>" "<review focus>"
#
# work:    implement the spec; edits allowed only inside the worktree.
# review:  read-only verify-pr review; may write only logs/delegate/verdict-<pr>.md.
# recheck: after a merge from main, wait for CI at the new head and write
#          logs/delegate/recheck-<pr>.md; posts it and re-runs the Review gate.
# update:  merge origin/main into the PR, take main's feature map and fix its
#          refs, fold that into the merge commit, push, then recheck.
# ship:    work, then the script (not the worker) pushes and opens the PR from
#          logs/delegate/pr-body.md, then review. Stops at a FAIL or for the merge.
# review and recheck post their file to the PR and re-run the Review gate.
#
# Sandbox: `opencode run --standalone` with OpenCode V2 `permissions` rules in
# OPENCODE_CONFIG_CONTENT (see scripts/delegate-config.mjs). Without --standalone
# the shared background service ignores the client's env, so no rule applies.
# Known limit: allowed commands like `npm run verify` run repository code.
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

# Sandbox rules live in scripts/delegate-config.mjs (unit-tested).
config() { # <work|review> <edit-resource, relative to the worktree>
  node "$ROOT/scripts/delegate-config.mjs" permissions "$1" "$MAIN" "$2"
}

run() { # <worktree> <title> <config> <prompt-file> <log>
  # gitGuardEnv: git ignores fsmonitor and hooks for the worker's whole process tree.
  (cd "$1" && eval "$(node "$ROOT/scripts/delegate-config.mjs" git-env)" && \
    OPENCODE_CONFIG_CONTENT="$3" opencode run --standalone --archived \
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

# Re-run the newest pull_request "Review gate" run for this PR. The `review`
# check comes from that run; a new comment alone does not update it.
gate_rerun() { # <pr>
  local branch run
  branch=$(gh pr view "$1" --json headRefName -q .headRefName)
  sleep 5
  run=$(gh run list --branch "$branch" --workflow "Review gate" --event pull_request -L 1 --json databaseId -q '.[0].databaseId')
  [ -n "$run" ] || { echo "delegate: no Review gate run for #$1" >&2; return 0; }
  gh run watch "$run" > /dev/null 2>&1 || true
  gh run rerun "$run" > /dev/null 2>&1 || true
  sleep 10
  gh run watch "$run" > /dev/null 2>&1 || true
  echo "review gate #$1: $(gh pr checks "$1" --json name,state -q '.[] | select(.name=="review") | .state')"
}

# Post a verdict or recheck file and set the labels a PASS earns.
post_verdict() { # <pr> <file> <worktree>
  local pr=$1 file=$2 w=$3 verdict files lines
  gh pr comment "$pr" --body-file "$file" > /dev/null
  verdict=$(sed -n 's/^Verdict: //p' "$file" | head -n 1)
  if [ "$verdict" = "PASS" ] || [ "$verdict" = "PASS+NOTES" ]; then
    # The reviewer confirms a pure refactor; the label then replaces the witness run.
    if grep -qi '^Behavior change: none' "$file"; then gh pr edit "$pr" --add-label no-behavior-change > /dev/null; fi
    # A reviewed PR over the size budget gets the override (the owner prefers few PRs).
    read -r files lines < <(git -C "$w" diff --numstat origin/main...HEAD -- src | awk '$1 != "-" { f++; l += $1 } END { print f + 0, l + 0 }')
    if [ "$files" -gt 25 ] || [ "$lines" -gt 1000 ]; then gh pr edit "$pr" --add-label large-pr > /dev/null; fi
  fi
  gate_rerun "$pr"
}

# Wait for CI at <sha>; print "PASS" only when ci and e2e both pass there.
ci_at_head() { # <pr> <sha>
  local pr=$1 sha=$2 deadline=$((SECONDS + 1800)) state
  while [ $SECONDS -lt $deadline ]; do
    [ "$(gh pr view "$pr" --json headRefOid -q .headRefOid)" = "$sha" ] || { echo "MOVED"; return; }
    state=$(gh pr checks "$pr" --json name,state -q '[.[] | select(.name=="ci" or .name=="e2e") | .state] | join(" ")')
    case "$state" in
      *FAILURE*|*ERROR*|*CANCELLED*) echo "FAIL"; return ;;
      "SUCCESS SUCCESS") echo "PASS"; return ;;
    esac
    sleep 30
  done
  echo "TIMEOUT"
}

cmd=${1:-}; shift || true
# Steps shared by the commands below.
do_work() { # <worktree-name> <spec.md>
  W=$(tree "$1"); SPEC=$(realpath "$2"); mkdir -p "$W/logs/delegate"
  LOG="$W/logs/delegate/work-$(date +%H%M%S).log"
  PROMPT="$W/logs/delegate/work-prompt.md"
  { cat "$ROOT/.agents/skills/factory/spec-rules.md"; echo; cat "$SPEC"; cat <<EOF

Rules: work only in $W. Read AGENTS.md and follow .agents/skills/ship-change/SKILL.md.
Do not push and do not open a PR. Run every check in the foreground (never in the
background), then commit on the branch with a conventional message.
Also write logs/delegate/pr-body.md from .github/pull_request_template.md: why, what
changed, the witness block (or "Refactor: no runtime behavior change"), and the
witness red/green result. Do not paste test counts in it; the verdict carries them.
Final message: files changed, the witness (fails before, passes after, with counts),
the fast-lane unit and smoke e2e counts, and the commit hash.
EOF
  } > "$PROMPT"
  status=0
  run "$W" "work $1" "$(config work "*")" "$PROMPT" "$LOG" || status=$?
  echo "log: $LOG (exit $status)"; tail -n 25 "$LOG"
  return "$status"
}

do_review() { # <pr> <worktree-name> <focus>
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
Always: prove the witness. For a src/ change it must fail ON AN ASSERTION without the
src change, for example node scripts/verify-witness.mjs --base origin/main --test-file <t> --src <s>.
Fast lane: if \`gh pr checks $PR\` shows ci and e2e passing at this head, cite them and do
not re-run \`npm run verify -- fast\`. Otherwise run it and report the counts.
Decide whether the change alters runtime behavior. Write "none" only for a pure
refactor that you checked against the diff.

Shell output redirection (>) is denied; read files with the read tool.
Write the verdict to $OUT (relative to the worktree) with the edit tool, first lines exactly:
Verdict: PASS | PASS+NOTES | FAIL
Head: $HEAD
Reviewer: $REVIEWER
Fast lane: PASS (<n> passed unit; smoke e2e <n> passed) | CI (ci + e2e green at this head)
Behavior change: none | yes (<one line>)
Then findings with file:line. A FAIL needs a concrete failure scenario.
EOF
  status=0
  run "$W" "review $PR" "$(config review "$OUT")" "$PROMPT" "$LOG" || status=$?
  [ -f "$W/$OUT" ] || die "no verdict written (exit $status); see $LOG"
  [ "$status" -eq 0 ] || echo "delegate: WARNING reviewer exited $status; the verdict may be partial" >&2
  echo "verdict: $W/$OUT"; head -n 5 "$W/$OUT"
  post_verdict "$PR" "$W/$OUT" "$W"
  return "$status"
}

do_recheck() { # <pr> <worktree-name> <reviewed-head>
  PR=$1; W=$(tree "$2"); REVIEWED=$3
  HEAD=$(git -C "$W" rev-parse HEAD)
  [ "$HEAD" != "$REVIEWED" ] || die "head did not move; run a real review instead"
  git -C "$W" fetch -q origin main
  # A re-check may only carry a reviewed head across a merge from main. It must
  # never stand in for a review: refuse when the PR's own diff changed.
  [ "$(git -C "$W" rev-list --no-merges "$REVIEWED..$HEAD" --not origin/main | wc -l)" -eq 0 ] \
    || die "new non-merge commits since ${REVIEWED:0:7}; run a real review instead"
  state=0
  gh pr view "$PR" --json comments -q '[.comments[].body]' \
    | node "$ROOT/scripts/delegate-config.mjs" recheck "$REVIEWED" || state=$?
  [ "$state" -eq 0 ] || die "no passing review at ${REVIEWED:0:7}, or a later FAIL (state $state); run a real review"
  PR_HEAD=$(gh pr view "$PR" --json headRefOid -q .headRefOid)
  [ "$HEAD" = "$PR_HEAD" ] || die "worktree head ${HEAD:0:7} is not PR head ${PR_HEAD:0:7}"
  # CI already runs the fast lane and e2e at this head; wait for it instead of a local run.
  ci=$(ci_at_head "$PR" "$HEAD")
  [ "$ci" = "PASS" ] || die "CI at ${HEAD:0:7}: $ci"
  OUT="$W/logs/delegate/recheck-$PR.md"
  cat > "$OUT" <<EOF
Verdict: PASS
Head: $HEAD
Reviewer: re-check of ${REVIEWED:0:7} after update from main
Fast lane: CI (ci + e2e green at this head)

Update from \`main\` only: no new non-merge commits since the reviewed head
\`${REVIEWED:0:7}\`. The PR's own diff: $(git -C "$W" diff --stat origin/main...HEAD | tail -n 1).
EOF
  echo "recheck: $OUT"; cat "$OUT"
  post_verdict "$PR" "$OUT" "$W"
}

case "$cmd" in
  work)
    [ $# -eq 2 ] || die "usage: work <worktree> <spec.md>"
    do_work "$1" "$2"
    ;;
  review)
    [ $# -eq 3 ] || die "usage: review <pr> <worktree> \"<focus>\""
    do_review "$1" "$2" "$3"
    ;;
  recheck)
    # Old flow: the worktree is still at the reviewed head; pull the merged head.
    [ $# -eq 2 ] || die "usage: recheck <pr> <worktree>"
    W=$(tree "$2"); REVIEWED=$(git -C "$W" rev-parse HEAD)
    git -C "$W" pull -q --ff-only
    do_recheck "$1" "$2" "$REVIEWED"
    ;;
  update)
    [ $# -eq 2 ] || die "usage: update <pr> <worktree>"
    PR=$1; W=$(tree "$2")
    REVIEWED=$(git -C "$W" rev-parse HEAD)
    [ "$REVIEWED" = "$(gh pr view "$PR" --json headRefOid -q .headRefOid)" ] || die "worktree is not at the PR head"
    [ -z "$(git -C "$W" status --porcelain --untracked-files=no)" ] || die "worktree has uncommitted changes"
    git -C "$W" fetch -q origin main
    if git -C "$W" merge-base --is-ancestor origin/main HEAD; then die "already up to date with main"; fi
    git -C "$W" merge --no-ff --no-commit origin/main > /dev/null 2>&1 || true
    MAP=.agents/skills/verify-obsidian-chat/features
    if git -C "$W" diff --name-only --diff-filter=U | grep -v "^$MAP/" | grep -q .; then
      git -C "$W" diff --name-only --diff-filter=U | grep -v "^$MAP/" >&2
      git -C "$W" merge --abort; die "source conflicts; resolve them by hand"
    fi
    # The feature map follows the code: take main's map, then let the checker fix refs.
    git -C "$W" checkout origin/main -- "$MAP"
    if grep -q -- '--fix' "$W/scripts/check-feature-map.mjs"; then
      (cd "$W" && node scripts/check-feature-map.mjs --fix > /dev/null) || true
    elif [ -f "$MAIN/logs/factory-2026-11-12/remap-feature-refs.py" ]; then
      (cd "$W" && python3 -I "$MAIN/logs/factory-2026-11-12/remap-feature-refs.py" > /dev/null) || true
    fi
    (cd "$W" && node scripts/check-feature-map.mjs > /dev/null) \
      || { git -C "$W" merge --abort; die "feature map does not pass after the merge; fix it by hand"; }
    git -C "$W" add -A "$MAP"
    git -C "$W" commit -q --no-edit
    git -C "$W" push -q
    do_recheck "$PR" "$2" "$REVIEWED"
    ;;
  ship)
    [ $# -eq 4 ] || die "usage: ship <worktree> <spec.md> \"<pr title>\" \"<review focus>\""
    do_work "$1" "$2" || die "worker failed; read the log before shipping"
    W=$(tree "$1")
    [ -s "$W/logs/delegate/pr-body.md" ] || die "worker wrote no logs/delegate/pr-body.md"
    [ -n "$(git -C "$W" log --oneline origin/main..HEAD)" ] || die "worker made no commit"
    [ -z "$(git -C "$W" status --porcelain --untracked-files=no)" ] || die "worker left uncommitted changes"
    # The script pushes, never the worker: the worker sandbox has no push rule.
    git -C "$W" push -q -u origin HEAD
    { cat "$W/logs/delegate/pr-body.md"; printf '\nDo not merge this PR without an explicit "merge" from the repository owner.\n'; } > "$W/logs/delegate/pr-body.final.md"
    PR=$(gh pr create --title "$3" --body-file "$W/logs/delegate/pr-body.final.md" | grep -o '[0-9]*$')
    echo "opened #$PR"
    do_review "$PR" "$1" "$4"
    ;;
  *) die "usage: delegate work|review|recheck|update|ship ..." ;;
esac
