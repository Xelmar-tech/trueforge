import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { createAutomationsRouter } from '../../../src/apis/automations';
import { TrueForgeAuthorizer } from '../../../src/auth/authorizer';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteAutomationStore } from '../../../src/db/sqlite/automation-store/SqliteAutomationStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteEventSourceStore } from '../../../src/db/sqlite/event-source-store/SqliteEventSourceStore';
import { SqliteEventStore } from '../../../src/db/sqlite/event-store/SqliteEventStore';
import {
  GetAutomationResponseSchema,
  ListAutomationRunsResponseSchema,
  ListAutomationsResponseSchema,
  ReplayAutomationResponseSchema,
} from '../../../src/schemas/automation';
import { RequestErrorResponseSchema } from '../../../src/schemas/errors';

const ALICE: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'alice', type: 'user', display_name: 'alice' },
  roles: [],
  user_credential: null,
};
const BOB: RequestContext = { ...ALICE, subject: { id: 'bob', type: 'user', display_name: 'bob' } };
const ADMIN: RequestContext = {
  ...ALICE,
  subject: { id: 'root', type: 'user', display_name: 'root' },
  roles: ['admin'],
};

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const agentStore = new SqliteAgentStore(db);
  const eventSourceStore = new SqliteEventSourceStore(db);
  const eventStore = new SqliteEventStore(db);
  const automationStore = new SqliteAutomationStore(db);
  await agentStore.createAgent({
    tenant_id: 'default',
    created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
    name: 'planner',
    manifest: AgentSpecSchema.parse({ model: { name: 'p/m' }, instructions: 'plan' }),
    external_id: null,
  });
  const source = await eventSourceStore.createPendingGithubSource({
    tenant_id: 'default',
    name: 'github',
    manifest_state: 's',
    created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
  });
  const { event } = await eventStore.insertEvent({
    tenant_id: 'default',
    source_id: source.id,
    source_kind: 'github',
    received_at: new Date('2026-09-05T10:00:00.000Z'),
    event: {
      kind: 'issues.labeled',
      subject_key: 'o/r#61',
      delivery_id: 'd1',
      summary: { repository: 'o/r', number: 61, title: 'Mission', actor: 'a', label: 'ready-for-planning' },
      payload: { action: 'labeled', repository: { full_name: 'o/r' } },
    },
  });

  let current: RequestContext = ALICE;
  const app = new OpenAPIHono();
  app.route(
    '/',
    createAutomationsRouter({
      automationStore,
      eventStore,
      eventSourceStore,
      resolveAgentStore: () => agentStore,
      withTransaction: callback => db.transaction().execute(callback),
      resolveRequestContext: () => current,
      authorizer: new TrueForgeAuthorizer(),
    }),
  );
  const as = (ctx: RequestContext) => {
    current = ctx;
  };
  const body = (sourceId: string) => ({
    agent_name: 'planner',
    name: 'plan-mission',
    manifest: {
      trigger: {
        type: 'event',
        source_id: sourceId,
        kind: 'issues.labeled',
        when: { all: [{ field: 'label.name', op: 'eq', value: 'ready-for-planning' }] },
      },
      task: 'Plan it.',
      lane: [
        { type: 'field', path: 'repository.full_name' },
        { type: 'literal', value: 'planning' },
      ],
    },
  });
  return { app, as, source, event, body, automationStore };
}

