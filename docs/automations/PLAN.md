# Automations build plan

Event-driven Automations in TrueForge, built as a sibling of Schedules. This file is
the durable checklist for the autonomous build. Tick items as their proof lands in
`EVIDENCE.md`. Human-only steps go to `NEEDS-YOU.md`. Deviations from the design
docs go to `DECISIONS.md`.

Base: upstream `truefoundry/trueforge` @ `4b1aa55`. Fork: `Xelmar-tech/trueforge`.
Branch: `feat/automations`.

## 0. Baseline

- [ ] `pnpm install`, root gate (lint, typecheck, tests) green on the untouched fork
- [ ] state docs committed

## 1. Event ingress

- [ ] `connector_source` + `event` tables (pg + sqlite migrations, schema types)
- [ ] `schemas/event.ts`, `schemas/source.ts`
- [ ] `db/eventStore.ts`, `db/sourceStore.ts` + pg + sqlite implementations
- [ ] `connectors/types.ts`, `connectors/github/` (verify via `@octokit/webhooks`, normalize)
- [ ] `POST /api/v1/webhooks/:source_id` mounted before auth
- [ ] `GET /api/v1/sources`, `POST /api/v1/sources/github/manifest`, `GET /api/v1/sources/github/callback`
- [ ] `GET /api/v1/events` (ledger listing with filters, for the picker)
- [ ] Settings → Event sources UI
- [ ] Proof: real delivery → event row

## 2. Automations core

- [ ] `automation` + `automation_run` tables (coalescing partial unique index)
- [ ] `schemas/automation.ts` (typed `when` AST, lane parts, mode)
- [ ] `db/automationStore.ts` + pg + sqlite
- [ ] CRUD API + SDK regen
- [ ] controller loops: `event-coalesce`, `automation-dispatch`, `run-finalize`
- [ ] built-in per-source GitHub MCP server (acts as the App)
- [ ] Proof: burst of 4 events → 1 run → 1 session with observation

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
