import { OpenAPIHono } from '@hono/zod-openapi';
import { createEventSourcesRouter, createGithubManifestCallbackRouter } from '../../../src/apis/eventSources';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteEventSourceStore } from '../../../src/db/sqlite/event-source-store/SqliteEventSourceStore';
import { RequestErrorResponseSchema } from '../../../src/schemas/errors';
import {
  CreateGithubManifestResponseSchema,
  GetEventSourceResponseSchema,
  ListEventSourcesResponseSchema,
} from '../../../src/schemas/eventSource';

const ADMIN: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'root', type: 'user', display_name: 'root' },
  roles: ['admin'],
  user_credential: null,
};

const PUBLIC_BASE_URL = 'https://forge.example.test';

function conversionResponse() {
  return new Response(
    JSON.stringify({
      id: 4242,
      slug: 'tf-dogfood',
      client_id: 'Iv1.abc',
      client_secret: 'shh-client',
      webhook_secret: 'shh-hook',
      pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n',
      html_url: 'https://github.com/apps/tf-dogfood',
      owner: { login: 'Xelmar-tech' },
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
}

async function setup(options: { publicBaseUrl?: string | null; fetchImpl?: typeof fetch } = {}) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const eventSourceStore = new SqliteEventSourceStore(db);
  const publicBaseUrl = options.publicBaseUrl === undefined ? PUBLIC_BASE_URL : options.publicBaseUrl;

  const app = new OpenAPIHono();
  app.route(
    '/github',
    createGithubManifestCallbackRouter({
      eventSourceStore,
      logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as never,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
  );
  app.route(
    '/',
    createEventSourcesRouter({
      eventSourceStore,
      withTransaction: callback => db.transaction().execute(callback),
      resolveRequestContext: () => ADMIN,
      getPublicBaseUrl: () => {
        if (publicBaseUrl === null) throw new Error('PUBLIC_BASE_URL is required');
        return publicBaseUrl;
      },
    }),
  );
  return { app, eventSourceStore };
}

async function startManifest(app: OpenAPIHono, body: unknown) {
  return app.request('/github/manifest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function startedManifest(app: OpenAPIHono, body: unknown) {
  const res = await startManifest(app, body);
  expect(res.status).toBe(201);
  return CreateGithubManifestResponseSchema.parse(await res.json()).data;
}

function fetchStub(handler: () => Response): typeof fetch {
  const stub: typeof fetch = async () => handler();
  return stub;
}

describe('event sources API', () => {
  test('manifest start creates a pending source and returns what the browser posts to GitHub', async () => {
    const { app, eventSourceStore } = await setup();
    const data = await startedManifest(app, { name: 'github-dogfood', owner: 'Xelmar-tech' });
    expect(data.action_url).toBe(`https://github.com/organizations/Xelmar-tech/settings/apps/new?state=${data.state}`);
    expect(data.manifest).toMatchObject({
      name: 'github-dogfood',
      url: PUBLIC_BASE_URL,
      hook_attributes: { url: `${PUBLIC_BASE_URL}/api/v1/webhooks/${data.source_id}`, active: true },
      redirect_url: `${PUBLIC_BASE_URL}/api/v1/event-sources/github/callback`,
      public: false,
      default_permissions: { issues: 'write', pull_requests: 'write', contents: 'write' },
    });

    const source = await eventSourceStore.getSource({ tenant_id: 'default', id: data.source_id });
    expect(source?.status).toBe('pending');
    expect(source?.manifest).toEqual({ kind: 'github', app: null });
    expect(source?.manifest_state).toBe(data.state);
  });

  test('manifest start without an owner targets the personal apps page', async () => {
    const { app } = await setup();
    const data = await startedManifest(app, { name: 'personal' });
    expect(data.action_url.startsWith('https://github.com/settings/apps/new?state=')).toBe(true);
  });

  test('manifest start needs a public base URL', async () => {
    const { app } = await setup({ publicBaseUrl: null });
    const res = await startManifest(app, { name: 'github-dogfood' });
    expect(res.status).toBe(400);
    const body = RequestErrorResponseSchema.parse(await res.json());
    expect(body.error.message).toContain('PUBLIC_BASE_URL');
  });

  test('duplicate name is 409', async () => {
    const { app } = await setup();
    expect((await startManifest(app, { name: 'dup' })).status).toBe(201);
    expect((await startManifest(app, { name: 'dup' })).status).toBe(409);
  });

  test('callback exchanges the code, stores credentials out of band, and redirects to settings', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${typeof input === 'string' ? input : input.toString()}`);
      return conversionResponse();
    };
    const { app, eventSourceStore } = await setup({ fetchImpl });
    const data = await startedManifest(app, { name: 'github-dogfood' });

    const res = await app.request(`/github/callback?code=one-time&state=${data.state}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings?');
    expect(location).toContain('isSuccess=true');
    expect(location).toContain(`source=${data.source_id}`);
    expect(calls).toEqual(['POST https://api.github.com/app-manifests/one-time/conversions']);

    const source = await eventSourceStore.getSource({ tenant_id: 'default', id: data.source_id });
    expect(source?.status).toBe('active');
    expect(source?.manifest_state).toBeNull();
    expect(source?.manifest).toEqual({
      kind: 'github',
      app: {
        app_id: 4242,
        app_slug: 'tf-dogfood',
        client_id: 'Iv1.abc',
        html_url: 'https://github.com/apps/tf-dogfood',
        owner: 'Xelmar-tech',
      },
    });
    expect(await eventSourceStore.getSecrets(data.source_id)).toEqual({
      kind: 'github',
      github: {
        private_key: expect.stringContaining('PRIVATE KEY'),
        webhook_secret: 'shh-hook',
        client_secret: 'shh-client',
      },
    });

    // The state is single use.
    const again = await app.request(`/github/callback?code=one-time&state=${data.state}`, { redirect: 'manual' });
    expect(again.status).toBe(400);
  });

  test('callback with a rejected code redirects with isSuccess=false', async () => {
    const { app, eventSourceStore } = await setup({
      fetchImpl: fetchStub(() => new Response('nope', { status: 404 })),
    });
    const data = await startedManifest(app, { name: 'github-dogfood' });
    const res = await app.request(`/github/callback?code=bad&state=${data.state}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('isSuccess=false');
    const source = await eventSourceStore.getSource({ tenant_id: 'default', id: data.source_id });
    expect(source?.status).toBe('pending');
  });

  test('list and get never include secrets and carry the webhook url', async () => {
    const { app } = await setup({ fetchImpl: fetchStub(conversionResponse) });
    const data = await startedManifest(app, { name: 'github-dogfood' });
    await app.request(`/github/callback?code=c&state=${data.state}`, { redirect: 'manual' });

    const listRes = await app.request('/');
    expect(listRes.status).toBe(200);
    const listBody = ListEventSourcesResponseSchema.parse(await listRes.json());
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.webhook_url).toBe(`${PUBLIC_BASE_URL}/api/v1/webhooks/${data.source_id}`);
    expect(JSON.stringify(listBody)).not.toContain('shh-');
    expect(JSON.stringify(listBody)).not.toContain('PRIVATE KEY');

    const getRes = await app.request(`/${data.source_id}`);
    expect(getRes.status).toBe(200);
    const getBody = GetEventSourceResponseSchema.parse(await getRes.json());
    expect(getBody.data.status).toBe('active');
    expect(JSON.stringify(getBody)).not.toContain('shh-');

    const delRes = await app.request(`/${data.source_id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect((await app.request(`/${data.source_id}`)).status).toBe(404);
  });
});
