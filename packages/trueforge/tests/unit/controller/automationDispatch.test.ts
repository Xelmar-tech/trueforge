import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import {
  buildRunTask,
  dispatchAutomationRuns,
  executeAutomationRun,
  runSessionMetadata,
  shadowAgentSpec,
} from '../../../src/controller/automationDispatch';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteAutomationStore } from '../../../src/db/sqlite/automation-store/SqliteAutomationStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteEventSourceStore } from '../../../src/db/sqlite/event-source-store/SqliteEventSourceStore';
import { SqliteEventStore } from '../../../src/db/sqlite/event-store/SqliteEventStore';
import { AutomationManifestSchema, type AutomationMode } from '../../../src/schemas/automation';

const TENANT = 'default';
const SUBJECT = { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' };

function fakeLogger() {
  return { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() } as never;
}

async function setup(mode: AutomationMode, lane = true) {
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
      trigger: { type: 'event', source_id: source.id, kind: 'issues.labeled' },
      coalesce_seconds: 0,
      lane: lane ? [{ type: 'literal', value: 'planning' }] : [],
      task: 'Plan it.',
      mode,
    }),
  });
  const { event } = await eventStore.insertEvent({
    tenant_id: TENANT,
    source_id: source.id,
    source_kind: 'github',
    received_at: new Date('2026-09-05T10:00:00.000Z'),
    event: {
      kind: 'issues.labeled',
      subject_key: 'o/r#61',
      delivery_id: 'd1',
      summary: { repository: 'o/r', number: 61, title: 'Mission', actor: 'a', label: 'ready-for-planning' },
      payload: { action: 'labeled', issue: { number: 61, body: 'the PRD' } },
    },
  });
  const run = await automationStore.upsertCoalescingRun({
    tenant_id: TENANT,
    automation_id: automation.id,
    subject_key: 'o/r#61',
    lane_key: lane ? 'planning' : null,
    mode,
    event_id: event.id,
    scheduled_for: new Date('2026-09-05T10:00:00.000Z'),
    created_by_subject: SUBJECT,
  });
  const detail = await eventStore.getEvent({ tenant_id: TENANT, id: event.id });
  if (detail === undefined) throw new Error('event vanished');
  return { automationStore, eventStore, automation, run, event, detail };
}

describe('dispatchAutomationRuns', () => {
  test('hands a due run off, stamps the session and marks it triggered', async () => {
    const { automationStore, eventStore, run, event, automation } = await setup('armed');
    const onTriggered = jest.fn().mockResolvedValue('ses_1');
    const result = await dispatchAutomationRuns({
      automationStore,
      eventStore,
      onTriggered,
      logger: fakeLogger(),
      now: new Date('2026-09-05T10:00:05.000Z'),
    });
    expect(result).toEqual({ dispatched: 1, skipped: 0, failed: 0 });
    expect(onTriggered).toHaveBeenCalledTimes(1);
    const handoff = onTriggered.mock.calls[0]?.[0];
    expect(handoff.run.id).toBe(run.id);
    expect(handoff.automation.id).toBe(automation.id);
    expect(handoff.events.map((e: { id: string }) => e.id)).toEqual([event.id]);

    const stored = await automationStore.getRun({ tenant_id: TENANT, id: run.id });
    expect(stored?.status).toBe('triggered');
    expect(stored?.session_id).toBe('ses_1');
    expect(stored?.triggered_at).toBe('2026-09-05T10:00:05.000Z');
  });

  test('a busy lane defers the run; a free lane runs it', async () => {
    const { automationStore, eventStore, automation } = await setup('armed');
    // Another run already holds the lane.
    const blocker = await automationStore.createImmediateRun({
      tenant_id: TENANT,
      automation_id: automation.id,
      subject_key: 'o/r#99',
      lane_key: 'planning',
      mode: 'armed',
      event_ids: [],
      created_by_subject: SUBJECT,
      now: new Date('2026-09-05T09:00:00.000Z'),
    });
    await automationStore.markTriggered({ tenant_id: TENANT, id: blocker.id, session_id: 'ses_0', at: new Date() });

    const onTriggered = jest.fn().mockResolvedValue('ses_1');
    const deferred = await dispatchAutomationRuns({ automationStore, eventStore, onTriggered, logger: fakeLogger() });
    expect(deferred).toEqual({ dispatched: 0, skipped: 1, failed: 0 });
    expect(onTriggered).not.toHaveBeenCalled();

    await automationStore.finishRun({
      tenant_id: TENANT,
      id: blocker.id,
      status: 'completed',
      outcome: null,
      at: new Date(),
    });
    const ran = await dispatchAutomationRuns({ automationStore, eventStore, onTriggered, logger: fakeLogger() });
    expect(ran).toEqual({ dispatched: 1, skipped: 0, failed: 0 });
  });

  test('a hand-off failure fails the run with the error as outcome', async () => {
    const { automationStore, eventStore, run } = await setup('armed');
    const result = await dispatchAutomationRuns({
      automationStore,
      eventStore,
      onTriggered: jest.fn().mockRejectedValue(new Error('api down')),
      logger: fakeLogger(),
    });
    expect(result).toEqual({ dispatched: 0, skipped: 0, failed: 1 });
    const stored = await automationStore.getRun({ tenant_id: TENANT, id: run.id });
    expect(stored?.status).toBe('failed');
    expect(stored?.outcome).toEqual({ error: 'api down' });
  });

  test('a deleted automation fails its pending run', async () => {
    const { automationStore, eventStore, run, automation } = await setup('armed');
    await automationStore.deleteAutomation({ tenant_id: TENANT, id: automation.id });
    // Cascade removed the run; nothing to dispatch.
    const result = await dispatchAutomationRuns({
      automationStore,
      eventStore,
      onTriggered: jest.fn(),
      logger: fakeLogger(),
    });
    expect(result).toEqual({ dispatched: 0, skipped: 0, failed: 0 });
    expect(await automationStore.getRun({ tenant_id: TENANT, id: run.id })).toBeUndefined();
  });
});

