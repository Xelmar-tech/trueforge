# Decisions

Deviations from the design documents, and choices the documents left open.

- **Model access.** The user's gateway (`https://llm-router.abuusama.dev/v1`) is registered
  as a TrueForge `custom` model provider through the settings API; the key is read from the
  `LLM_ROUTER_API_KEY` environment variable and never written to disk in this repo.
- **GitHub App auth.** `@octokit/app` and `@octokit/webhooks` instead of porting Foreman's
  hand-written JWT and HMAC code: less code, maintained upstream.
- **Sandbox.** No Daytona in v1. The planner publishes through GitHub tools; the
  `review-plan` automation is the validation step.
- **No `@octokit/webhooks-methods`.** The package is ESM-only and Jest could not resolve it;
  HMAC-SHA256 verification is eleven lines of `node:crypto` (`connectors/github/webhook.ts`).
- **Observation = the coalesced events.** The design doc's "observe at wake time" is v1'd as
  the full webhook payloads of every coalesced event, appended to the agent's first message
  inside an `<events>` block. GitHub's `issues.*` payloads already carry the issue body,
  labels and repository, which is what the planner needs. A connector `observe()` that reads
  the API at wake time is a later addition to `connectors/types.ts`.
- **Shadow mode.** The dispatcher creates the session with an inline copy of the agent spec
  whose every MCP server has `require_approval_for_tools: ['@all']`. The turn pauses on
  `tool.approval_required`; the finalize loop records those pending actions as the run's
  `outcome` and marks it `shadowed`. No new runtime feature.
- **Latest turn.** `listTurns` gives no order guarantee the loop can rely on, so the
  finalize loop scans up to 50 turns and takes the newest `createdAt`.
- **Replay subject.** A replay run's subject is `<subject>~replay:<event_id>` so it can
  never collide with a live coalesce window for the same subject.
- **UI port types.** `AutomationServer` and its DTOs are declared in
  `packages/trueforge-ui/src/server/types.ts` under a "fork addition" banner instead of the
  sibling `assistant-ui-runtime` package. Hosts still import from one module; moving the
  declarations upstream is a copy. `ServerContext` widens `AgentUIServer` with the optional
  port (`UiServer`) so the runtime type is untouched.
- **Event picker scope.** The drawer's picker lists the latest 25 recorded events of the
  chosen kind; conditions are applied server-side when a run starts, not client-side in the
  picker (listing rows carry no payload).
- **Agents acting as the App.** Deferred to step 5: the dogfood agents will use a GitHub MCP
  server configured in TrueForge Settings → Connectors. A built-in per-source MCP server that
  mints installation tokens is the follow-up once the flow is proven end to end.
