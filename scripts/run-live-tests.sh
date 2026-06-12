#!/usr/bin/env bash
#
# Run the live OpenRouter integration tests.
#
# Loads an OpenRouter API key from an .env file (so the key never has to be
# pasted on the command line or committed), then runs `npm run test:live`.
# The key is exported into the test process only and is never printed.
#
# Usage:
#   ENV_FILE=/path/to/.env scripts/run-live-tests.sh
#   OPENROUTER_TEST_MODEL=deepseek/deepseek-v4-flash scripts/run-live-tests.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/../evals/skill-eval/.env}"
export OPENROUTER_TEST_MODEL="${OPENROUTER_TEST_MODEL:-deepseek/deepseek-v4-flash}"

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "error: env file not found at $ENV_FILE (set ENV_FILE or OPENROUTER_API_KEY)" >&2
    exit 1
  fi
  # Prefer a clearly named key, then fall back to any sk-or- value in the file.
  line="$(grep -aE '^[[:space:]]*(export[[:space:]]+)?(OPENROUTER_API_KEY|OPENROUTER_KEY|OPENROUTER_TOKEN)=' "$ENV_FILE" | head -n1 || true)"
  if [[ -z "$line" ]]; then
    line="$(grep -aE 'sk-or-' "$ENV_FILE" | head -n1 || true)"
  fi
  if [[ -z "$line" ]]; then
    echo "error: no OpenRouter key found in $ENV_FILE" >&2
    exit 1
  fi
  value="${line#*=}"
  # Strip optional surrounding quotes and whitespace.
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  export OPENROUTER_API_KEY="$value"
fi

if [[ "${OPENROUTER_API_KEY:-}" != sk-or-* ]]; then
  echo "error: loaded key does not look like an OpenRouter key (expected sk-or- prefix)" >&2
  exit 1
fi

echo "Running live tests against model: $OPENROUTER_TEST_MODEL"
echo "Key loaded: sk-or-…${OPENROUTER_API_KEY: -4} (length ${#OPENROUTER_API_KEY})"
cd "$ROOT"
exec npm run test:live
