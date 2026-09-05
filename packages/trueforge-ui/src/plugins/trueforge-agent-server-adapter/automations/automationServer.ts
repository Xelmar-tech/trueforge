/**
 * Harness AutomationServer adapter — maps the SDK's automation, event and event-source
 * wire shapes (nested manifests, Date instants) to the flat UI DTOs.
 */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type {
  Automation,
  AutomationCondition,
  AutomationLanePart,
  AutomationRun,
  AutomationServer,
  EventSource,
  LedgerEvent,
  LedgerEventDetail,
  ListAutomationsParams,
  ListLedgerEventsParams,
  ListResult,
  SaveAutomationRequest,
  UpdateAutomationRequest,
} from '../../../server/types.js';
import { toListResult } from '../chatServer.js';

/** Matches API PAGE_LIMIT for automations and events. */
const PAGE_LIMIT = 25;

type AgentIndex = {
  idToName: ReadonlyMap<string, string>;
  nameToId: ReadonlyMap<string, string>;
};

async function loadAgentIndex(client: TrueForge): Promise<AgentIndex> {
  const { data } = await client.agents.list();
  const idToName = new Map<string, string>();
  const nameToId = new Map<string, string>();
  for (const agent of data) {
    idToName.set(agent.id, agent.name);
    nameToId.set(agent.name, agent.id);
  }
  return { idToName, nameToId };
}

