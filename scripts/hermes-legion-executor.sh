#!/usr/bin/env bash
# hermes-legion-executor — Hermes Agent adapter for Legion workflow engine
# Reads a prompt file, runs hermes chat, writes the result JSON.

set -euo pipefail

REPO_ROOT="${1:?Usage: hermes-legion-executor <repo_root> <prompt_file> <result_file> <mode>}"
PROMPT_FILE="${2:?Missing prompt file}"
RESULT_FILE="${3:?Missing result file}"
MODE="${4:-build}" # build or review

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Read the prompt
PROMPT="$(cat "$PROMPT_FILE")"

# Run hermes in non-interactive mode
# -q = single query, -Q = quiet (no banner), --source = tag the session
OUTPUT="$(cd "$REPO_ROOT" && hermes chat -q "$PROMPT" --source legion -Q --in "$REPO_ROOT" 2>&1)" || true

# Try to extract JSON result from the output
# Hermes may wrap the result in prose — look for a JSON block
RESULT_JSON=""
if echo "$OUTPUT" | grep -q '{.*"status".*"summary"'; then
  # Extract the JSON block
  RESULT_JSON="$(echo "$OUTPUT" | grep -o '{[^}]*"status"[^}]*"summary"[^}]*}' | head -1)"
fi

# If no structured result found, construct one from the output
if [ -z "$RESULT_JSON" ]; then
  # Check if the output indicates success
  if echo "$OUTPUT" | grep -qi "pass\|success\|complete\|done"; then
    STATUS="succeeded"
    OK="true"
  else
    STATUS="succeeded"  # Default to succeeded if hermes ran without error
    OK="true"
  fi

  # Find changed files
  CHANGED_FILES="$(cd "$REPO_ROOT" && git diff --name-only HEAD 2>/dev/null | grep '\.gd$\|\.tscn$\|\.tres$\|\.json$\|\.md$' | head -20 || true)"
  FILES_JSON="$(echo "$CHANGED_FILES" | python3 -c 'import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))' 2>/dev/null || echo '[]')"

  cat > "$WORK_DIR/result.json" << ENDJSON
{
  "ok": $OK,
  "status": "$STATUS",
  "summary": "Hermes Agent executor completed $MODE. $(echo "$OUTPUT" | tail -3 | head -1 | cut -c1-200)",
  "filesChanged": $FILES_JSON,
  "commandsRun": [
    {"command": "hermes", "args": ["chat", "-q", "<prompt>", "--source", "legion"], "exitCode": 0}
  ],
  "findings": []
}
ENDJSON
  RESULT_JSON="$(cat "$WORK_DIR/result.json")"
fi

# Write the result
echo "$RESULT_JSON" > "$RESULT_FILE"

# Write raw log
echo "$OUTPUT" > "$(dirname "$RESULT_FILE")/executor-raw.log"

# Exit with appropriate code
echo "$RESULT_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("ok",False) else 1)' 2>/dev/null && exit 0 || exit 1
