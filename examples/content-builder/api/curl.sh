#!/usr/bin/env bash
# Stream one turn against the content-builder agent using curl.
# Prerequisites: content-builder installed (pnpm example:install content-builder).
set -euo pipefail

BASE_URL="${TRUEFORGE_URL:-http://localhost:8790}"
TOKEN="${TRUEFORGE_TOKEN:-}"
AGENT_NAME="${TRUEFORGE_AGENT:-content-builder}"
PROMPT="${TRUEFORGE_PROMPT:-Write a 600-word article for engineering leaders on why agent harnesses matter in production. Research the topic first and cite sources.}"

auth_args=()
if [[ -n "$TOKEN" ]]; then
  auth_args+=(-H "Authorization: Bearer ${TOKEN}")
fi

session_json=$(curl -sS "${auth_args[@]}" \
  -X POST "${BASE_URL}/api/v1/sessions" \
  -H 'Content-Type: application/json' \
  -d "{\"agent\":{\"name\":\"${AGENT_NAME}\"}}")

session_id=$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.data.id)' "$session_json")
echo "session: ${session_id}"

turn_body=$(node -e 'const prompt=process.argv[1]; process.stdout.write(JSON.stringify({input:[{type:"user.message",content:prompt}]}))' "$PROMPT")

curl -sS -N "${auth_args[@]}" \
  -X POST "${BASE_URL}/api/v1/sessions/${session_id}/turns" \
  -H 'Content-Type: application/json' \
  -d "${turn_body}"