function resolveAgentName(agentId: string, index: AgentIndex): string {
  const byId = index.idToName.get(agentId);
  if (byId != null) return byId;
  if (index.nameToId.has(agentId)) return agentId;
  throw new Error(`Unknown agent: ${agentId}`);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIso(value: Date | string | null | undefined): string | null {
  return value == null ? null : toIso(value);
}

function toUiCondition(wire: TrueForgeApi.Condition): AutomationCondition {
  return wire.value === undefined
    ? { field: wire.field, op: wire.op }
    : { field: wire.field, op: wire.op, value: wire.value };
}

function toUiLanePart(wire: TrueForgeApi.LanePart): AutomationLanePart {
  return wire.type === 'field' ? { type: 'field', path: wire.path } : { type: 'literal', value: wire.value };
}

export function toUiAutomation(wire: TrueForgeApi.Automation, index: AgentIndex): Automation {
  const manifest = wire.manifest;
  return {
    id: wire.id,
    name: wire.name,
    agentId: index.nameToId.get(wire.agentName) ?? wire.agentName,
    agentName: wire.agentName,
    trigger: {
      sourceId: manifest.trigger.sourceId,
      kind: manifest.trigger.kind,
      conditions: (manifest.trigger.when?.all ?? []).map(toUiCondition),
    },
    coalesceSeconds: manifest.coalesceSeconds ?? 30,
    lane: (manifest.lane ?? []).map(toUiLanePart),
    task: manifest.task,
    emit: manifest.emit ?? [],
    mode: manifest.mode ?? 'shadow',
    status: manifest.status ?? 'active',
    createdAt: toIso(wire.createdAt),
    updatedAt: toIso(wire.updatedAt),
  };
}

export function toWireManifest(input: Omit<SaveAutomationRequest, 'agentId'>): TrueForgeApi.AutomationManifest {
  return {
    trigger: {
      type: 'event',
      sourceId: input.trigger.sourceId,
      kind: input.trigger.kind,
      when: { all: input.trigger.conditions.map(toWireCondition) },
    },
    coalesceSeconds: input.coalesceSeconds,
    lane: input.lane.map(part =>
      part.type === 'field' ? { type: 'field', path: part.path } : { type: 'literal', value: part.value },
    ),
    task: input.task,
    emit: input.emit,
    mode: input.mode,
    status: input.status,
  };
}

function toWireCondition(condition: AutomationCondition): TrueForgeApi.Condition {
  return condition.value === undefined
    ? { field: condition.field, op: condition.op }
    : { field: condition.field, op: condition.op, value: condition.value };
}

export function toUiAutomationRun(wire: TrueForgeApi.AutomationRun): AutomationRun {
  return {
    id: wire.id,
    automationId: wire.automationId,
    subjectKey: wire.subjectKey,
    laneKey: wire.laneKey,
    status: wire.status,
    mode: wire.mode,
    eventIds: wire.eventIds,
    sessionId: wire.sessionId,
    scheduledFor: toIso(wire.scheduledFor),
    triggeredAt: toNullableIso(wire.triggeredAt),
    finishedAt: toNullableIso(wire.finishedAt),
    outcome: wire.outcome,
  };
}

export function toUiEvent(wire: TrueForgeApi.Event): LedgerEvent {
  return {
    id: wire.id,
    sourceId: wire.sourceId,
    sourceKind: wire.sourceKind,
    kind: wire.kind,
    subjectKey: wire.subjectKey,
    deliveryId: wire.deliveryId,
    summary: wire.summary,
    receivedAt: toIso(wire.receivedAt),
    routedAt: toNullableIso(wire.routedAt),
  };
}

export function toUiEventSource(wire: TrueForgeApi.EventSource): EventSource {
  const manifest = wire.manifest;
  const app = manifest.kind === 'github' && manifest.app != null ? manifest.app : null;
  return {
    id: wire.id,
    kind: wire.kind,
    name: wire.name,
    status: wire.status,
    webhookUrl: wire.webhookUrl,
    app: app === null ? null : { appId: app.appId, appSlug: app.appSlug, htmlUrl: app.htmlUrl, owner: app.owner },
    lastDeliveryAt: toNullableIso(wire.lastDeliveryAt),
    createdAt: toIso(wire.createdAt),
  };
}

export function createAutomationServer(options: { client: TrueForge }): AutomationServer {
  const { client } = options;

  return {
    async listAutomations(req?: ListAutomationsParams): Promise<ListResult<Automation>> {
      const index = await loadAgentIndex(client);
      const limit = Math.min(Math.max(req?.limit ?? PAGE_LIMIT, 1), PAGE_LIMIT);
      const page = await client.automations.list({
        limit,
        ...(req?.pageToken === undefined || req.pageToken === '' ? {} : { pageToken: req.pageToken }),
        ...(req?.agentId === undefined ? {} : { agentNames: resolveAgentName(req.agentId, index) }),
      });
      return toListResult(page, row => toUiAutomation(row, index));
    },

    async getAutomation({ id }): Promise<Automation> {
      const [index, { data }] = await Promise.all([loadAgentIndex(client), client.automations.get(id)]);
      return toUiAutomation(data, index);
    },

    async createAutomation(req: SaveAutomationRequest): Promise<Automation> {
      const index = await loadAgentIndex(client);
      const { data } = await client.automations.create({
        agentName: resolveAgentName(req.agentId, index),
        name: req.name,
        manifest: toWireManifest(req),
      });
      return toUiAutomation(data, index);
    },

    async updateAutomation(req: UpdateAutomationRequest): Promise<Automation> {
      const index = await loadAgentIndex(client);
      const { id, ...rest } = req;
      const { data } = await client.automations.update(id, { name: rest.name, manifest: toWireManifest(rest) });
      return toUiAutomation(data, index);
    },

    async deleteAutomation({ id }): Promise<void> {
      await client.automations.delete(id);
    },

    async listAutomationRuns({ automationId }): Promise<AutomationRun[]> {
      const { data } = await client.automations.listRuns(automationId);
      return data.map(toUiAutomationRun);
    },

    async replayAutomation({ automationId, eventId }): Promise<AutomationRun> {
      const { data } = await client.automations.replay(automationId, { eventId });
      return toUiAutomationRun(data);
    },

    async listEvents(req?: ListLedgerEventsParams): Promise<ListResult<LedgerEvent>> {
      const limit = Math.min(Math.max(req?.limit ?? PAGE_LIMIT, 1), PAGE_LIMIT);
      const page = await client.events.list({
        limit,
        ...(req?.pageToken === undefined || req.pageToken === '' ? {} : { pageToken: req.pageToken }),
        ...(req?.sourceId === undefined ? {} : { sourceId: req.sourceId }),
        ...(req?.kind === undefined ? {} : { kind: req.kind }),
        ...(req?.subjectKey === undefined ? {} : { subjectKey: req.subjectKey }),
        ...(req?.since === undefined ? {} : { since: new Date(req.since) }),
      });
      return toListResult(page, toUiEvent);
    },

    async getEvent({ id }): Promise<LedgerEventDetail> {
      const { data } = await client.events.get(id);
      return { ...toUiEvent(data), payload: data.payload };
    },

    async listEventSources(): Promise<EventSource[]> {
      const { data } = await client.eventSources.list();
      return data.map(toUiEventSource);
    },

    async startGithubManifest({ name, owner }) {
      const { data } = await client.eventSources.createGithubManifest({
        name,
        ...(owner === undefined ? {} : { owner }),
      });
      return { sourceId: data.sourceId, state: data.state, actionUrl: data.actionUrl, manifest: data.manifest };
    },

    async deleteEventSource({ id }): Promise<void> {
      await client.eventSources.delete(id);
    },
  };
}
