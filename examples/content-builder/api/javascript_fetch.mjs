/**
 * Stream one turn against content-builder with fetch (no SDK).
 *
 *   node api/javascript_fetch.mjs
 *
 * Env: TRUEFORGE_URL, TRUEFORGE_TOKEN (optional), TRUEFORGE_AGENT, TRUEFORGE_PROMPT
 */
const baseUrl = (process.env.TRUEFORGE_URL ?? 'http://localhost:8790').replace(/\/+$/, '');
const token = process.env.TRUEFORGE_TOKEN;
const agentName = process.env.TRUEFORGE_AGENT ?? 'content-builder';
const prompt =
  process.env.TRUEFORGE_PROMPT ??
  'Write a 600-word article for engineering leaders on why agent harnesses matter in production. Research the topic first and cite sources.';

function headers() {
  const h = { 'content-type': 'application/json' };
  if (token) {
    h.authorization = `Bearer ${token}`;
  }
  return h;
}

async function apiRequest({ path, method = 'GET', body }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  }
  return response;
}

function parseSseChunk(buffer) {
  const events = [];
  const blocks = buffer.split('\n\n');
  const remainder = blocks.pop() ?? '';
  for (const block of blocks) {
    const dataLine = block
      .split('\n')
      .find(line => line.startsWith('data:'));
    if (!dataLine) {
      continue;
    }
    const payload = dataLine.slice('data:'.length).trim();
    if (payload) {
      events.push(JSON.parse(payload));
    }
  }
  return { events, remainder };
}

async function main() {
  const sessionResponse = await apiRequest({
    path: '/api/v1/sessions',
    method: 'POST',
    body: { agent: { name: agentName } },
  });
  const { data: session } = await sessionResponse.json();
  console.log(`session: ${session.id}`);

  const turnResponse = await apiRequest({
    path: `/api/v1/sessions/${encodeURIComponent(session.id)}/turns`,
    method: 'POST',
    body: {
      input: [{ type: 'user.message', content: prompt }],
    },
  });

  const reader = turnResponse.body?.getReader();
  if (!reader) {
    throw new Error('Turn response has no body stream');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.remainder;
    for (const event of parsed.events) {
      if (event.type === 'model.message.delta' && event.thread_id === 'main') {
        process.stdout.write(event.content ?? '');
      }
      if (event.type === 'turn.done') {
        console.log('\n\nstatus:', event.state?.status);
      }
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
