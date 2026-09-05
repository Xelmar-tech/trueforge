import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { Logger } from 'winston';
import type { JsonObject } from '../connectors/types';
import type { AutomationRecord, AutomationRunRecord, IAutomationStore } from '../db/automationStore';
import type { IEventSourceStore } from '../db/eventSourceStore';
import type { IEventStore } from '../db/eventStore';
import type { EventSummary } from '../schemas/event';
import type { ControlLoop } from './Controller';

/** Open runs examined per pass. */
export const FINALIZE_BATCH_LIMIT = 50;

/** Turns fetched per session when looking for the latest one; automation sessions are short. */
// The turns API caps `limit` at 25; a run session holds one turn, two on retry.
const TURN_SCAN_LIMIT = 25;

/** Gap between passes; a turn takes minutes, so polling every 15s is plenty. */
const RUN_FINALIZE_INTERVAL_MS = 15_000;

const RUN_FINALIZE_LOOP_NAME = 'run-finalize';

type FinalizeApiClient = Pick<TrueForge, 'sessions'>;

const EMPTY_SUMMARY: EventSummary = { repository: null, number: null, title: null, actor: null, label: null };

/** Newest turn by creation time; undefined when the session has none yet. */
export function latestTurn(turns: readonly TrueForgeApi.Turn[]): TrueForgeApi.Turn | undefined {
  let latest: TrueForgeApi.Turn | undefined;
  for (const turn of turns) {
    if (latest === undefined || turn.createdAt > latest.createdAt) {
      latest = turn;
    }
  }
  return latest;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Round-trips SDK objects through JSON so the outcome column holds plain data. */
function toJson(value: unknown): JsonObject {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return isJsonObject(parsed) ? parsed : {};
}

function toJsonArray(value: unknown): unknown[] {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Writes the automation's `emit` kinds into the tenant's internal source, one event per
 * kind, so downstream automations can trigger on completion. Delivery ids are derived
 * from the run, so a repeated finalize pass cannot double-emit.
 */
export async function emitCompletionEvents<TTransaction>(params: {
  run: AutomationRunRecord;
  automation: AutomationRecord;
  eventStore: IEventStore<TTransaction>;
  eventSourceStore: IEventSourceStore<TTransaction>;
  outputText: string | null;
  now: Date;
}): Promise<string[]> {
  const { run, automation, eventStore, eventSourceStore, outputText, now } = params;
  if (automation.manifest.emit.length === 0) {
    return [];
  }
  const internal = await eventSourceStore.ensureInternalSource({ tenant_id: run.tenant_id });
  const first = run.event_ids[0];
  const sourceEvent =
    first === undefined ? undefined : await eventStore.getEvent({ tenant_id: run.tenant_id, id: first });
  const summary: EventSummary = sourceEvent?.summary ?? EMPTY_SUMMARY;

  const ids: string[] = [];
  for (const kind of automation.manifest.emit) {
    const { event } = await eventStore.insertEvent({
      tenant_id: run.tenant_id,
      source_id: internal.id,
      source_kind: 'trueforge',
      received_at: now,
      event: {
        kind,
        subject_key: run.subject_key,
        delivery_id: `${run.id}:${kind}`,
        summary,
        payload: {
          automation_id: automation.id,
          automation_name: automation.name,
          automation_run_id: run.id,
          session_id: run.session_id,
          subject_key: run.subject_key,
          source_event_ids: run.event_ids,
          source_summary: summary,
          output: outputText,
        },
      },
    });
    ids.push(event.id);
  }
  return ids;
}

function outputText(state: TrueForgeApi.TurnStateDone): string | null {
  const content: unknown = state.output?.content;
  return typeof content === 'string' ? content : null;
}

/**
 * Finalize: watch `triggered` and `waiting` runs and record how their session ended.
 *
 * - turn `done` with no required actions → `completed`, emits configured events
 * - turn `done` paused on required actions → shadow run: `shadowed` (the pause is the
 *   "would have done"); armed run: `waiting` for a human, re-checked every pass
 * - turn `error` / `cancelled` → `failed`
 * - turn `running` or session without turns yet → left alone
 *
 * NOT concurrency safe by design: call this from exactly ONE process.
 */
export async function finalizeRuns<TTransaction>(params: {
  automationStore: IAutomationStore<TTransaction>;
  eventStore: IEventStore<TTransaction>;
  eventSourceStore: IEventSourceStore<TTransaction>;
  client: FinalizeApiClient;
  logger: Logger;
  now?: Date;
  signal?: AbortSignal;
}): Promise<{ completed: number; shadowed: number; waiting: number; failed: number }> {
  const { automationStore, eventStore, eventSourceStore, client, logger, signal } = params;
  const now = params.now ?? new Date();
  const open = await automationStore.listOpenRuns({ limit: FINALIZE_BATCH_LIMIT });
  const counts = { completed: 0, shadowed: 0, waiting: 0, failed: 0 };

  for (const run of open) {
    if (signal?.aborted) {
      break;
    }
    try {
      if (run.session_id === null) {
        await automationStore.finishRun({
          tenant_id: run.tenant_id,
          id: run.id,
          status: 'failed',
          outcome: { error: 'run was triggered without a session' },
          at: now,
        });
        counts.failed += 1;
        continue;
      }
      const turns = await client.sessions.listTurns(run.session_id, { limit: TURN_SCAN_LIMIT });
      const turn = latestTurn(turns.data);
      if (turn === undefined) {
        continue;
      }
      const state = turn.state;
      switch (state.status) {
        case 'running':
          continue;
        case 'error':
        case 'cancelled': {
          await automationStore.finishRun({
            tenant_id: run.tenant_id,
            id: run.id,
            status: 'failed',
            outcome: { turn_id: turn.id, turn_state: toJson(state) },
            at: now,
          });
          counts.failed += 1;
          continue;
        }
        case 'done': {
          if (state.requiredActions.length > 0) {
            if (run.mode === 'shadow') {
              await automationStore.finishRun({
                tenant_id: run.tenant_id,
                id: run.id,
                status: 'shadowed',
                outcome: { turn_id: turn.id, required_actions: toJsonArray(state.requiredActions) },
                at: now,
              });
              counts.shadowed += 1;
            } else if (run.status !== 'waiting') {
              await automationStore.finishRun({
                tenant_id: run.tenant_id,
                id: run.id,
                status: 'waiting',
                outcome: { turn_id: turn.id, required_actions: toJsonArray(state.requiredActions) },
                at: now,
              });
              counts.waiting += 1;
            }
            continue;
          }
          const automation = await automationStore.getAutomation({ tenant_id: run.tenant_id, id: run.automation_id });
          const emitted =
            automation === undefined
              ? []
              : await emitCompletionEvents({
                  run,
                  automation,
                  eventStore,
                  eventSourceStore,
                  outputText: outputText(state),
                  now,
                });
          await automationStore.finishRun({
            tenant_id: run.tenant_id,
            id: run.id,
            status: 'completed',
            outcome: { turn_id: turn.id, emitted_event_ids: emitted },
            at: now,
          });
          counts.completed += 1;
          continue;
        }
      }
    } catch (error) {
      logger.error('Failed to finalize automation run', { run_id: run.id, session_id: run.session_id, error });
    }
  }
  return counts;
}

export function runFinalizeLoop<TTransaction>(params: {
  automationStore: IAutomationStore<TTransaction>;
  eventStore: IEventStore<TTransaction>;
  eventSourceStore: IEventSourceStore<TTransaction>;
  client: FinalizeApiClient;
  logger: Logger;
}): ControlLoop {
  const { automationStore, eventStore, eventSourceStore, client, logger } = params;
  return {
    name: RUN_FINALIZE_LOOP_NAME,
    intervalMs: RUN_FINALIZE_INTERVAL_MS,
    async tick(signal: AbortSignal): Promise<void> {
      const result = await finalizeRuns({ automationStore, eventStore, eventSourceStore, client, logger, signal });
      if (result.completed + result.shadowed + result.waiting + result.failed > 0) {
        logger.debug('Automation runs finalized', result);
      }
    },
  };
}
