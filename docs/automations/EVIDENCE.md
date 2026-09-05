# Evidence

Observed proofs only. Every entry carries the command or action, the observed result, and
real identifiers (delivery ids, issue numbers, run ids, session ids). No credentials.

## 0. Baseline — 2026-09-05

- Fork `Xelmar-tech/trueforge` cloned at upstream `4b1aa554` ("[AuthZ: 3/N] enforce external
  authorizer on agent access (#586)"). Branch `feat/automations`.
- `pnpm install` — exit 0 (pnpm 11.16.0, node 24.20.0).
- `pnpm typecheck` — exit 0 on the untouched fork.
- `pnpm test` (core, ui, trueforge, frontend) — exit 0 on the untouched fork.

## 1. Event ingress — 2026-09-05

- `pnpm --filter @truefoundry/trueforge typecheck` — exit 0 after adding
  `event_source`/`event` tables, stores, connectors, routes.
- Unit tests `tests/unit/connectors/githubWebhook.test.ts`,
  `tests/unit/apis/{webhooks,eventSources,events}.test.ts` — 4 suites, 25 tests passed
  (in-memory SQLite, migrations applied through `migrateSqliteToLatest`).
- Real-delivery proof (against the Railway deployment, 2026-09-05): App `xelmar-foreman`
  (id 4841300, owner `Xelmar-tech`) created through the manifest flow from Settings → Event
  sources; source `01m1s0vyssqnnbqwkj27gkyfc1` went `active` (server log "GitHub event source
  activated"). Installing the App on `Xelmar-tech/trueforge-automations-dogfood`
  (installation 159295128) produced event `01m1s1cfcfc4qa9xhw7eyreh4y`
  (`installation.created`, delivery `97dc4ab0-a93a-11f1-8ba9-fa00252fb106`). Adding the
  `ready-for-planning` label to issue #1 produced event `01m1s1ervmw423k63d8r8ttsvk`
  (`issues.labeled`, subject `Xelmar-tech/trueforge-automations-dogfood#1`, delivery
  `c496a3c0-a93a-11f1-9c2d-ddd0d0f40c02`). Both read back from `GET /api/v1/events`.
- Agents-as-the-App tools: `tests/unit/connectors/{githubAppAuth,githubTools}.test.ts` and
  `tests/unit/apis/sourceTools.test.ts` (JWT verifies against the public key; installation
  token minted and cached; `create_issue` with a parent = 2 GitHub calls; endpoint 401s a
  wrong bearer, serves `initialize` and `tools/list` as JSON). Server suite after the change:
  60 suites, 489 tests passed.
- SDK regenerated from the OpenAPI document (`pnpm sdk:generate`, Fern via Docker): new
  `eventSources` and `events` resources; SDK vitest 68 files / 801 tests passed.

## 2. Automations core — 2026-09-05

- `pnpm --filter @truefoundry/trueforge typecheck` — exit 0 with `automation`/`automation_run`
  tables, stores, three control loops and the automations API.
- Full server unit suite (`jest --config jest.unit.config.cjs tests/unit`) — 57 suites,
  474 tests passed, including new `runtime/conditions`, `controller/eventCoalesce`,
  `controller/automationDispatch`, `controller/runFinalize`, `apis/automations`.
- Coalescing proof (unit, SQLite): 4 `issues.labeled` events for `o/r#61` plus one
  non-matching label and one other subject → exactly 2 runs, the `#61` run holding 4
  event ids with `scheduled_for` = last `now` + 30s; a second pass routes nothing.
- Shadow proof (unit): a shadow run whose turn pauses on `tool.approval_required` ends
  `shadowed` with the pending action in `outcome`; nothing is emitted.
- Emit proof (unit): a completed armed run writes `plan.published` into the tenant's
  internal `trueforge` source with the source event's summary and the run/session ids;
  a second finalize pass is a no-op.

## 6. Deploy — 2026-09-05

- Railway project `trueforge-automations` (`315b2031-eca5-4188-9e6c-a0e66d12a4a3`),
  environment `production`, applied from `.railway/railway.ts` (`railway config apply`):
  Postgres, Redis, `trueforge` (`26206730-430a-455e-a747-77d76ccdc075`) and
  `trueforge-controller` (`3943ad45-1030-4930-bb48-64f7c040efa5`), built from
  `Xelmar-tech/trueforge@feat/automations` with `Dockerfile.dev`.
- First deployment `94a75116-0788-4e13-9f7a-acf71d1e3c70` (commit `f8be9afa`) — `SUCCESS`.
  `GET /healthz` → `{"status":"ok","version":"0.2.0-rc.0"}`; `GET /api/v1/event-sources`
  and `GET /api/v1/automations` → 200 (migrations applied on Railway Postgres).
- Controller deployment `c3838bbe-c85a-4d16-aadf-e9897d49d382` logs "Controller started" with
  loops `schedule-dispatch, event-coalesce, automation-dispatch, run-finalize`. Its
  `SERVER_URL` first expanded to `http://trueforge.railway.internal:` (empty port); fixed to
  the public domain (see DECISIONS) and re-applied.
- Public URL: `https://trueforge-production-5b64.up.railway.app` (auth off — see NEEDS-YOU).
- Model access: `POST /api/v1/settings/model-providers` → 201 for the `custom` provider
  `llm-router` (`https://llm-router.abuusama.dev/v1`, key from `LLM_ROUTER_API_KEY`, never
  printed); `GET /api/v1/models` lists `llm-router/{gpt-5.6-sol, gpt-5.5, gpt-5.3-codex-spark,
claude-opus-5, claude-opus-4-8, claude-sonnet-5}`.
