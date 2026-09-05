# Handoff — event-driven Automations in the TrueForge fork

State of the build on 2026-09-05. Read this first; `PLAN.md`, `EVIDENCE.md`, `DECISIONS.md`
and `NEEDS-YOU.md` hold the detail.

## What exists

- **Fork** `Xelmar-tech/trueforge`, branch `feat/automations`, on top of upstream `4b1aa55`.
  New code lives beside Schedules: `packages/trueforge/src/{connectors,controller,apis,routes,
schemas,db}` (event sources, event ledger, automations, runs, source tools) and
  `packages/trueforge-ui/src/atoms/automations` (Automations page, form drawer with typed
  conditions, Test screen) plus Settings → Event sources.
- **Deployment** on Railway (`.railway/railway.ts`): Postgres, Redis, `trueforge` (API + UI),
  `trueforge-controller` (the four control loops). Public URL
  `https://trueforge-production-5b64.up.railway.app`. Both services auto-deploy from the branch.
  **Authentication is off**: anyone with the URL is an admin. Do not share it; enable OIDC
  before anyone else touches it (commented block in `.railway/railway.ts`).
- **GitHub App** `xelmar-foreman` (owner `Xelmar-tech`), created by the manifest flow, installed
  on `Xelmar-tech/trueforge-automations-dogfood`. Event source `01m1s0vyssqnnbqwkj27gkyfc1`.
  Its credentials live only in the deployment's Postgres (`event_source.secrets`).
- **Agents act as the App** through the built-in per-source MCP endpoint
  (`POST /api/v1/event-sources/{id}/mcp`), registered as the connector `xelmar-foreman`. No
  personal token anywhere.
- **Model access**: provider `llm-router` (the user's LiteLLM gateway). Dogfood agents use
  `llm-router/gpt-5.5`; `gpt-5.6-sol`, `gpt-5.3-codex-spark`, `claude-opus-5`, `claude-opus-4-8`
  and `claude-sonnet-5` are registered too.
- **Dogfood** agents `foreman-planner`, `plan-reviewer`, `dashboard-scribe` and automations
  `plan-mission` (issues.labeled where `label.name` is `ready-for-planning` → emits
  `plan.published`), `review-plan` and `publish-dashboard` (both on `plan.published`).
  Recreate them with `docs/automations/dogfood/apply.sh`.

## How to operate it

- Label a Mission issue in the dogfood repo `ready-for-planning`. Within the coalesce window
  (30 s) the controller opens a run; the planner publishes draft sub-issues as the App and
  comments on the Mission; `plan.published` wakes the reviewer and the scribe.
- Automations page: create/edit with typed conditions; **Test** replays a recorded event in
  shadow mode and shows what the agent would have done; **Arm** switches to live.
- Every run has a session; open it from the run chip. The run's `outcome` holds the pending
  tool calls (shadow) or the emitted event ids (armed).
- Settings → Event sources: the App, its webhook URL and last delivery. Settings → Connectors:
  the per-source tools connector.

## Known gaps (v1)

- No sandboxed coding runner, merge lane, Notion source or builder agent.
- A deleted source leaves its connector row behind.
- The session header strip for automation runs is not built; the run chip links to the session.
- The dashboard scribe posts one comment; refreshing an existing dashboard comment is a later
  version (needs an `update_comment` tool).
- The controller reaches the API over the public edge on Railway (see DECISIONS).

## Where to continue

`PLAN.md` step 5 proofs and the gaps above. Keep changes rebase-able: new files, minimal touch
points in `app.ts`, `main.ts`, `controller.ts`, UI slots.
