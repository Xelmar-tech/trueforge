# Automations build plan

Event-driven Automations in TrueForge, built as a sibling of Schedules. This file is
the durable checklist for the autonomous build. Tick items as their proof lands in
`EVIDENCE.md`. Human-only steps go to `NEEDS-YOU.md`. Deviations from the design
docs go to `DECISIONS.md`.

Base: upstream `truefoundry/trueforge` @ `4b1aa55`. Fork: `Xelmar-tech/trueforge`.
Branch: `feat/automations`.

## 0. Baseline

- [x] `pnpm install`, root gate (lint, typecheck, tests) green on the untouched fork
- [x] state docs committed

## 1. Event ingress

- [x] `event_source` + `event` tables (pg + sqlite migrations, schema types)
- [x] `schemas/event.ts`, `schemas/eventSource.ts`
- [x] `db/eventStore.ts`, `db/eventSourceStore.ts` + pg + sqlite implementations
- [x] `connectors/types.ts`, `connectors/github/` (HMAC verify with node:crypto, normalize)
- [x] `POST /api/v1/webhooks/:source_id` mounted before auth
- [x] `GET /api/v1/event-sources`, `POST /api/v1/event-sources/github/manifest`, public callback
- [x] `GET /api/v1/events` (ledger listing with filters, for the picker)
- [x] Settings → Event sources UI (manifest flow, health, delete)
- [x] Proof: real delivery → event row

## 2. Automations core

- [x] `automation` + `automation_run` tables (coalescing partial unique index)
- [x] `schemas/automation.ts` (typed `when` conditions, lane parts, mode)
- [x] `db/automationStore.ts` + pg + sqlite
- [x] CRUD + runs + replay API
- [x] SDK regen for automations
- [x] controller loops: `event-coalesce`, `automation-dispatch`, `run-finalize`
- [x] completion events emitted into the per-tenant internal `trueforge` source
- [x] GitHub actions for agents (acting as the App): built-in per-source MCP endpoint — see DECISIONS.md
- [x] Proof (unit): burst of 4 events → 1 run with 4 event ids; hand-off creates 1 session + 1 turn

## 3. UI

- [x] `automations` place / shell flag / nav slot
- [x] `AutomationsPage`, `AutomationFormDrawer`, condition builder, event picker (recent events of the kind)
- [x] `AutomationServer` port (defined in trueforge-ui `server/types.ts`, see DECISIONS) + adapter
- [x] Proof: Test/replay/arm from the UI, runs visible in the row (creation exercised through the API script; the drawer is covered by unit tests)

## 4. Shadow + replay

- [x] approval override for shadow runs
- [x] `POST /api/v1/automations/:id/replay`
- [x] `TestAutomationScreen` (replay + poll)
- [ ] session header strip for automation runs
- [x] Proof: replay → shadowed, would_have captured, nothing written

## 5. Dogfood

- [x] repo `Xelmar-tech/trueforge-automations-dogfood` with labels (issue types are org-level; `mission` label instead)
- [x] agents: foreman-planner, plan-reviewer, dashboard-scribe (instructions in `dogfood/`)
- [x] automations: plan-mission, review-plan, publish-dashboard
- [x] Proof: label → drafts published by the App → downstream runs

## 6. Deploy

- [x] Railway hosted mode (Postgres + Redis), public domain
- [x] GitHub App webhook pointed at it
- [x] Proof: step 5 ran against the deployment (only environment)
- [x] `HANDOFF.md`
