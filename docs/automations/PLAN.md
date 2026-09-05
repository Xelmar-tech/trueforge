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
- [ ] Settings → Event sources UI
- [ ] Proof: real delivery → event row

## 2. Automations core

- [x] `automation` + `automation_run` tables (coalescing partial unique index)
- [x] `schemas/automation.ts` (typed `when` conditions, lane parts, mode)
- [x] `db/automationStore.ts` + pg + sqlite
- [x] CRUD + runs + replay API
- [ ] SDK regen for automations
- [x] controller loops: `event-coalesce`, `automation-dispatch`, `run-finalize`
- [x] completion events emitted into the per-tenant internal `trueforge` source
- [ ] GitHub actions for agents (acting as the App) — see DECISIONS.md
- [x] Proof (unit): burst of 4 events → 1 run with 4 event ids; hand-off creates 1 session + 1 turn

## 3. UI

- [ ] `automations` place / shell flag / nav slot
- [ ] `AutomationsPage`, `AutomationFormDrawer`, condition builder, `EventPicker`
- [ ] `AutomationServer` port (assistant-ui-runtime fork) + adapter
- [ ] Proof: create from UI, see run

## 4. Shadow + replay

- [ ] approval override for shadow runs
- [ ] `POST /api/v1/automations/:id/replay`
- [ ] `ReplayPanel`, session header strip
- [ ] Proof: replay → shadowed, would_have captured, nothing written

## 5. Dogfood

- [ ] repo `Xelmar-tech/trueforge-automations-dogfood` with labels + Mission issue type
- [ ] agents + skills: foreman-planner, plan-reviewer, dashboard-scribe
- [ ] automations: plan-mission, review-plan, publish-dashboard
- [ ] Proof: label → drafts published by the App → downstream runs

## 6. Deploy

- [ ] Railway hosted mode (Postgres + Redis), public domain
- [ ] GitHub App webhook pointed at it
- [ ] Proof: step 5 repeated against the deployment
- [ ] `HANDOFF.md`
