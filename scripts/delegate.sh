#!/usr/bin/env bash
# Run a headless opencode reviewer or researcher. The lead agent implements and
# fixes; a delegate only reviews or researches (#393 T26).
#
#   npm run delegate -- review   <pr> <worktree> "<focus>"
#   npm run delegate -- research <name> "<question>"
#
# review:   read-only verify-pr review of a PR in its worktree; may write only
#           logs/delegate/verdict-<pr>.md, which the script posts to the PR as
#           an advisory comment (no gate).
# research: read-only question about the code in the main checkout; may write
#           only logs/delegate/research-<name>.md.
#
# Sandbox: `opencode run --standalone` with OpenCode V2 `permissions` rules in
# OPENCODE_CONFIG_CONTENT (see scripts/delegate-config.mjs). Without --standalone
# the shared background service ignores the client's env, so no rule applies.
# Known limit: allowed commands like `npm run verify` run repository code.
#
# Model: DELEGATE_MODEL (default opencode-go/deepseek-v4.1-flash, flat-rate).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: npm run delegate -- <subcommand> ...

Subcommands:
  review   <pr> <worktree> "<focus>"   agent review of a PR; posts the verdict
  research <name> "<question>"         read-only research; writes a report
EOF
}

case "${1:-}" in
  -h | --help | help) usage; exit 0 ;;
esac

ROOT=$(git rev-parse --show-toplevel)
MAIN=$(git -C "$ROOT" worktree list --porcelain | sed -n 's/^worktree //p' | head -n 1)
TREES="$(dirname "$MAIN")/$(basename "$MAIN")-worktrees"
MODEL=${DELEGATE_MODEL:-opencode-go/deepseek-v4.1-flash}
REVIEWER="opencode $(basename "$MODEL")"

die() { echo "delegate: $*" >&2; exit 1; }
name_ok() { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || die "bad name: $1"; }
tree() {
  name_ok "$1"
  local w="$TREES/$1"
  [ -d "$w" ] || die "no worktree $w (npm run worktree:new -- $1)"
  echo "$w"
}

# Sandbox rules live in scripts/delegate-config.mjs (unit-tested): read-only,
# one writable file.
config() { # <edit-resource, relative to the run directory>
  node "$ROOT/scripts/delegate-config.mjs" permissions review "$MAIN" "$1"
}

run() { # <dir> <title> <config> <prompt-file> <log>
  local dir=$1 title=$2 config_content=$3 prompt_file=$4 log_file=$5
  # gitGuardEnv: git ignores fsmonitor and hooks for the delegate's whole process tree.
  # Redact before tee: a child that prints its environment must not reach a log.
  (cd "$dir" && eval "$(node "$ROOT/scripts/delegate-config.mjs" git-env)" && \
    OPENCODE_CONFIG_CONTENT="$config_content" opencode run --standalone --archived \
    --title "$title" --model "$MODEL" < "$prompt_file" 2>&1 | node "$ROOT/scripts/redact-log.mjs" | tee "$log_file")
}

