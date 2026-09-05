import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { coalesceEvents } from '../../../src/controller/eventCoalesce';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteAutomationStore } from '../../../src/db/sqlite/automation-store/SqliteAutomationStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteEventSourceStore } from '../../../src/db/sqlite/event-source-store/SqliteEventSourceStore';
import { SqliteEventStore } from '../../../src/db/sqlite/event-store/SqliteEventStore';
import { AutomationManifestSchema } from '../../../src/schemas/automation';

const TENANT = 'default';
const SUBJECT = { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' };

function fakeLogger() {
  return { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() } as never;
}

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const agentStore = new SqliteAgentStore(db);
  const eventSourceStore = new SqliteEventSourceStore(db);
  const eventStore = new SqliteEventStore(db);
  const automationStore = new SqliteAutomationStore(db);

  const agent = await agentStore.createAgent({
    tenant_id: TENANT,
    created_by_subject: SUBJECT,
    name: 'planner',
    manifest: AgentSpecSchema.parse({ model: { name: 'p/m' }, instructions: 'plan' }),
    external_id: null,
  });
  const source = await eventSourceStore.createPendingGithubSource({
    tenant_id: TENANT,
    name: 'github',
    manifest_state: 's',
    created_by_subject: SUBJECT,
  });

  const automation = await automationStore.createAutomation({
    tenant_id: TENANT,
    agent_id: agent.id,
    agent_name: agent.name,
    name: 'plan-mission',
    created_by_subject: SUBJECT,
    manifest: AutomationManifestSchema.parse({
      trigger: {
        type: 'event',
        source_id: source.id,
        kind: 'issues.labeled',
        when: { all: [{ field: 'label.name', op: 'eq', value: 'ready-for-planning' }] },
      },
      coalesce_seconds: 30,
      lane: [
        { type: 'field', path: 'repository.full_name' },
        { type: 'literal', value: 'planning' },
      ],
      task: 'Plan the mission.',
      mode: 'armed',
    }),
  });

  async function deliver(delivery: string, label: string, number: number, at: string) {
    return eventStore.insertEvent({
      tenant_id: TENANT,
      source_id: source.id,
      source_kind: 'github',
      received_at: new Date(at),
      event: {
        kind: 'issues.labeled',
        subject_key: `o/r#${String(number)}`,
        delivery_id: delivery,
        summary: { repository: 'o/r', number, title: 't', actor: 'a', label },
        payload: { action: 'labeled', label: { name: label }, issue: { number }, repository: { full_name: 'o/r' } },
      },
    });
  }

  return { eventStore, automationStore, automation, deliver };
}

describe('coalesceEvents', () => {
  test('a burst of matching events for one subject opens exactly one sliding window', async () => {
    const { eventStore, automationStore, automation, deliver } = await setup();
    await deliver('d1', 'ready-for-planning', 61, '2026-09-05T10:00:00.000Z');
    await deliver('d2', 'ready-for-planning', 61, '2026-09-05T10:00:05.000Z');
    await deliver('d3', 'ready-for-planning', 61, '2026-09-05T10:00:10.000Z');
    await deliver('d4', 'ready-for-planning', 61, '2026-09-05T10:00:20.000Z');
    await deliver('other-label', 'needs-info', 61, '2026-09-05T10:00:21.000Z');
    await deliver('other-subject', 'ready-for-planning', 62, '2026-09-05T10:00:22.000Z');

    const now = new Date('2026-09-05T10:00:30.000Z');
    const result = await coalesceEvents({ eventStore, automationStore, logger: fakeLogger(), now });
    expect(result).toEqual({ routed: 6, matched: 5 });

    const runs = await automationStore.listRuns({ tenant_id: TENANT, automation_id: automation.id });
    expect(runs).toHaveLength(2);
    const run61 = runs.find(run => run.subject_key === 'o/r#61');
    const run62 = runs.find(run => run.subject_key === 'o/r#62');
    expect(run61?.event_ids).toHaveLength(4);
    expect(run61?.status).toBe('coalescing');
    expect(run61?.lane_key).toBe('o/r/planning');
    expect(run61?.mode).toBe('armed');
    expect(run61?.scheduled_for).toBe('2026-09-05T10:01:00.000Z');
    expect(run62?.event_ids).toHaveLength(1);

    expect(await eventStore.listUnrouted({ limit: 10 })).toHaveLength(0);

    const again = await coalesceEvents({ eventStore, automationStore, logger: fakeLogger(), now });
    expect(again).toEqual({ routed: 0, matched: 0 });
  });

  test('a later event appends to the open window and slides its close time', async () => {
    const { eventStore, automationStore, automation, deliver } = await setup();
    await deliver('d1', 'ready-for-planning', 61, '2026-09-05T10:00:00.000Z');
    await coalesceEvents({
      eventStore,
      automationStore,
      logger: fakeLogger(),
      now: new Date('2026-09-05T10:00:01.000Z'),
    });
    await deliver('d2', 'ready-for-planning', 61, '2026-09-05T10:00:20.000Z');
    await coalesceEvents({
      eventStore,
      automationStore,
      logger: fakeLogger(),
      now: new Date('2026-09-05T10:00:21.000Z'),
    });

    const runs = await automationStore.listRuns({ tenant_id: TENANT, automation_id: automation.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.event_ids).toHaveLength(2);
    expect(runs[0]?.scheduled_for).toBe('2026-09-05T10:00:51.000Z');
  });

  test('paused automations match nothing', async () => {
    const { eventStore, automationStore, automation, deliver } = await setup();
    await automationStore.updateAutomation({
      tenant_id: TENANT,
      id: automation.id,
      name: automation.name,
      manifest: { ...automation.manifest, status: 'paused' },
    });
    await deliver('d1', 'ready-for-planning', 61, '2026-09-05T10:00:00.000Z');
    const result = await coalesceEvents({ eventStore, automationStore, logger: fakeLogger() });
    expect(result).toEqual({ routed: 1, matched: 0 });
    expect(await automationStore.listRuns({ tenant_id: TENANT, automation_id: automation.id })).toHaveLength(0);
  });
});
