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
