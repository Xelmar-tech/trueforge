---
'@truefoundry/trueforge': minor
---

Add event sources and the event ledger, the first half of event-driven automations: a
GitHub App connects through the manifest flow (`POST /api/v1/event-sources/github/manifest`
plus the public callback), providers deliver to `POST /api/v1/webhooks/{source_id}`
(HMAC verified, idempotent per delivery id), and `GET /api/v1/events` lists what was
received without payloads. New `event_source` and `event` tables on both databases.
