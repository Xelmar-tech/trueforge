import type { Logger } from 'winston';
import type { AutomationRecord, IAutomationStore } from '../db/automationStore';
import type { EventWithPayloadRecord, IEventStore } from '../db/eventStore';
import { matchesWhen, renderLaneKey } from '../runtime/conditions';
import type { ControlLoop } from './Controller';

/** Unrouted events examined per pass; the rest wait for the next tick. */
export const COALESCE_BATCH_LIMIT = 200;

/**
 * Gap between passes. Short, because this is the latency between a webhook landing and
 * its coalesce window opening; an idle pass is one probe of `event_unrouted_idx`.
 */
const EVENT_COALESCE_INTERVAL_MS = 5_000;

const EVENT_COALESCE_LOOP_NAME = 'event-coalesce';

/** True when the automation's trigger names this event and every condition holds. */
export function automationMatchesEvent(automation: AutomationRecord, event: EventWithPayloadRecord): boolean {
  // Only event triggers exist today; a cron arm would return false here.
  const { trigger } = automation.manifest;
  return (
    trigger.source_id === event.source_id && trigger.kind === event.kind && matchesWhen(trigger.when, event.payload)
  );
}

/**
 * Routes unrouted events into coalesce windows: every active automation whose trigger
 * matches gets one `upsertCoalescingRun` per event, which either opens a window for the
 * event's subject or appends to the open one and slides its close time.
 *
 * Each event is marked routed as soon as its matches are recorded, so a crash mid-pass
 * re-examines at most the event in flight. An event that matches nothing is still marked
 * routed — the ledger keeps it, the loop never revisits it.
 *
 * NOT concurrency safe by design: call this from exactly ONE process.
 */
export async function coalesceEvents<TTransaction>(params: {
  eventStore: IEventStore<TTransaction>;
  automationStore: IAutomationStore<TTransaction>;
  logger: Logger;
  /** One clock for the pass: anchors every window it opens or slides. */
  now?: Date;
  signal?: AbortSignal;
}): Promise<{ routed: number; matched: number }> {
  const { eventStore, automationStore, logger, signal } = params;
  const now = params.now ?? new Date();
  const events = await eventStore.listUnrouted({ limit: COALESCE_BATCH_LIMIT });

  const activeByTenant = new Map<string, AutomationRecord[]>();
  async function activeAutomations(tenantId: string): Promise<AutomationRecord[]> {
    const cached = activeByTenant.get(tenantId);
    if (cached !== undefined) {
      return cached;
    }
    const loaded = await automationStore.listActiveAutomations({ tenant_id: tenantId });
    activeByTenant.set(tenantId, loaded);
    return loaded;
  }

  let routed = 0;
  let matched = 0;
  for (const event of events) {
    if (signal?.aborted) {
      break;
    }
    try {
      const candidates = await activeAutomations(event.tenant_id);
      for (const automation of candidates) {
        if (!automationMatchesEvent(automation, event)) {
          continue;
        }
        const { manifest } = automation;
        await automationStore.upsertCoalescingRun({
          tenant_id: automation.tenant_id,
          automation_id: automation.id,
          subject_key: event.subject_key,
          lane_key: renderLaneKey(manifest.lane, event.payload),
          mode: manifest.mode,
          event_id: event.id,
          scheduled_for: new Date(now.getTime() + manifest.coalesce_seconds * 1000),
          created_by_subject: automation.created_by_subject,
        });
        matched += 1;
      }
      await eventStore.markRouted({ ids: [event.id], at: now });
      routed += 1;
    } catch (error) {
      logger.error('Failed to route event', { event_id: event.id, kind: event.kind, error });
    }
  }
  return { routed, matched };
}

export function eventCoalesceLoop<TTransaction>(params: {
  eventStore: IEventStore<TTransaction>;
  automationStore: IAutomationStore<TTransaction>;
  logger: Logger;
}): ControlLoop {
  const { eventStore, automationStore, logger } = params;
  return {
    name: EVENT_COALESCE_LOOP_NAME,
    intervalMs: EVENT_COALESCE_INTERVAL_MS,
    async tick(signal: AbortSignal): Promise<void> {
      const result = await coalesceEvents({ eventStore, automationStore, logger, signal });
      if (result.routed > 0) {
        logger.debug('Events routed into coalesce windows', result);
      }
    },
  };
}
