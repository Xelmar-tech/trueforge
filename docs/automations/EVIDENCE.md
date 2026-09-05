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
- Real-delivery proof: pending (needs the GitHub App and a public URL — see step 6).
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
