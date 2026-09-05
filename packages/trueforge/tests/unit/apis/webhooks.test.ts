import { OpenAPIHono } from '@hono/zod-openapi';
import { createWebhooksRouter } from '../../../src/apis/webhooks';
import { githubConnector, signGithubBody } from '../../../src/connectors/github/webhook';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteEventSourceStore } from '../../../src/db/sqlite/event-source-store/SqliteEventSourceStore';
import { SqliteEventStore } from '../../../src/db/sqlite/event-store/SqliteEventStore';
import { WebhookAcceptedSchema } from '../../../src/routes/webhookRoutes';

const SECRET = 'hook-secret';
const CREATOR = { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' };

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const eventSourceStore = new SqliteEventSourceStore(db);
  const eventStore = new SqliteEventStore(db);
  const pending = await eventSourceStore.createPendingGithubSource({
    tenant_id: 'default',
    name: 'github-dogfood',
    manifest_state: 'state-1',
    created_by_subject: CREATOR,
  });
  const source = await eventSourceStore.activateGithubSource({
    tenant_id: 'default',
    id: pending.id,
    app: {
      app_id: 1,
      app_slug: 'tf-dogfood',
      client_id: 'cid',
      html_url: 'https://github.com/apps/tf-dogfood',
      owner: 'xelmar',
    },
    secrets: { private_key: 'pem', webhook_secret: SECRET, client_secret: 'cs' },
  });
  if (source === undefined) throw new Error('activation failed');

  const app = new OpenAPIHono();
  app.route(
    '/',
    createWebhooksRouter({
      eventSourceStore,
      eventStore,
      connectors: { github: githubConnector },
      logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as never,
      now: () => new Date('2026-09-05T10:00:00.000Z'),
    }),
  );
  return { app, source, eventSourceStore, eventStore };
}

async function deliver(app: OpenAPIHono, sourceId: string, event: string, payload: unknown, delivery: string) {
  const body = JSON.stringify(payload);
  return app.request(`/${sourceId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': signGithubBody(SECRET, body),
    },
    body,
  });
}

const payload = {
  action: 'labeled',
  issue: { number: 61, title: 'Mission' },
  label: { name: 'ready-for-planning' },
  repository: { full_name: 'xelmar-tech/dogfood' },
  sender: { login: 'aaron' },
};

describe('POST /api/v1/webhooks/:source_id', () => {
  test('records a verified delivery and marks the source', async () => {
    const { app, source, eventStore, eventSourceStore } = await setup();
    const res = await deliver(app, source.id, 'issues', payload, 'd-1');
    expect(res.status).toBe(202);
    const body = WebhookAcceptedSchema.parse(await res.json());
    expect(body.created).toBe(true);
    const stored = await eventStore.getEvent({ tenant_id: 'default', id: body.event_id ?? '' });
    expect(stored?.kind).toBe('issues.labeled');
    expect(stored?.subject_key).toBe('xelmar-tech/dogfood#61');
    expect(stored?.payload).toEqual(payload);
    expect(stored?.routed_at).toBeNull();
    const refreshed = await eventSourceStore.getSourceById(source.id);
    expect(refreshed?.last_delivery_at).toBe('2026-09-05T10:00:00.000Z');
    expect(refreshed?.status).toBe('active');
  });

  test('a redelivery of the same delivery id is idempotent', async () => {
    const { app, source, eventStore } = await setup();
    const first = WebhookAcceptedSchema.parse(await (await deliver(app, source.id, 'issues', payload, 'd-1')).json());
    const second = await deliver(app, source.id, 'issues', payload, 'd-1');
    expect(second.status).toBe(202);
    const body = WebhookAcceptedSchema.parse(await second.json());
    expect(body.created).toBe(false);
    expect(body.event_id).toBe(first.event_id);
    const { data } = await eventStore.listEvents({ tenant_id: 'default', limit: 10, page_token: undefined });
    expect(data).toHaveLength(1);
  });

  test('rejects a bad signature with 401 and records nothing', async () => {
    const { app, source, eventStore } = await setup();
    const body = JSON.stringify(payload);
    const res = await app.request(`/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'd-2',
        'x-hub-signature-256': signGithubBody('wrong', body),
      },
      body,
    });
    expect(res.status).toBe(401);
    const { data } = await eventStore.listEvents({ tenant_id: 'default', limit: 10, page_token: undefined });
    expect(data).toHaveLength(0);
  });

  test('unknown source is 404', async () => {
    const { app } = await setup();
    const res = await deliver(app, 'nope', 'issues', payload, 'd-3');
    expect(res.status).toBe(404);
  });

  test('ping is accepted without an event', async () => {
    const { app, source } = await setup();
    const res = await deliver(app, source.id, 'ping', { zen: 'ok' }, 'd-4');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ event_id: null, created: false });
  });
});
