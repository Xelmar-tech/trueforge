# Content Builder

A simple **content creator** agent for learning TrueForge. It uses exactly one model, one system prompt, one MCP server, and one skill.

| Piece         | Name                                                  | Role                                                                          |
| ------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Model         | Your configured default (`$DEFAULT_MODEL` at install) | Writes and reasons                                                            |
| System prompt | `instructions` in `agent.json`                        | Research-first content workflow                                               |
| MCP           | `exa`                                                 | Web search via [Exa](https://exa.ai) (catalog connector; no API key required) |
| Skill         | `web-artifacts-builder`                               | Builds `article.md` and `preview.html` in the sandbox                         |

## Install

```bash
npx @truefoundry/trueforge
pnpm example:install content-builder
```

Needs a model under **Settings → Models**. Skills need a sandbox under **Settings → Sandbox providers** (Daytona). Override with `TRUEFORGE_URL`, `TRUEFORGE_TOKEN`, or `TRUEFORGE_MODEL` if needed.

## 1. UI

Open [http://localhost:8790](http://localhost:8790) → **Agents Library** → **content-builder** → **Try**.

Sample prompts: [prompts.md](./prompts.md).

When done, download from chat:

```text
output/
├── article.md
├── preview.html
└── social/          # when social content is requested
```

## 2. SDK

```bash
npm i @truefoundry/trueforge-sdk
```

```js
import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 600 });

const { data: session } = await client.sessions.create({ agent: { name: 'content-builder' } });

const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: 'Write a short blog post on agent harnesses. Research first.' }],
});

for await (const { data: event } of stream.withMetadata()) {
  if (event.type === 'model.message.delta') process.stdout.write(event.content ?? '');
}
```

## 3. HTTP API

Same flow for every client: create a session, then create a turn with `stream: false` and poll until it finishes.

### curl

```bash
# Create a session
SESSION=$(curl -s http://localhost:8790/api/v1/sessions \
  -H 'Content-Type: application/json' \
  -d '{"agent":{"name":"content-builder"}}' | jq -r .data.id)

# Start a turn (non-streaming)
TURN=$(curl -s "http://localhost:8790/api/v1/sessions/$SESSION/turns" \
  -H 'Content-Type: application/json' \
  -d '{"stream":false,"input":[{"type":"user.message","content":"Write a short blog post on agent harnesses. Research first."}]}' \
  | jq -r .data.id)

# Poll until done
curl -s "http://localhost:8790/api/v1/sessions/$SESSION/turns/$TURN" | jq .
```

### JavaScript (fetch)

```js
const base = 'http://localhost:8790';

const { data: session } = await fetch(`${base}/api/v1/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agent: { name: 'content-builder' } }),
}).then(r => r.json());

let { data: turn } = await fetch(`${base}/api/v1/sessions/${session.id}/turns`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    stream: false,
    input: [{ type: 'user.message', content: 'Write a short blog post on agent harnesses. Research first.' }],
  }),
}).then(r => r.json());

while (turn.state.status === 'running') {
  await new Promise(r => setTimeout(r, 1000));
  ({ data: turn } = await fetch(`${base}/api/v1/sessions/${session.id}/turns/${turn.id}`).then(r => r.json()));
}

console.log(turn.state.output?.content ?? turn.state);
```

### Python (requests)

```bash
pip install requests
```

```python
import time
import requests

base = "http://localhost:8790"

session = requests.post(f"{base}/api/v1/sessions", json={"agent": {"name": "content-builder"}}).json()["data"]

turn = requests.post(
    f"{base}/api/v1/sessions/{session['id']}/turns",
    json={
        "stream": False,
        "input": [{"type": "user.message", "content": "Write a short blog post on agent harnesses. Research first."}],
    },
).json()["data"]

while turn["state"]["status"] == "running":
    time.sleep(1)
    turn = requests.get(f"{base}/api/v1/sessions/{session['id']}/turns/{turn['id']}").json()["data"]

print(turn["state"].get("output", {}).get("content") or turn["state"])
```

When OIDC login is enabled, send `Authorization: Bearer <id_token>` on every request (SDK: pass `token`).

## Files

| File            | Purpose                                                 |
| --------------- | ------------------------------------------------------- |
| `agent.json`    | Agent definition (`$DEFAULT_MODEL` resolved at install) |
| `requires.json` | Exa MCP + skill + sandbox requirements                  |
| `prompts.md`    | Sample user requests                                    |

Credentials are never stored here — configure them in TrueForge Settings.
