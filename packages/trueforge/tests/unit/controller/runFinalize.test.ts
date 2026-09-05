import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { finalizeRuns, latestTurn } from '../../../src/controller/runFinalize';
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

function turn(state: Record<string, unknown>, id = 'turn_1', createdAt = '2026-09-05T10:05:00.000Z') {
  return { id, sessionId: 'ses_1', previousTurnId: null, createdAt, state };
}

function clientWithTurns(turns: unknown[]) {
  return { sessions: { listTurns: jest.fn(async () => ({ data: turns })) } } as never;
}

async function setup(mode: AutomationMode, emit: string[] = ['plan.published']) {
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
      task: 'Plan it.',
      mode,
      emit,
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
      payload: { action: 'labeled' },
    },
  });
  const pending = await automationStore.upsertCoalescingRun({
    tenant_id: TENANT,
    automation_id: automation.id,
    subject_key: 'o/r#61',
    lane_key: null,
    mode,
    event_id: event.id,
    scheduled_for: new Date('2026-09-05T10:00:00.000Z'),
    created_by_subject: SUBJECT,
  });
  const run = await automationStore.markTriggered({
    tenant_id: TENANT,
    id: pending.id,
    session_id: 'ses_1',
    at: new Date('2026-09-05T10:00:01.000Z'),
  });
  if (run === undefined) throw new Error('markTriggered failed');
  return { automationStore, eventStore, eventSourceStore, automation, run };
}

const NOW = new Date('2026-09-05T10:10:00.000Z');

