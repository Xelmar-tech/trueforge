# TrueForge Examples

Working agents you can install into a running TrueForge instance and try from the Agents Library, SDK, or HTTP API.

| Example                              | What it does                                                                          | Requirements                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Content Builder](./content-builder) | Research-driven content creator: sourced article, HTML preview, optional social posts | One model; Parallel web MCP and `web-artifacts-builder` skill installed automatically |

Start TrueForge:

```bash
npx @truefoundry/trueforge
```

Install an example from this repository:

```bash
pnpm example:install content-builder
```

Each example includes:

- `agent.json` — one model, one system prompt, one MCP, one skill
- `requires.json` — connectors, skills, and runtime capabilities
- `prompts.md` — realistic requests to try in the UI
- `README.md` — UI, SDK, and HTTP API access
- `api/` and `sdk/` — runnable clients (where applicable)

Examples install definitions into TrueForge; the harness executes them. They do not run a separate agent server.
