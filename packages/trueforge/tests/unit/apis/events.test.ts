import { OpenAPIHono } from '@hono/zod-openapi';
import { createEventsRouter } from '../../../src/apis/events';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteEventSourceStore } from '../../../src/db/sqlite/event-source-store/SqliteEventSourceStore';
import { SqliteEventStore } from '../../../src/db/sqlite/event-store/SqliteEventStore';
import { GetEventResponseSchema, ListEventsResponseSchema } from '../../../src/schemas/event';

const ALICE: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'alice', type: 'user', display_name: 'alice' },
  roles: [],
  user_credential: null,
};

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const eventSourceStore = new SqliteEventSourceStore(db);
  const eventStore = new SqliteEventStore(db);
  const source = await eventSourceStore.createPendingGithubSource({
    tenant_id: 'default',
    name: 'github-dogfood',
    manifest_state: 's',
    created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
  });
  const other = await eventSourceStore.createPendingGithubSource({
    tenant_id: 'other-tenant',
    name: 'github-other',
    manifest_state: 's2',
    created_by_subject: { subject_id: 'bob', subject_type: 'user', subject_display_name: 'bob' },
  });

  const insert = async (input: {
    source: { id: string; tenant_id: string };
    kind: string;
    subject: string;
    delivery: string;
    at: string;
  }) =>
    eventStore.insertEvent({
      tenant_id: input.source.tenant_id,
      source_id: input.source.id,
      source_kind: 'github',
      received_at: new Date(input.at),
      event: {
        kind: input.kind,
        subject_key: input.subject,
        delivery_id: input.delivery,
        summary: { repository: 'o/r', number: 61, title: 't', actor: 'a', label: null },
        payload: { big: 'payload', delivery: input.delivery },
      },
    });

  await insert({ source, kind: 'issues.labeled', subject: 'o/r#61', delivery: 'd1', at: '2026-09-01T00:00:00.000Z' });
  await insert({ source, kind: 'issues.labeled', subject: 'o/r#62', delivery: 'd2', at: '2026-09-02T00:00:00.000Z' });
  await insert({
    source,
    kind: 'pull_request.opened',
    subject: 'o/r#70',
    delivery: 'd3',
    at: '2026-09-03T00:00:00.000Z',
  });
  await insert({
    source: other,
    kind: 'issues.labeled',
    subject: 'x/y#1',
    delivery: 'd4',
    at: '2026-09-04T00:00:00.000Z',
  });

  const app = new OpenAPIHono();
  app.route('/', createEventsRouter({ eventStore, resolveRequestContext: () => ALICE }));
  return { app, eventStore, source };
}

describe('events API', () => {
  test('lists newest first, scoped to the tenant, without payloads', async () => {
    const { app } = await setup();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = ListEventsResponseSchema.parse(await res.json());
    expect(body.data.map(e => e.delivery_id)).toEqual(['d3', 'd2', 'd1']);
    expect(JSON.stringify(body)).not.toContain('big');
    expect(body.data[0]?.source_kind).toBe('github');
  });

  test('filters by kind, subject and since; paginates', async () => {
    const { app } = await setup();
    const byKind = ListEventsResponseSchema.parse(await (await app.request('/?kind=issues.labeled')).json());
    expect(byKind.data.map(e => e.delivery_id)).toEqual(['d2', 'd1']);

    const bySubject = ListEventsResponseSchema.parse(await (await app.request('/?subject_key=o%2Fr%2361')).json());
    expect(bySubject.data.map(e => e.delivery_id)).toEqual(['d1']);

    const since = ListEventsResponseSchema.parse(await (await app.request('/?since=2026-09-02T00:00:00.000Z')).json());
    expect(since.data.map(e => e.delivery_id)).toEqual(['d3', 'd2']);

    const page1 = ListEventsResponseSchema.parse(await (await app.request('/?limit=2')).json());
    expect(page1.data).toHaveLength(2);
    expect(page1.pagination.next_page_token ?? null).not.toBeNull();
    const page2 = ListEventsResponseSchema.parse(
      await (await app.request(`/?limit=2&page_token=${page1.pagination.next_page_token}`)).json(),
    );
    expect(page2.data.map(e => e.delivery_id)).toEqual(['d1']);
    expect(page2.pagination.next_page_token ?? null).toBeNull();
  });

  test('get returns the payload; foreign tenant is 404', async () => {
    const { app, eventStore } = await setup();
    const { data } = await eventStore.listEvents({ tenant_id: 'default', limit: 1, page_token: undefined });
    const res = await app.request(`/${data[0]?.id}`);
    expect(res.status).toBe(200);
    const body = GetEventResponseSchema.parse(await res.json());
    expect(body.data.payload).toEqual({ big: 'payload', delivery: 'd3' });

    const foreign = await eventStore.listEvents({ tenant_id: 'other-tenant', limit: 1, page_token: undefined });
    expect((await app.request(`/${foreign.data[0]?.id}`)).status).toBe(404);
  });

  test('unrouted listing and markRouted', async () => {
    const { eventStore } = await setup();
    const unrouted = await eventStore.listUnrouted({ limit: 10 });
    expect(unrouted.map(e => e.delivery_id)).toEqual(['d1', 'd2', 'd3', 'd4']);
    await eventStore.markRouted({ ids: unrouted.slice(0, 2).map(e => e.id), at: new Date('2026-09-05T00:00:00.000Z') });
    const remaining = await eventStore.listUnrouted({ limit: 10 });
    expect(remaining.map(e => e.delivery_id)).toEqual(['d3', 'd4']);
  });
});
