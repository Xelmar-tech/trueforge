import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { createSourceToolsRouter } from '../../../src/apis/sourceTools';
import { sourceToolToken } from '../../../src/connectors/github/tools';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteEventSourceStore } from '../../../src/db/sqlite/event-source-store/SqliteEventSourceStore';

const SUBJECT = { subject_id: 'root', subject_type: 'user' as const, subject_display_name: 'root' };

const JsonRpcResultSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.number(), result: z.unknown() });

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const eventSourceStore = new SqliteEventSourceStore(db);
  const pending = await eventSourceStore.createPendingGithubSource({
    tenant_id: 'default',
    name: 'xelmar-foreman',
    manifest_state: 'state-1',
    created_by_subject: SUBJECT,
  });
  await eventSourceStore.activateGithubSource({
    tenant_id: 'default',
    id: pending.id,
    app: {
      app_id: 4242,
      app_slug: 'xelmar-foreman',
      client_id: 'Iv1.abc',
      html_url: 'https://github.com/apps/xelmar-foreman',
      owner: 'Xelmar-tech',
    },
    secrets: { private_key: 'unused-in-this-test', webhook_secret: 'shh-hook', client_secret: 'shh-client' },
  });

  const app = new OpenAPIHono();
  app.route(
    '/',
    createSourceToolsRouter({
      eventSourceStore,
      logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as never,
      fetchImpl: async () => new Response('unexpected', { status: 500 }),
    }),
  );
  return { app, sourceId: pending.id, token: sourceToolToken({ sourceId: pending.id, webhookSecret: 'shh-hook' }) };
}

function rpc(app: OpenAPIHono, sourceId: string, token: string | null, body: unknown) {
  return app.request(`/${sourceId}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

describe('source tools endpoint', () => {
  test('rejects a missing or wrong bearer token', async () => {
    const { app, sourceId, token } = await setup();
    expect((await rpc(app, sourceId, null, INITIALIZE)).status).toBe(401);
    expect((await rpc(app, sourceId, `${token}x`, INITIALIZE)).status).toBe(401);
  });

  test('404s an unknown source', async () => {
    const { app, token } = await setup();
    expect((await rpc(app, 'nope', token, INITIALIZE)).status).toBe(404);
  });

  test('serves MCP over stateless streamable HTTP: initialize and tools/list as JSON', async () => {
    const { app, sourceId, token } = await setup();

    const init = await rpc(app, sourceId, token, INITIALIZE);
    expect(init.status).toBe(200);
    const initBody = JsonRpcResultSchema.parse(await init.json());
    expect(z.object({ serverInfo: z.object({ name: z.string() }) }).parse(initBody.result).serverInfo.name).toBe(
      'github-source-tools',
    );

    const list = await rpc(app, sourceId, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(list.status).toBe(200);
    const listBody = JsonRpcResultSchema.parse(await list.json());
    const names = z
      .object({ tools: z.array(z.object({ name: z.string() })) })
      .parse(listBody.result)
      .tools.map(tool => tool.name);
    expect(names).toContain('create_issue');
    expect(names).toContain('get_issue');
  });

  test('GET and DELETE are not part of the stateless contract', async () => {
    const { app, sourceId } = await setup();
    expect((await app.request(`/${sourceId}/mcp`)).status).toBe(405);
    expect((await app.request(`/${sourceId}/mcp`, { method: 'DELETE' })).status).toBe(405);
  });
});
