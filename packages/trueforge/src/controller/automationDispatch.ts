import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { Logger } from 'winston';
import type { AutomationRecord, AutomationRunRecord, IAutomationStore } from '../db/automationStore';
import type { EventWithPayloadRecord, IEventStore } from '../db/eventStore';
import type { ControlLoop } from './Controller';

/** Due runs examined per pass. */
export const DISPATCH_BATCH_LIMIT = 20;

/** Gap between passes; an idle pass is one probe of `automation_run_due_idx`. */
const AUTOMATION_DISPATCH_INTERVAL_MS = 5_000;

const AUTOMATION_DISPATCH_LOOP_NAME = 'automation-dispatch';

/** Session metadata values are capped at 128 characters. */
const METADATA_VALUE_MAX = 128;

type AutomationRunApiClient = Pick<TrueForge, 'sessions' | 'internal' | 'agents'>;

export interface AutomationHandoff {
  run: AutomationRunRecord;
  automation: AutomationRecord;
  /** The coalesced events, oldest first; missing ledger rows are dropped. */
  events: EventWithPayloadRecord[];
}

function truncate(value: string): string {
  return value.length <= METADATA_VALUE_MAX ? value : value.slice(0, METADATA_VALUE_MAX);
}

/**
 * The first user message: the automation's task, then every coalesced event as JSON.
 * The agent gets the whole burst, not just the delivery that closed the window.
 */
export function buildRunTask(
  automation: AutomationRecord,
  run: AutomationRunRecord,
  events: EventWithPayloadRecord[],
): string {
  const payload = {
    automation: { id: automation.id, name: automation.name, mode: run.mode },
    run: { id: run.id, subject_key: run.subject_key, lane_key: run.lane_key },
    events: events.map(event => ({
      id: event.id,
      kind: event.kind,
      subject_key: event.subject_key,
      received_at: event.received_at,
      summary: event.summary,
      payload: event.payload,
    })),
  };
  return `${automation.manifest.task}\n\n<events>\n${JSON.stringify(payload, null, 2)}\n</events>`;
}

/**
 * Metadata stamped on the run's session so the UI can show the automation strip and the
 * finalize loop can find its way back.
 */
export function runSessionMetadata(run: AutomationRunRecord, automation: AutomationRecord): Record<string, string> {
  return {
    automation_id: automation.id,
    automation_name: truncate(automation.name),
    automation_run_id: run.id,
    automation_mode: run.mode,
    subject_key: truncate(run.subject_key),
    event_id: run.event_ids[0] ?? '',
  };
}

/**
 * Shadow mode is an approval policy, not a runtime feature: every MCP tool pauses for
 * approval, so the agent stops at its first tool call and the pending action is the
 * "would have done" record. Runs with no MCP servers cannot write anything anyway.
 */
export function shadowAgentSpec(spec: TrueForgeApi.AgentSpec): TrueForgeApi.AgentSpec {
  return {
    ...spec,
    mcpServers: (spec.mcpServers ?? []).map(server => ({ ...server, requireApprovalForTools: ['@all'] })),
  };
}

/**
 * Hands a due run to the API:
 * 1. Get or create a session keyed by `run.id` (shadow runs get an inline spec).
 * 2. Stamp automation metadata on it.
 * 3. Create a non-streaming turn only when the session has no turns.
 *
 * Idempotent on retry.
 */
/** Agents are addressed by immutable id on the API; automations name them. */
async function agentSpecByName(client: AutomationRunApiClient, name: string): Promise<TrueForgeApi.AgentSpec> {
  const { data: agents } = await client.agents.list();
  const match = agents.find(agent => agent.name === name);
  if (match === undefined) {
    throw new Error(`Agent not found: ${name}`);
  }
  return match.manifest;
}

