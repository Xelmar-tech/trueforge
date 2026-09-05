#!/usr/bin/env bash
# Applies the dogfood agents and automations to a TrueForge deployment. Idempotent: agents are
# created or replaced (PUT), automations are created once (existing ones are left alone).
#
#   BASE_URL=https://trueforge-production-5b64.up.railway.app \
#   SOURCE_ID=01m1s0vyssqnnbqwkj27gkyfc1 CONNECTOR=xelmar-foreman MODEL=llm-router/gpt-5.5 \
#   docs/automations/dogfood/apply.sh
set -euo pipefail

: "${BASE_URL:?public URL of the deployment}"
: "${SOURCE_ID:?GitHub event source id}"
: "${CONNECTOR:?MCP connector name of the source (Settings, Connectors)}"
MODEL="${MODEL:-llm-router/gpt-5.5}"
MODE="${MODE:-shadow}"
HERE="$(cd "$(dirname "$0")" && pwd)"

agent() { # name instructions-file
  local name="$1" file="$2" body
  body="$(node -e '
    const [name, file, connector, model] = process.argv.slice(1);
    const instructions = require("fs").readFileSync(file, "utf8");
    process.stdout.write(JSON.stringify({ name, manifest: {
      model: { name: model },
      instructions,
      mcp_servers: [{ name: connector, require_approval_for_tools: [] }],
    }}));' "$name" "$file" "$CONNECTOR" "$MODEL")"
  local status
  status="$(curl -s -o /tmp/tf-agent.json -w '%{http_code}' -X POST -H 'content-type: application/json' \
    --data-binary "$body" "$BASE_URL/api/v1/agents")"
  if [ "$status" = "409" ]; then
    status="$(curl -s -o /tmp/tf-agent.json -w '%{http_code}' -X PUT -H 'content-type: application/json' \
      --data-binary "$(node -e 'const b=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({manifest:b.manifest}))' "$body")" \
      "$BASE_URL/api/v1/agents/$name")"
  fi
  echo "agent $name -> $status"
  [ "$status" = "201" ] || [ "$status" = "200" ] || { cat /tmp/tf-agent.json; exit 1; }
}

automation() { # json
  local status
  status="$(curl -s -o /tmp/tf-automation.json -w '%{http_code}' -X POST -H 'content-type: application/json' \
    --data-binary "$1" "$BASE_URL/api/v1/automations")"
  echo "automation $(node -e 'console.log(JSON.parse(process.argv[1]).name)' "$1") -> $status"
  [ "$status" = "201" ] || [ "$status" = "409" ] || { cat /tmp/tf-automation.json; exit 1; }
}

agent foreman-planner "$HERE/foreman-planner.md"
agent plan-reviewer "$HERE/plan-reviewer.md"
agent dashboard-scribe "$HERE/dashboard-scribe.md"

INTERNAL_SOURCE_ID="$(curl -s "$BASE_URL/api/v1/event-sources" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const s=JSON.parse(d).data.find(x=>x.kind==="trueforge"); process.stdout.write(s?s.id:"");});')"
if [ -z "$INTERNAL_SOURCE_ID" ]; then
  echo "internal 'trueforge' source not created yet (it appears after the first armed run emits); skipping downstream automations"
fi

automation "$(node -e '
  const [sourceId, mode] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ name: "plan-mission", agent_name: "foreman-planner", manifest: {
    trigger: { type: "event", source_id: sourceId, kind: "issues.labeled",
      when: { all: [{ field: "label.name", op: "eq", value: "ready-for-planning" }] } },
    coalesce_seconds: 30,
    lane: [{ type: "field", path: "repository.full_name" }, { type: "literal", value: "planning" }],
    task: "Plan the Mission named in the events below and publish its draft sub-issues.",
    emit: ["plan.published"],
    mode, status: "active" }}));' "$SOURCE_ID" "$MODE")"

if [ -n "$INTERNAL_SOURCE_ID" ]; then
  automation "$(node -e '
    const [sourceId, mode] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ name: "review-plan", agent_name: "plan-reviewer", manifest: {
      trigger: { type: "event", source_id: sourceId, kind: "plan.published" },
      coalesce_seconds: 10,
      lane: [{ type: "field", path: "source_summary.repository" }, { type: "literal", value: "review" }],
      task: "Review the plan published for the Mission named in the events below.",
      emit: ["plan.reviewed"],
      mode, status: "active" }}));' "$INTERNAL_SOURCE_ID" "$MODE")"
  automation "$(node -e '
    const [sourceId, mode] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ name: "publish-dashboard", agent_name: "dashboard-scribe", manifest: {
      trigger: { type: "event", source_id: sourceId, kind: "plan.published" },
      coalesce_seconds: 10,
      lane: [{ type: "field", path: "source_summary.repository" }, { type: "literal", value: "dashboard" }],
      task: "Publish the dashboard for the Mission named in the events below.",
      emit: [],
      mode, status: "active" }}));' "$INTERNAL_SOURCE_ID" "$MODE")"
fi