describe('executeAutomationRun', () => {
  function fakeClient(options: { existingTurns?: number } = {}) {
    const calls: string[] = [];
    const agentSpec: TrueForgeApi.AgentSpec = {
      model: { name: 'p/m' },
      instructions: 'plan',
      mcpServers: [{ name: 'github', requireApprovalForTools: ['@write'] }],
    };
    const client = {
      agents: {
        list: jest.fn(async () => {
          calls.push('agents.list');
          return { data: [{ id: 'agent-1', name: 'planner', manifest: agentSpec, createdBySubject: SUBJECT }] };
        }),
      },
      internal: {
        sessions: {
          getOrCreateByExternalId: jest.fn(
            async (request: TrueForgeApi.internal.GetOrCreateSessionByExternalIdRequest) => {
              calls.push(`getOrCreate ${request.externalId} ${'name' in request.agent ? 'name' : 'spec'}`);
              return { data: { id: 'ses_1', agent: { type: 'reference', id: 'agent-1', name: 'planner' } } };
            },
          ),
        },
      },
      sessions: {
        update: jest.fn(async (id: string) => {
          calls.push(`update ${id}`);
          return { data: {} };
        }),
        listTurns: jest.fn(async () => ({ data: Array.from({ length: options.existingTurns ?? 0 }, () => ({})) })),
        createTurn: jest.fn(async (id: string) => {
          calls.push(`createTurn ${id}`);
          return { data: {} };
        }),
      },
    };
    return { client: client as never, calls, agentSpec };
  }

  test('armed runs bind by agent name; the first turn carries the events', async () => {
    const { automation, run, detail } = await setup('armed');
    const { client, calls } = fakeClient();
    const sessionId = await executeAutomationRun(client)({ run, automation, events: [detail] });
    expect(sessionId).toBe('ses_1');
    expect(calls).toEqual([`getOrCreate ${run.id} name`, 'update ses_1', 'createTurn ses_1']);
  });

  test('shadow runs use an inline spec with every MCP tool gated', async () => {
    const { automation, run } = await setup('shadow');
    const { client, calls, agentSpec } = fakeClient();
    await executeAutomationRun(client)({ run, automation, events: [] });
    expect(calls[0]).toBe('agents.list');
    expect(calls[1]).toBe(`getOrCreate ${run.id} spec`);
    expect(shadowAgentSpec(agentSpec).mcpServers?.[0]?.requireApprovalForTools).toEqual(['@all']);
  });

  test('is idempotent: a session that already has a turn gets no second one', async () => {
    const { automation, run } = await setup('armed');
    const { client, calls } = fakeClient({ existingTurns: 1 });
    await executeAutomationRun(client)({ run, automation, events: [] });
    expect(calls.some(call => call.startsWith('createTurn'))).toBe(false);
  });

  test('task and metadata carry the automation and events', async () => {
    const { automation, run, event, detail } = await setup('armed');
    const task = buildRunTask(automation, run, [detail]);
    expect(task.startsWith('Plan it.')).toBe(true);
    expect(task).toContain('"kind": "issues.labeled"');
    expect(task).toContain('"body": "the PRD"');
    const metadata = runSessionMetadata(run, automation);
    expect(metadata).toMatchObject({
      automation_id: automation.id,
      automation_run_id: run.id,
      automation_mode: 'armed',
    });
    expect(metadata['event_id']).toBe(event.id);
  });
});