export function executeAutomationRun(client: AutomationRunApiClient): (handoff: AutomationHandoff) => Promise<string> {
  return async ({ run, automation, events }) => {
    const agent: TrueForgeApi.CreateSessionAgent =
      run.mode === 'shadow'
        ? { spec: shadowAgentSpec(await agentSpecByName(client, automation.agent_name)) }
        : { name: automation.agent_name };

    const { data: session } = await client.internal.sessions.getOrCreateByExternalId({
      externalId: run.id,
      agent,
    });
    await client.sessions.update(session.id, { metadata: runSessionMetadata(run, automation) });

    const turns = await client.sessions.listTurns(session.id, { limit: 1 });
    if (turns.data.length === 0) {
      await client.sessions.createTurn(session.id, {
        input: [{ type: 'user.message', content: buildRunTask(automation, run, events) }],
        previousTurnId: 'none',
      });
    }
    return session.id;
  };
}

/**
 * Dispatch: turn due `coalescing` runs into `triggered` runs.
 *
 * A run whose lane is busy is skipped and stays due; the next pass retries it once the
 * lane frees up. A deleted automation fails its runs. A hand-off error fails the run
 * with the message as outcome.
 *
 * NOT concurrency safe by design: call this from exactly ONE process.
 */
export async function dispatchAutomationRuns<TTransaction>(params: {
  automationStore: IAutomationStore<TTransaction>;
  eventStore: IEventStore<TTransaction>;
  onTriggered: (handoff: AutomationHandoff) => Promise<string>;
  logger: Logger;
  now?: Date;
  signal?: AbortSignal;
}): Promise<{ dispatched: number; skipped: number; failed: number }> {
  const { automationStore, eventStore, onTriggered, logger, signal } = params;
  const now = params.now ?? new Date();
  const due = await automationStore.listDueRuns({ until: now, limit: DISPATCH_BATCH_LIMIT });

  let dispatched = 0;
  let skipped = 0;
  let failed = 0;
  for (const run of due) {
    if (signal?.aborted) {
      break;
    }
    try {
      const automation = await automationStore.getAutomation({ tenant_id: run.tenant_id, id: run.automation_id });
      if (automation === undefined) {
        await automationStore.finishRun({
          tenant_id: run.tenant_id,
          id: run.id,
          status: 'failed',
          outcome: { error: 'automation deleted before the run started' },
          at: now,
        });
        failed += 1;
        continue;
      }
      if (
        run.lane_key !== null &&
        (await automationStore.isLaneBusy({ tenant_id: run.tenant_id, lane_key: run.lane_key }))
      ) {
        skipped += 1;
        continue;
      }

      const events: EventWithPayloadRecord[] = [];
      for (const eventId of run.event_ids) {
        const event = await eventStore.getEvent({ tenant_id: run.tenant_id, id: eventId });
        if (event !== undefined) {
          events.push(event);
        }
      }

      let sessionId: string;
      try {
        sessionId = await onTriggered({ run, automation, events });
      } catch (error) {
        logger.error('Failed to hand off automation run', { automation_id: automation.id, run_id: run.id, error });
        await automationStore.finishRun({
          tenant_id: run.tenant_id,
          id: run.id,
          status: 'failed',
          outcome: { error: error instanceof Error ? error.message : String(error) },
          at: now,
        });
        failed += 1;
        continue;
      }

      await automationStore.markTriggered({ tenant_id: run.tenant_id, id: run.id, session_id: sessionId, at: now });
      dispatched += 1;
    } catch (error) {
      logger.error('Failed to process automation run', { automation_id: run.automation_id, run_id: run.id, error });
    }
  }
  return { dispatched, skipped, failed };
}

export function automationDispatchLoop<TTransaction>(params: {
  automationStore: IAutomationStore<TTransaction>;
  eventStore: IEventStore<TTransaction>;
  client: AutomationRunApiClient;
  logger: Logger;
}): ControlLoop {
  const { automationStore, eventStore, client, logger } = params;
  return {
    name: AUTOMATION_DISPATCH_LOOP_NAME,
    intervalMs: AUTOMATION_DISPATCH_INTERVAL_MS,
    async tick(signal: AbortSignal): Promise<void> {
      const result = await dispatchAutomationRuns({
        automationStore,
        eventStore,
        onTriggered: executeAutomationRun(client),
        logger,
        signal,
      });
      if (result.dispatched > 0 || result.failed > 0) {
        logger.debug('Automation runs dispatched or failed', result);
      }
    },
  };
}
