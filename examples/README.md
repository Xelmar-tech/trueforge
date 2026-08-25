# TrueForge Examples

Working agents you can install into a running TrueForge instance and try from the Agents Library, SDK, or HTTP API.

| Example                              | What it does                                                                          | Requirements                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Content Builder](./content-builder) | Research-driven content creator: sourced article, HTML preview, optional social posts | One model; Exa MCP and `web-artifacts-builder` skill installed automatically |

```bash
npx @truefoundry/trueforge
pnpm example:install content-builder
```

Each example includes:

- `agent.json` — one model, one system prompt, one MCP, one skill
- `requires.json` — connectors, skills, and runtime capabilities
- `prompts.md` — sample requests for the UI
- `README.md` — UI, SDK, and HTTP API snippets

Examples install definitions into TrueForge; the harness runs them.
