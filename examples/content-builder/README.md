# Content Builder

A simple **content creator** agent for learning TrueForge. It uses exactly one model, one system prompt, one MCP server, and one skill.

| Piece         | Name                                                  | Role                                                                                                                        |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Model         | Your configured default (`$DEFAULT_MODEL` at install) | Writes and reasons                                                                                                          |
| System prompt | `instructions` in `agent.json`                        | Research-first content workflow                                                                                             |
| MCP           | `parallel-web`                                        | Web search via [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) (free tier, no API key required) |
| Skill         | `web-artifacts-builder`                               | Builds `article.md` and `preview.html` in the sandbox                                                                       |

The agent researches a topic with Parallel web search, then uses the skill to produce downloadable Markdown and HTML in the sandbox.

## Prerequisites

- Node.js 22 or newer
- A running TrueForge instance with at least one model under **Settings → Models**

Parallel Search MCP is free without authentication. Optional: add a Parallel API key under **Settings → MCP Servers** for higher rate limits.

## Install the example

Start TrueForge:

```bash
npx @truefoundry/trueforge
```

From a clone of this repository, install the agent and its dependencies:

```bash
pnpm example:install content-builder
```

Override the server URL, token, or model when needed:

```bash
TRUEFORGE_URL=https://trueforge.example.com \
TRUEFORGE_TOKEN=your-id-token \
TRUEFORGE_MODEL=anthropic/claude-sonnet-4-6 \
pnpm example:install content-builder
```

## 1. Access via UI

Open [http://localhost:8790](http://localhost:8790), go to **Agents Library**, find **content-builder**, and click **Try**.

Try a prompt from [prompts.md](./prompts.md), for example:

> Write a 1,200-word article for engineering leaders explaining why agent harnesses matter once an AI agent moves from prototype to production. Research current sources, cite them, and produce a polished HTML preview.

When the turn completes, download files from the chat:

```text
output/
├── article.md
├── preview.html
└── social/          # when social content is requested
```

## 2. Access via SDK

Install the TypeScript SDK (skip if you are in the TrueForge monorepo and already built the SDK):

```bash
npm i @truefoundry/trueforge-sdk
```

Run the example script:

```bash
node sdk/run.mjs
```

The script opens a session on `content-builder`, streams one turn, and prints the assistant reply as it arrives. Set `TRUEFORGE_BASE_URL`, `TRUEFORGE_TOKEN`, `TRUEFORGE_AGENT`, or `TRUEFORGE_PROMPT` to customize.

Minimal inline version:

```typescript
import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({
  baseUrl: 'http://localhost:8790',
  timeoutInSeconds: 600,
});

const { data: session } = await client.sessions.create({ agent: { name: 'content-builder' } });

const stream = await client.sessions.createTurnStream(session.id, {
  input: [
    {
      type: 'user.message',
      content: 'Write a short blog post on agent harnesses for production. Research first.',
    },
  ],
});

for await (const { data: event } of stream.withMetadata()) {
  if (event.type === 'model.message.delta' && event.threadId === 'main') {
    process.stdout.write(event.content ?? '');
  }
}
```

See [SDK Quickstart](https://trueforge.dev/api/quickstart) and [Use an agent](https://trueforge.dev/api/use-agent) for sessions, approvals, and reconnects.

## 3. Access via HTTP API

All clients use the same two calls:

1. `POST /api/v1/sessions` with `{ "agent": { "name": "content-builder" } }`
2. `POST /api/v1/sessions/{session_id}/turns` with `{ "input": [{ "type": "user.message", "content": "..." }] }` — returns a Server-Sent Events stream of turn events

### curl

```bash
chmod +x api/curl.sh
./api/curl.sh
```

### JavaScript (fetch)

```bash
node api/javascript_fetch.mjs
```

### Python (requests)

```bash
pip install requests
python api/python_requests.py
```

When OIDC login is enabled, set `TRUEFORGE_TOKEN` to your ID token for all API and SDK examples.

## Files in this example

| File            | Purpose                                                 |
| --------------- | ------------------------------------------------------- |
| `agent.json`    | Agent definition (`$DEFAULT_MODEL` resolved at install) |
| `requires.json` | Parallel MCP + skill + sandbox requirements             |
| `prompts.md`    | Sample user requests                                    |
| `api/`          | curl, fetch, and Python HTTP examples                   |
| `sdk/run.mjs`   | TypeScript SDK example                                  |

Credentials are never stored in the example. Configure authenticated connectors in TrueForge Settings.
