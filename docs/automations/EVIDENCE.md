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

## 4. Shadow + replay — 2026-09-05 (against the Railway deployment)

- `POST /api/v1/automations/01m1s1vsy420fnm6y72dnqt1fa/replay` with event
  `01m1s1ervmw423k63d8r8ttsvk` → 201, run `01m1s248hzbdkj2168rcm60avk` (subject
  `Xelmar-tech/trueforge-automations-dogfood#1~replay:01m1s1ervmw423k63d8r8ttsvk`, lane
  `Xelmar-tech/trueforge-automations-dogfood/planning`, mode `shadow`).
- The dispatcher created session `01m1s2491jj2h77fq1bjw1xj9h` with the inline shadow spec
  (`llm-router/gpt-5.5`, connector `xelmar-foreman` with every tool behind approval). Turn
  `01m1s2493s0f0mhkn2vswt1f89.fg9ztq` listed the eight tools, read their schemas, then paused
  (`tool.approval_required`, action `01m1s24n5109d46t9g3sdbv4bg`) on
  `get_issue(Xelmar-tech/trueforge-automations-dogfood, 1)` and
  `list_sub_issues(Xelmar-tech/trueforge-automations-dogfood, 1)`. Nothing was written to GitHub
  (issue #1 unchanged). 16,828 tokens.
- Two defects found and fixed by this run: the first attempt failed with "Agent not found:
  foreman-planner" (agents are addressed by id; commit `7b8b43ee` resolves by name), and the run
  then stayed `triggered` because the finalize loop asked `listTurns` for 50 turns while the API
  caps `limit` at 25 (commit `1adba898`).

- From the UI (deployed bundle `index-BpwsJyle.js`): Automations → **Test plan-mission** opened
  the Test screen; the picker offered the recorded event "Sep 5, 3:02 PM · #1 · Mission: smoke
  test…"; **Replay in shadow** produced run `01m1s331qbd0jc0rsx2xt2aana` shown as
  "Shadowed · 14s", session `01m1s332afc5emttsdy0achsz9`, outcome "Paused before
  tool.approval_required", with an **Open session** link. **Arm automation** switched the row's
  badge to Armed (manifest `mode: armed`).

## 5. Dogfood — 2026-09-05 (live, against the Railway deployment)

- Setup: `docs/automations/dogfood/apply.sh` → agents `foreman-planner`, `plan-reviewer`,
  `dashboard-scribe` (201 each; model `llm-router/gpt-5.5`; connector `xelmar-foreman`) and
  automations `plan-mission` `01m1s1vsy420fnm6y72dnqt1fa`, `review-plan`
  `01m1s1vtn8qa73yanqznes6jy2`, `publish-dashboard` `01m1s1vve08cwywf471vpt7ydj` (201 each).
- Trigger: `ready-for-planning` removed and re-added on issue #1 at 15:32:13 UTC → events
  `01m1s35nbp71j3jdcrx68y551b` (`issues.unlabeled`) and `01m1s35tnmbm76fsd0dvwncpbg`
  (`issues.labeled`, delivery `f7e65550-a93e-11f1-8d70-95f085287b82`). Only the labeled event
  matched the typed condition.
- Run `01m1s35z044b2m218qgnkpvngy` (armed): `coalescing` for the 30 s window, `triggered` at
  15:32:56 with session `01m1s36wccnnjja3eqe962faah`, `completed` at 15:33:50. The planner
  called `get_issue`, `list_sub_issues`, `list_comments`, `create_issue` ×2, `create_comment`
  (53,104 tokens).
- GitHub, all authored by `app/xelmar-foreman`: issues #2 "Create the CONTRIBUTING.md
  foundation" and #3 "Add the contribution review checklist" (labels `ticket`, `draft`), both
  attached as sub-issues of #1 (`GET /repos/.../issues/1/sub_issues` lists #2, #3), and one
  comment on #1 ("Published draft sub-issues: …"). No human account acted.
- The App's own writes came back through the webhook as events (`issues.opened`/`labeled` for
  #2 and #3, `issue_comment.created` on #1) — the ledger sees what the agents do.
- Completion emitted `plan.published` `01m1s38hzdr1hs8ak5hg79zyeq` into the internal
  `trueforge` source (delivery `01m1s35z044b2m218qgnkpvngy:plan.published`), which woke both
  downstream automations: `review-plan` run `01m1s38j107ygkj75wzqd49ay8` (lane
  `…/review`, session `01m1s38vw23erbdsw7baqkyxt7`) and `publish-dashboard` run
  `01m1s38j15kec2c5xjd6b2qexk` (lane `…/dashboard`, session `01m1s38w4jwt58cd5t4vj28c3b`),
  both `shadowed` (paused before their first tool call) within 45 s.

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
