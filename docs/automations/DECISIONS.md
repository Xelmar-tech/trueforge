# Decisions

Deviations from the design documents, and choices the documents left open.

- **Model access.** The user's gateway (`https://llm-router.abuusama.dev/v1`) is registered
  as a TrueForge `custom` model provider through the settings API; the key is read from the
  `LLM_ROUTER_API_KEY` environment variable and never written to disk in this repo.
- **GitHub App auth.** `@octokit/app` and `@octokit/webhooks` instead of porting Foreman's
  hand-written JWT and HMAC code: less code, maintained upstream.
- **Sandbox.** No Daytona in v1. The planner publishes through the built-in GitHub source
  tools; the `review-plan` automation is the validation step.
