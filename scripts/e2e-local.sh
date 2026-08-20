#!/usr/bin/env bash
# Local e2e runner: sources .env then dispatches a single spec/preset.
# Usage:
#   scripts/e2e-local.sh regression                    # beautifului polish regression
#   scripts/e2e-local.sh mobile                        # mobile-viewport e2e
#   scripts/e2e-local.sh smoke                         # smoke spec
#   scripts/e2e-local.sh audit [sidebar|fullscreen|mobile]  # design-audit screenshots
#   scripts/e2e-local.sh test/e2e/specs/<file>.e2e.ts  # any spec
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [ -f .env ]; then set -a; source .env; set +a; fi

SPEC="${1:-}"
MODE="${2:-}"
case "$SPEC" in
  mobile)
    exec npm run test:e2e:mobile
    ;;
  regression)
    exec npm run test:e2e -- --spec test/e2e/specs/beautifului-polish.e2e.ts
    ;;
  smoke)
    exec npm run test:e2e -- --spec test/e2e/specs/smoke.e2e.ts
    ;;
  audit)
    export AGENTIC_CHAT_DESIGN_AUDIT=1
    if [ -n "$MODE" ]; then export AGENTIC_CHAT_DESIGN_AUDIT_MODE="$MODE"; fi
    exec npm run test:e2e -- --spec test/e2e/specs/design-audit.e2e.ts
    ;;
  "")
    echo "usage: e2e-local.sh <regression|mobile|smoke|audit [mode]|spec-path>" >&2
    exit 2
    ;;
  *)
    exec npm run test:e2e -- --spec "$SPEC"
    ;;
esac
