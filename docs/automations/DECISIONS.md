# Decisions

Deviations from the design documents, and choices the documents left open.

- **Model access.** The user's gateway (`https://llm-router.abuusama.dev/v1`) is registered
  as a TrueForge `custom` model provider through the settings API; the key is read from the
  `LLM_ROUTER_API_KEY` environment variable and never written to disk in this repo.
- **GitHub App auth.** `node:crypto` for both the webhook HMAC and the App JWT
  (`connectors/github/appAuth.ts`): the octokit packages are ESM-only and break the Jest
  (CJS) suite, and the whole flow is one signature plus two REST calls. `@octokit/app` was
  removed; `@octokit/webhooks-types` stays for payload types.
- **Agents act as the App through a built-in MCP endpoint.** Each active GitHub source serves
  `POST /api/v1/event-sources/{source_id}/mcp` (stateless streamable HTTP, JSON responses).
  Its tools call GitHub with an installation token minted from the stored private key; the
  bearer token the core presents is `HMAC(webhook_secret, "source-tools:" + source_id)`, so
  nothing new is stored. The manifest callback upserts an MCP connector named after the
  source with that header; `POST /event-sources/{id}/connector` re-registers it. No PAT, no
  human identity, no third-party MCP server.
- **Controller reaches the API over the public edge on Railway.** `${{trueforge.PORT}}`
  expands to an empty string (PORT is injected at runtime, not a service variable) and the
  image binds `0.0.0.0` while Railway's private network is IPv6-only. `SERVER_URL` is the
  public domain until the image binds `::`.
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
- **Deleting a source leaves its connector row.** The connector stops working (401 from the
  endpoint once the source is gone) but is not removed; the Connectors tab shows it and a
  human deletes it. Cascading the delete is a later change.