async function post(app: OpenAPIHono, path: string, payload: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('automations API', () => {
  test('create applies manifest defaults (shadow, 30s coalesce) and lists for the creator', async () => {
    const { app, source, body } = await setup();
    const res = await post(app, '/', body(source.id));
    expect(res.status).toBe(201);
    const created = GetAutomationResponseSchema.parse(await res.json()).data;
    expect(created.manifest.mode).toBe('shadow');
    expect(created.manifest.coalesce_seconds).toBe(30);
    expect(created.manifest.status).toBe('active');
    expect(created.manifest.emit).toEqual([]);

    const list = ListAutomationsResponseSchema.parse(await (await app.request('/')).json());
    expect(list.data.map(a => a.name)).toEqual(['plan-mission']);
  });

  test('create rejects an unknown agent (404), unknown source (400) and duplicate name (409)', async () => {
    const { app, source, body } = await setup();
    expect((await post(app, '/', { ...body(source.id), agent_name: 'ghost' })).status).toBe(404);
    const badSource = await post(app, '/', { ...body('nope'), name: 'x-source' });
    expect(badSource.status).toBe(400);
    expect(RequestErrorResponseSchema.parse(await badSource.json()).error.message).toContain('Event source not found');
    expect((await post(app, '/', body(source.id))).status).toBe(201);
    expect((await post(app, '/', body(source.id))).status).toBe(409);
  });

  test('create rejects a malformed condition', async () => {
    const { app, source, body } = await setup();
    const payload = body(source.id);
    payload.manifest.trigger.when = { all: [{ field: 'label.name', op: 'like', value: 'x' }] } as never;
    expect((await post(app, '/', payload)).status).toBe(400);
  });

  test('only the creator or an admin can read, update, list runs, or delete', async () => {
    const { app, as, source, body } = await setup();
    const created = GetAutomationResponseSchema.parse(await (await post(app, '/', body(source.id))).json()).data;

    as(BOB);
    expect((await app.request(`/${created.id}`)).status).toBe(403);
    expect((await app.request(`/${created.id}/runs`)).status).toBe(403);
    expect((await app.request(`/${created.id}`, { method: 'DELETE' })).status).toBe(403);
    expect(ListAutomationsResponseSchema.parse(await (await app.request('/')).json()).data).toHaveLength(0);

    as(ADMIN);
    expect((await app.request(`/${created.id}`)).status).toBe(200);
    expect(ListAutomationsResponseSchema.parse(await (await app.request('/')).json()).data).toHaveLength(1);

    as(ALICE);
    const updated = await app.request(`/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'plan-mission', manifest: { ...created.manifest, mode: 'armed' } }),
    });
    expect(updated.status).toBe(200);
    expect(GetAutomationResponseSchema.parse(await updated.json()).data.manifest.mode).toBe('armed');
    expect((await app.request(`/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/${created.id}`)).status).toBe(404);
  });

  test('replay creates an immediate shadow run keyed to the event, never touching live windows', async () => {
    const { app, source, body, event, automationStore } = await setup();
    const created = GetAutomationResponseSchema.parse(await (await post(app, '/', body(source.id))).json()).data;

    const res = await post(app, `/${created.id}/replay`, { event_id: event.id });
    expect(res.status).toBe(201);
    const run = ReplayAutomationResponseSchema.parse(await res.json()).data;
    expect(run.status).toBe('coalescing');
    expect(run.mode).toBe('shadow');
    expect(run.event_ids).toEqual([event.id]);
    expect(run.subject_key).toBe(`o/r#61~replay:${event.id}`);
    expect(run.lane_key).toBe('o/r/planning');

    const due = await automationStore.listDueRuns({ until: new Date(), limit: 10 });
    expect(due.map(r => r.id)).toEqual([run.id]);

    const runs = ListAutomationRunsResponseSchema.parse(await (await app.request(`/${created.id}/runs`)).json());
    expect(runs.data.map(r => r.id)).toEqual([run.id]);

    expect((await post(app, `/${created.id}/replay`, { event_id: 'nope' })).status).toBe(404);
  });

  test('replay rejects an event whose kind differs from the trigger', async () => {
    const { app, source, body, event } = await setup();
    const payload = body(source.id);
    payload.manifest.trigger.kind = 'pull_request.opened';
    const created = GetAutomationResponseSchema.parse(await (await post(app, '/', payload)).json()).data;
    // The seeded event is issues.labeled, so it cannot replay through a pull_request trigger.
    const res = await post(app, `/${created.id}/replay`, { event_id: event.id });
    expect(res.status).toBe(400);
    expect(RequestErrorResponseSchema.parse(await res.json()).error.message).toContain('pull_request.opened');
  });
});