describe('finalizeRuns', () => {
  test('latestTurn picks the newest by createdAt', () => {
    expect(
      latestTurn([
        turn({ status: 'done' }, 'a', '2026-09-05T10:00:00.000Z'),
        turn({ status: 'running' }, 'b', '2026-09-05T10:06:00.000Z'),
      ] as never)?.id,
    ).toBe('b');
    expect(latestTurn([])).toBeUndefined();
  });

  test('a finished turn completes the run and emits into the internal source', async () => {
    const { automationStore, eventStore, eventSourceStore, run } = await setup('armed');
    const client = clientWithTurns([
      turn({
        status: 'done',
        completedAt: '2026-09-05T10:05:00.000Z',
        output: { type: 'model.message', content: 'Published 7 drafts.' },
        requiredActions: [],
      }),
    ]);
    const result = await finalizeRuns({
      automationStore,
      eventStore,
      eventSourceStore,
      client,
      logger: fakeLogger(),
      now: NOW,
    });
    expect(result).toEqual({ completed: 1, shadowed: 0, waiting: 0, failed: 0 });

    const stored = await automationStore.getRun({ tenant_id: TENANT, id: run.id });
    expect(stored?.status).toBe('completed');
    expect(stored?.finished_at).toBe(NOW.toISOString());
    const emitted = stored?.outcome?.['emitted_event_ids'];
    expect(Array.isArray(emitted) && emitted.length === 1).toBe(true);

    const internal = await eventSourceStore.ensureInternalSource({ tenant_id: TENANT });
    expect(internal.kind).toBe('trueforge');
    const { data } = await eventStore.listEvents({
      tenant_id: TENANT,
      limit: 10,
      page_token: undefined,
      source_id: internal.id,
    });
    expect(data).toHaveLength(1);
    expect(data[0]?.kind).toBe('plan.published');
    expect(data[0]?.subject_key).toBe('o/r#61');
    expect(data[0]?.summary.number).toBe(61);
    expect(data[0]?.routed_at).toBeNull();
    const detail = await eventStore.getEvent({ tenant_id: TENANT, id: data[0]?.id ?? '' });
    expect(detail?.payload).toMatchObject({
      automation_run_id: run.id,
      session_id: 'ses_1',
      output: 'Published 7 drafts.',
    });

    // A second pass is a no-op: the run is terminal and the emitted delivery id is stable.
    const again = await finalizeRuns({
      automationStore,
      eventStore,
      eventSourceStore,
      client,
      logger: fakeLogger(),
      now: NOW,
    });
    expect(again).toEqual({ completed: 0, shadowed: 0, waiting: 0, failed: 0 });
  });

  test('a shadow run paused on approval is shadowed with the pending action recorded', async () => {
    const { automationStore, eventStore, eventSourceStore, run } = await setup('shadow');
    const client = clientWithTurns([
      turn({
        status: 'done',
        completedAt: '2026-09-05T10:05:00.000Z',
        output: null,
        requiredActions: [{ type: 'tool.approval_required', toolName: 'publish_draft_tickets', id: 'act_1' }],
      }),
    ]);
    const result = await finalizeRuns({
      automationStore,
      eventStore,
      eventSourceStore,
      client,
      logger: fakeLogger(),
      now: NOW,
    });
    expect(result).toEqual({ completed: 0, shadowed: 1, waiting: 0, failed: 0 });
    const stored = await automationStore.getRun({ tenant_id: TENANT, id: run.id });
    expect(stored?.status).toBe('shadowed');
    expect(JSON.stringify(stored?.outcome)).toContain('publish_draft_tickets');
    // Nothing emitted for a shadowed run.
    const internal = await eventSourceStore.ensureInternalSource({ tenant_id: TENANT });
    expect(
      (await eventStore.listEvents({ tenant_id: TENANT, limit: 10, page_token: undefined, source_id: internal.id }))
        .data,
    ).toHaveLength(0);
  });

  test('an armed run paused on approval waits, then completes once the human resolves it', async () => {
    const { automationStore, eventStore, eventSourceStore, run } = await setup('armed');
    const paused = clientWithTurns([
      turn({
        status: 'done',
        completedAt: 'x',
        output: null,
        requiredActions: [{ type: 'tool.approval_required', id: 'act_1' }],
      }),
    ]);
    expect(
      await finalizeRuns({
        automationStore,
        eventStore,
        eventSourceStore,
        client: paused,
        logger: fakeLogger(),
        now: NOW,
      }),
    ).toEqual({
      completed: 0,
      shadowed: 0,
      waiting: 1,
      failed: 0,
    });
    expect((await automationStore.getRun({ tenant_id: TENANT, id: run.id }))?.status).toBe('waiting');

    const resumed = clientWithTurns([
      turn(
        {
          status: 'done',
          completedAt: 'x',
          output: null,
          requiredActions: [{ type: 'tool.approval_required', id: 'act_1' }],
        },
        'turn_1',
        '2026-09-05T10:05:00.000Z',
      ),
      turn(
        { status: 'done', completedAt: 'y', output: { type: 'model.message', content: 'done' }, requiredActions: [] },
        'turn_2',
        '2026-09-05T10:20:00.000Z',
      ),
    ]);
    expect(
      await finalizeRuns({
        automationStore,
        eventStore,
        eventSourceStore,
        client: resumed,
        logger: fakeLogger(),
        now: NOW,
      }),
    ).toEqual({
      completed: 1,
      shadowed: 0,
      waiting: 0,
      failed: 0,
    });
    expect((await automationStore.getRun({ tenant_id: TENANT, id: run.id }))?.status).toBe('completed');
  });

  test('error and cancelled turns fail the run; running turns are left alone', async () => {
    const { automationStore, eventStore, eventSourceStore, run } = await setup('armed');
    const running = clientWithTurns([turn({ status: 'running' })]);
    expect(
      await finalizeRuns({
        automationStore,
        eventStore,
        eventSourceStore,
        client: running,
        logger: fakeLogger(),
        now: NOW,
      }),
    ).toEqual({
      completed: 0,
      shadowed: 0,
      waiting: 0,
      failed: 0,
    });
    expect((await automationStore.getRun({ tenant_id: TENANT, id: run.id }))?.status).toBe('triggered');

    const errored = clientWithTurns([turn({ status: 'error', message: 'boom', completedAt: 'x' })]);
    expect(
      await finalizeRuns({
        automationStore,
        eventStore,
        eventSourceStore,
        client: errored,
        logger: fakeLogger(),
        now: NOW,
      }),
    ).toEqual({
      completed: 0,
      shadowed: 0,
      waiting: 0,
      failed: 1,
    });
    const stored = await automationStore.getRun({ tenant_id: TENANT, id: run.id });
    expect(stored?.status).toBe('failed');
    expect(JSON.stringify(stored?.outcome)).toContain('boom');
  });
});
