/**
 * Stream one turn against content-builder with @truefoundry/trueforge-sdk.
 *
 *   npm i @truefoundry/trueforge-sdk
 *   node sdk/run.mjs
 *
 * From this monorepo (after pnpm --filter @truefoundry/trueforge-sdk build):
 *   node examples/content-builder/sdk/run.mjs
 *
 * Env: TRUEFORGE_BASE_URL or TRUEFORGE_URL, TRUEFORGE_TOKEN (optional), TRUEFORGE_AGENT, TRUEFORGE_PROMPT
 */
async function loadSdk() {
  try {
    return await import('@truefoundry/trueforge-sdk');
  } catch {
    return await import(
      new URL('../../../packages/trueforge-sdk/dist/esm/index.mjs', import.meta.url).href
    );
  }
}

const { TrueForge } = await loadSdk();

const baseUrl = (
  process.env.TRUEFORGE_BASE_URL ??
  process.env.TRUEFORGE_URL ??
  'http://localhost:8790'
).replace(/\/+$/, '');
const token = process.env.TRUEFORGE_TOKEN;
const agentName = process.env.TRUEFORGE_AGENT ?? 'content-builder';
const prompt =
  process.env.TRUEFORGE_PROMPT ??
  'Write a 600-word article for engineering leaders on why agent harnesses matter in production. Research the topic first and cite sources.';

const client = new TrueForge({
  baseUrl,
  ...(token ? { token } : {}),
  timeoutInSeconds: 600,
});

const { data: session } = await client.sessions.create({ agent: { name: agentName } });
console.log(`session: ${session.id}`);

const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: prompt }],
});

for await (const { data: event } of stream.withMetadata()) {
  if (event.type === 'model.message.delta' && event.threadId === 'main') {
    process.stdout.write(event.content ?? '');
  }
  if (event.type === 'turn.done') {
    console.log('\n\nstatus:', event.state.status);
  }
}