# Post a verdict and set the label a PASS earns. The comment is advisory (#393 D4).
post_verdict() { # <pr> <file>
  local pr=$1 file=$2 verdict
  # A reviewer may paste a log; redact the file before it becomes a comment.
  node "$ROOT/scripts/redact-log.mjs" --file "$file" --in-place
  gh pr comment "$pr" --body-file "$file" > /dev/null
  verdict=$(sed -n 's/^Verdict: //p' "$file" | head -n 1)
  if [ "$verdict" = "PASS" ] || [ "$verdict" = "PASS+NOTES" ]; then
    # The reviewer confirms a pure refactor; the label then replaces the witness run.
    if grep -qi '^Behavior change: none' "$file"; then gh pr edit "$pr" --add-label no-behavior-change > /dev/null; fi
  fi
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
  # The reviewer may not call `gh`, so wait for the OpenCode job here and write its state
  # and its findings for this head to one file (DELEGATE_OPENCODE_WAIT seconds, default 600).
  BOT="$W/logs/delegate/opencode-$PR.md"
  (cd "$W" && node "$ROOT/scripts/delegate-opencode.mjs" "$PR" "$BOT" --head "$HEAD") \
    || echo "OpenCode job: unknown
The finder step crashed. The findings were NOT read. Say so in the verdict." > "$BOT"
  cat > "$PROMPT" <<EOF
You are the reviewer agent. You did not write this change. Work in $W (head $HEAD).
Read AGENTS.md and .agents/skills/verify-pr/SKILL.md first and follow verify-pr.
Do not edit any repo file. Do not run live chaos, opencode, or any live model call.
Do not start Obsidian: no e2e, \`verify -- app\`, dogfood, eval, or explore. Allowed:
\`npm run verify -- check --no-app\` (lint, typecheck, unit, build), \`npx vitest\`, and a
unit-test witness.

Review PR #$PR (gh pr view $PR; git diff origin/main...HEAD).
Focus: $3
Always: prove the witness. For a src/ change it must fail ON AN ASSERTION without the
src change, for example node scripts/verify-witness.mjs --base origin/main --test-file <t> --src <s>.
Fast lane: if \`gh pr checks $PR\` shows ci and e2e passing at this head, cite them and do
not re-run \`npm run verify -- check --no-app\`. Otherwise run it and report the counts.
Read logs/delegate/opencode-$PR.md. Its first line is "OpenCode job: <state>". Only "pass"
means the finder ran. For any other state, say in the verdict that the finder did not run;
that is not "no findings". Confirm or reject each inline finding in your findings.
Decide whether the change alters runtime behavior. Write "none" only for a pure
refactor that you checked against the diff.

Shell output redirection (>) is denied; read files with the read tool.
Write the verdict to $OUT (relative to the worktree) with the edit tool, first lines exactly:
Verdict: PASS | PASS+NOTES | FAIL
Head: $HEAD
Reviewer: $REVIEWER
Fast lane: PASS (<n> passed, <n> files) | CI (ci + e2e green at this head)
Behavior change: none | yes (<one line>)
Then findings with file:line. A FAIL needs a concrete failure scenario.
EOF
  status=0
  run "$W" "review $PR" "$(config "$OUT")" "$PROMPT" "$LOG" || status=$?
  [ -f "$W/$OUT" ] || die "no verdict written (exit $status); see $LOG"
  [ "$status" -eq 0 ] || echo "delegate: WARNING reviewer exited $status; the verdict may be partial" >&2
  echo "verdict: $W/$OUT"; head -n 5 "$W/$OUT"
  post_verdict "$PR" "$W/$OUT"
  return "$status"
}

do_research() { # <name> <question>
  name_ok "$1"; mkdir -p "$MAIN/logs/delegate"
  OUT="logs/delegate/research-$1.md"
  PROMPT="$MAIN/logs/delegate/research-$1.prompt.md"; LOG="$MAIN/logs/delegate/research-$1.log"
  rm -f "$MAIN/$OUT"
  cat > "$PROMPT" <<EOF
You are a research agent. Work read-only in $MAIN. Do not edit any repo file and
do not make a live model call. Read AGENTS.md first.

Question: $2

Answer with evidence: file:line for every claim, the commands you ran and their
output. Say what you could not check. Write the answer to $OUT (relative to the
checkout) with the edit tool. Shell output redirection (>) is denied.
EOF
  status=0
  run "$MAIN" "research $1" "$(config "$OUT")" "$PROMPT" "$LOG" || status=$?
  [ -f "$MAIN/$OUT" ] || die "no report written (exit $status); see $LOG"
  echo "report: $MAIN/$OUT"
  return "$status"
}

cmd=${1:-}; shift || true
case "$cmd" in
  review)
    [ $# -eq 3 ] || die "usage: review <pr> <worktree> \"<focus>\""
    do_review "$1" "$2" "$3"
    ;;
  research)
    [ $# -eq 2 ] || die "usage: research <name> \"<question>\""
    do_research "$1" "$2"
    ;;
  *) usage >&2; exit 1 ;;
esac
