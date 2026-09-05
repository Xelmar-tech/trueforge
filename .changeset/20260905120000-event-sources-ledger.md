---
'@truefoundry/trueforge': minor
---

Add event sources and the event ledger, the first half of event-driven automations: a
GitHub App connects through the manifest flow (`POST /api/v1/event-sources/github/manifest`
plus the public callback), providers deliver to `POST /api/v1/webhooks/{source_id}`
(HMAC verified, idempotent per delivery id), and `GET /api/v1/events` lists what was
received without payloads. New `event_source` and `event` tables on both databases.

Add event-driven automations (`/api/v1/automations`): an agent bound to an event trigger with
typed conditions, a sliding coalesce window per subject enforced by a partial unique index,
serial lanes, shadow mode (every MCP tool gated for approval so the first write is the
recorded "would have done"), replay of a recorded event, and completion events emitted into a
per-tenant internal `trueforge` source. Three new controller loops: `event-coalesce`,
`automation-dispatch`, `run-finalize`. New `automation` and `automation_run` tables.
